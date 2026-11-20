// The relay: Riff reaches Hermes through this Worker, with no tunnel and no open port.
//
// The riff-connect-hermes plugin, inside the Hermes gateway on the user's computer,
// opens one WebSocket to this Worker and keeps it open. A request Riff sends to
// /hermes/<path> goes down that socket as a frame; the plugin makes the same request
// to Hermes on its own computer (127.0.0.1) and sends the answer back in pieces,
// so a stream of words arrives as it is written.
//
// Frames (JSON text):
//   Worker → plugin   { t: 'req', id, method, path, headers, body }   { t: 'cancel', id }
//   plugin → Worker   { t: 'head', id, status, headers }   { t: 'data', id, chunk }   { t: 'end', id }
//                     { t: 'error', id, message }   { t: 'hello', v, … }   { t: 'step', … }
//
// No Cloudflare imports: the tests run it under plain Node with a stand-in socket.

const MAX_BODY = 2 * 1024 * 1024;
const HEAD_MS = 60000; // how long Riff waits for Hermes to start answering
const PASS_REQ = ['content-type', 'accept', 'idempotency-key', 'last-event-id'];
const PASS_RES = ['content-type', 'cache-control'];
// The only parts of the Hermes API Riff may reach through the relay.
export const ALLOWED = [/^\/v1\//, /^\/api\/sessions(\/|$|\?)/, /^\/health$/];

const json = (status, error, extra = {}) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });

// socket(): the plugin's open socket, or null.  onFrame(frame): frames the relay doesn't handle itself (hello, step).
export function createRelay({ socket, onFrame = () => {} } = {}) {
  const pending = new Map(); // id → { resolveHead, writer, enc, headed }
  let n = 0;
  const newId = () => `q${Date.now().toString(36)}${(++n).toString(36)}`;
  const send = (ws, frame) => {
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  };

  function cancel(id, tell = true) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (tell) {
      const ws = socket();
      if (ws) send(ws, { t: 'cancel', id });
    }
    if (!p.headed) p.resolveHead({ status: 499 });
    p.writer.abort?.('cancelled').catch?.(() => {});
  }

  // Riff's request to /hermes/<path>. cors: headers to add for an extension page.
  async function forward(request, path, cors = {}) {
    if (!ALLOWED.some((re) => re.test(path))) return json(403, 'Riff can only reach the agent’s run and session API through this connector.', cors);
    const ws = socket();
    if (!ws) return json(503, 'Hermes isn’t connected to this Worker. On the Hermes computer: is the riff-connect-hermes plugin enabled, and is the Hermes gateway running?', cors);
    const method = request.method;
    let body = null;
    if (!['GET', 'HEAD'].includes(method)) {
      body = await request.text();
      if (body.length > MAX_BODY) return json(413, 'That request is too big for the connector (2 MB at most).', cors);
    }
    const headers = {};
    for (const k of PASS_REQ) {
      const v = request.headers.get(k);
      if (v) headers[k] = v;
    }
    const id = newId();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    let resolveHead;
    const head = new Promise((r) => (resolveHead = r));
    pending.set(id, { resolveHead, writer, enc: new TextEncoder(), headed: false });
    if (!send(ws, { t: 'req', id, method, path, headers, body })) {
      pending.delete(id);
      return json(503, 'Hermes’s connection to this Worker just dropped. Try again in a moment.', cors);
    }
    request.signal?.addEventListener?.('abort', () => cancel(id));
    const timer = setTimeout(() => {
      const p = pending.get(id);
      if (p && !p.headed) {
        p.resolveHead({ status: 504 });
        cancel(id);
      }
    }, HEAD_MS);
    const h = await head;
    clearTimeout(timer);
    if (h.status === 504) return json(504, 'Hermes didn’t start answering within a minute.', cors);
    if (h.status === 499) return json(499, 'Cancelled.', cors);
    if (h.error) return json(502, h.error, cors);
    const out = { ...cors };
    for (const k of PASS_RES) if (h.headers?.[k]) out[k] = String(h.headers[k]);
    return new Response(readable, { status: h.status, headers: out });
  }

  // A frame from the plugin.
  function onMessage(raw) {
    let f;
    try {
      f = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!f || typeof f !== 'object') return;
    const p = f.id != null ? pending.get(f.id) : null;
    if (f.t === 'head' && p && !p.headed) {
      p.headed = true;
      const status = Number(f.status);
      p.resolveHead({ status: status >= 200 && status <= 599 ? status : 502, headers: f.headers || {} });
    } else if (f.t === 'data' && p) {
      p.writer.write(p.enc.encode(String(f.chunk ?? ''))).catch(() => cancel(f.id)); // Riff went away: tell the plugin to stop
    } else if (f.t === 'end' && p) {
      pending.delete(f.id);
      p.writer.close().catch(() => {});
    } else if (f.t === 'error' && p) {
      pending.delete(f.id);
      if (!p.headed) p.resolveHead({ error: `Hermes couldn’t be reached on its own computer: ${String(f.message || 'unknown error').slice(0, 300)}` });
      else p.writer.abort?.('error').catch?.(() => {});
    } else if (!['head', 'data', 'end', 'error'].includes(f.t)) onFrame(f);
  }

  // The plugin's socket closed: every request still waiting ends.
  function onClose() {
    for (const [id, p] of pending) {
      pending.delete(id);
      if (!p.headed) p.resolveHead({ error: 'Hermes’s connection to this Worker closed before it answered.' });
      else p.writer.abort?.('closed').catch?.(() => {});
    }
  }

  return { forward, onMessage, onClose, cancel, connected: () => !!socket(), pendingCount: () => pending.size };
}
