// riff-inbox: a small inbox between your agent and your Riff board.
//
// It runs on your own Cloudflare account. Your agent (Hermes) can leave card
// requests here at any time through the MCP door, even while Chrome is closed.
// Riff picks them up through the inbox door the next time Riff Home is open.
// A request only ever becomes a card in Ideas: it never runs by itself.
//
// Two keys, two doors:
//   Riff key    reads the inbox and says what became of each request
//   Hermes key  leaves requests and asks about its own requests; it cannot read your board
//
// 0.2 (riff-connect-hermes): a third door. The riff-connect-hermes plugin in the Hermes
// gateway pairs with the same pairing code (/pair/hermes), keeps a WebSocket open (/link),
// and Riff reaches Hermes's API through /hermes/<path> (relay.js). Tool steps the plugin
// sees arrive on the socket and are kept here for Riff (/steps).
//
// This file has no Cloudflare imports, so it runs under plain Node in the tests.
// `sql(query, ...params)` returns an array of rows.

import { RIFFS, PROTOCOL } from './riffs.js';
import { ALLOWED as RELAYED } from './relay.js';

export const VERSION = '0.3.0';
const CODE_MS = 15 * 60000; // a one-time Hermes code works once, for 15 minutes
const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const MAX_STEPS = 5000; // tool steps kept, newest first
const MAX_BODY = 16 * 1024;
const MAX_WAITING = 200; // requests no Riff has picked up yet
const KEEP_MS = 30 * 86400000;
const MAX_FAILS = 8;
const FAIL_WINDOW = 15 * 60000;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))));
const newKey = (prefix) => `${prefix}_${hex(crypto.getRandomValues(new Uint8Array(24)))}`;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// opts.relay: createRelay(…) from relay.js. opts.link(request): opens the plugin's WebSocket (the Durable Object does it).
export function createInbox(sql, env = {}, clock = Date.now, opts = {}) {
  sql(`CREATE TABLE IF NOT EXISTS keys (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, name TEXT, ext TEXT, cursor INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL)`);
  sql(`CREATE TABLE IF NOT EXISTS requests (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', reason TEXT, at INTEGER NOT NULL)`);
  sql(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
  sql(`CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, until INTEGER NOT NULL)`);
  sql(`CREATE TABLE IF NOT EXISTS steps (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, at INTEGER NOT NULL, body TEXT NOT NULL)`);

  const getMeta = (k) => {
    const row = sql(`SELECT v FROM meta WHERE k = ?`, k)[0];
    try {
      return row ? JSON.parse(row.v) : null;
    } catch {
      return null;
    }
  };
  const setMeta = (k, v) => sql(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, JSON.stringify(v));

  // Extensions call with their own origin; everything else (Hermes, curl) sends none.
  const cors = (request) => {
    const origin = request.headers.get('origin') || '';
    return /^(chrome|moz|safari-web)-extension:\/\//.test(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type, accept, idempotency-key, last-event-id', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', vary: 'origin' } : {};
  };
  const json = (request, data, status = 200, extra = {}) => new Response(data == null ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors(request), ...extra } });
  const fail = (request, status, error) => json(request, { error }, status);

  async function bodyOf(request) {
    const text = await request.text();
    if (text.length > MAX_BODY) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  async function keyOf(request, kind) {
    const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
    if (!m) return null;
    return sql(`SELECT id, kind, cursor FROM keys WHERE hash = ? AND kind = ?`, await sha(m[1]), kind)[0] || null;
  }

  const sweep = () => sql(`DELETE FROM requests WHERE at < ?`, clock() - KEEP_MS);

  // ---------------------------------------------------------------- pairing

  // 0.3: a one-time code for Hermes, so the pairing code never has to reach the Hermes computer.
  // Riff asks for it (Riff key); the plugin's riff_connect_pair spends it on /pair/hermes.
  const tidyCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  async function newHermesCode(request) {
    const now = clock();
    sql(`DELETE FROM codes WHERE until < ?`, now);
    if (sql(`SELECT COUNT(*) AS n FROM codes`)[0].n >= 20) sql(`DELETE FROM codes WHERE hash IN (SELECT hash FROM codes ORDER BY until LIMIT 10)`);
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const raw = [...bytes].map((b) => CODE_ABC[b % CODE_ABC.length]).join('');
    sql(`INSERT INTO codes (hash, until) VALUES (?, ?)`, await sha(raw), now + CODE_MS);
    return json(request, { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, until: now + CODE_MS });
  }
  async function spendHermesCode(code) {
    const t = tidyCode(code);
    if (t.length !== 8) return false;
    const h = await sha(t);
    const row = sql(`SELECT until FROM codes WHERE hash = ?`, h)[0];
    if (!row) return false;
    sql(`DELETE FROM codes WHERE hash = ?`, h);
    return row.until >= clock();
  }

  // The pairing code, checked with the lock-out. → { body } or { response } (the refusal).
  // 0.3: oneTime: a one-time Hermes code is accepted too (it counts toward the lock-out like any other try).
  async function checkCode(request, { oneTime = false } = {}) {
    const code = String(env.PAIRING_CODE || '');
    if (code.length < 12) return { response: fail(request, 503, 'This Worker has no pairing code yet. Set the PAIRING_CODE secret (12 characters or more), then try again.') };
    const now = clock();
    const fails = getMeta('fails') || { n: 0, since: 0 };
    if (fails.n >= MAX_FAILS && now - fails.since < FAIL_WINDOW) return { response: fail(request, 429, 'Too many wrong codes. Wait 15 minutes and try again.') };
    const b = await bodyOf(request);
    if (!isObj(b)) return { response: fail(request, 400, 'Send JSON with the pairing code.') };
    if ((await sha(b.code)) !== (await sha(code)) && !(oneTime && (await spendHermesCode(b.code)))) {
      setMeta('fails', now - fails.since < FAIL_WINDOW ? { n: fails.n + 1, since: fails.since } : { n: 1, since: now });
      return { response: fail(request, 403, 'That pairing code is not right.') };
    }
    setMeta('fails', { n: 0, since: 0 });
    return { body: b };
  }

  async function pair(request) {
    const c = await checkCode(request);
    if (c.response) return c.response;
    const b = c.body;
    const now = clock();
    // A newly paired Riff starts at the oldest request nobody has picked up yet.
    const oldest = sql(`SELECT MIN(seq) AS seq FROM requests WHERE status = 'queued'`)[0]?.seq;
    const last = sql(`SELECT MAX(seq) AS seq FROM requests`)[0]?.seq || 0;
    const riffKey = newKey('riff');
    sql(`INSERT INTO keys (kind, hash, name, ext, cursor, at) VALUES ('riff', ?, ?, ?, ?, ?)`, await sha(riffKey), str(b.name, 60), str(b.extensionId, 64), oldest ? oldest - 1 : last, now);
    const out = { protocol: PROTOCOL, riffKey };
    // The Hermes key is made once, on the first pairing. Riff can replace it later.
    if (!sql(`SELECT 1 AS x FROM keys WHERE kind = 'hermes'`).length) {
      out.hermesKey = newKey('hermes');
      sql(`INSERT INTO keys (kind, hash, at) VALUES ('hermes', ?, ?)`, await sha(out.hermesKey), now);
    }
    return json(request, out);
  }

  // 0.2: the plugin pairs itself with the same code and gets a new Hermes key. The old one
  // (for example in an MCP config) stops working: one Hermes per connector.
  async function pairHermes(request) {
    const c = await checkCode(request, { oneTime: true });
    if (c.response) return c.response;
    const hermesKey = newKey('hermes');
    sql(`DELETE FROM keys WHERE kind = 'hermes'`);
    sql(`INSERT INTO keys (kind, hash, name, at) VALUES ('hermes', ?, ?, ?)`, await sha(hermesKey), str(c.body.name, 60), clock());
    return json(request, { protocol: PROTOCOL, hermesKey });
  }

  // ---------------------------------------------------------------- the plugin's frames (hello, step)

  const one = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  function onFrame(f) {
    if (f.t === 'hello') setMeta('agent', { v: one(f.v, 20), hermes: one(f.hermes, 40), host: one(f.host, 60), at: clock() });
    else if (f.t === 'step') {
      const body = { state: ['run', 'done', 'fail'].includes(f.state) ? f.state : 'done', tool: one(f.tool, 80), preview: one(f.preview, 300), result: one(f.result, 300), ms: Number(f.ms) || 0, call: one(f.call, 80) };
      sql(`INSERT INTO steps (session, at, body) VALUES (?, ?, ?)`, one(f.session, 120) || null, clock(), JSON.stringify(body));
      sql(`DELETE FROM steps WHERE seq <= (SELECT MAX(seq) FROM steps) - ?`, MAX_STEPS);
    }
  }

  // Riff reads the steps the plugin saw, for one agent session or all, after a cursor.
  function readSteps(request) {
    const u = new URL(request.url);
    const after = Math.max(0, Number(u.searchParams.get('after')) || 0);
    const session = str(u.searchParams.get('session') || '', 120);
    const rows = session ? sql(`SELECT seq, session, at, body FROM steps WHERE seq > ? AND session = ? ORDER BY seq LIMIT 200`, after, session) : sql(`SELECT seq, session, at, body FROM steps WHERE seq > ? ORDER BY seq LIMIT 200`, after);
    return json(request, { steps: rows.map((r) => ({ seq: r.seq, session: r.session, at: r.at, ...JSON.parse(r.body) })), last: rows.at(-1)?.seq ?? after });
  }

  async function replaceHermesKey(request) {
    const hermesKey = newKey('hermes');
    sql(`DELETE FROM keys WHERE kind = 'hermes'`);
    sql(`INSERT INTO keys (kind, hash, at) VALUES ('hermes', ?, ?)`, await sha(hermesKey), clock());
    return json(request, { hermesKey });
  }

  // ---------------------------------------------------------------- the inbox door (Riff)

  function read(request, key) {
    sweep();
    const rows = sql(`SELECT seq, id, body, at FROM requests WHERE seq > ? ORDER BY seq LIMIT 50`, key.cursor);
    const requests = rows.map((r) => ({ seq: r.seq, id: r.id, at: r.at, ...JSON.parse(r.body) }));
    const more = sql(`SELECT COUNT(*) AS n FROM requests WHERE seq > ?`, key.cursor)[0].n - requests.length;
    return json(request, { protocol: PROTOCOL, requests, more });
  }

  // Riff says what became of each request it read. Reading again before this returns the same requests.
  async function ack(request, key) {
    const b = await bodyOf(request);
    const results = Array.isArray(b?.results) ? b.results.slice(0, 100) : null;
    if (!results) return fail(request, 400, 'Send { results: [{ id, result }] }.');
    let cursor = key.cursor;
    for (const r of results) {
      const row = sql(`SELECT seq, status FROM requests WHERE id = ?`, str(r?.id, 80))[0];
      if (!row || row.seq <= key.cursor) continue;
      cursor = Math.max(cursor, row.seq);
      if (r.result === 'accepted') sql(`UPDATE requests SET status = 'accepted', reason = NULL WHERE seq = ?`, row.seq);
      else if (row.status === 'queued') sql(`UPDATE requests SET status = 'rejected', reason = ? WHERE seq = ?`, str(r.reason, 200) || 'Riff did not accept it.', row.seq);
    }
    sql(`UPDATE keys SET cursor = ? WHERE id = ?`, cursor, key.id);
    return json(request, { ok: true, cursor });
  }

  // ---------------------------------------------------------------- the MCP door (Hermes)

  const TOOLS = [
    {
      name: 'riff_list_riffs',
      description: 'Lists the riffs (ready-made card types) that can be put on the user’s Riff board, with the fields each one takes. Call this before riff_request_card.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'riff_request_card',
      description:
        'Asks for a card on the user’s Riff board. The card appears in the Ideas lane the next time the user has Riff open. It does not run: the user decides whether to make it ready and run it. Use it when the user asks you to add, queue or plan a task for their Riff board.',
      inputSchema: {
        type: 'object',
        properties: {
          riff: { type: 'string', description: 'The riff id, from riff_list_riffs (for example "search-x").' },
          title: { type: 'string', description: 'A short name for the card. Optional.' },
          inputs: { type: 'object', description: 'The riff’s fields by id, as strings (for example { "topics": "on-device AI" }).' },
          goal: { type: 'integer', description: 'How many results the card should reach. Optional; the riff has a default.' },
          why: { type: 'string', description: 'One sentence for the user on why you are asking for this card. Optional.' },
        },
        required: ['riff'],
        additionalProperties: false,
      },
    },
    {
      name: 'riff_request_status',
      description: 'Says what became of a card request you made: still waiting for Riff to open, accepted onto the board (in Ideas), or rejected with the reason. You cannot see the rest of the board.',
      inputSchema: { type: 'object', properties: { request: { type: 'string', description: 'The request id that riff_request_card returned.' } }, required: ['request'], additionalProperties: false },
    },
  ];

  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

  function listRiffs() {
    return text(
      RIFFS.map((r) => {
        const fields = r.fields.map((f) => `    - ${f.id}${f.required ? ' (required)' : ''}: ${f.label}${f.options ? ` [${f.options.map((o) => o.value).join(' | ')}]` : ''}`).join('\n');
        return `${r.id}: ${r.name}\n  ${r.summary}\n  goal: ${r.goal.min} to ${r.goal.max} (default ${r.goal.default}) ${r.unit}\n  inputs:\n${fields}`;
      }).join('\n\n')
    );
  }

  function requestCard(a) {
    if (!isObj(a)) return text('Send the riff id and its inputs.', true);
    const riff = RIFFS.find((r) => r.id === a.riff);
    if (!riff) return text(`There is no riff called "${str(String(a.riff ?? ''), 40)}". Call riff_list_riffs to see the riffs.`, true);
    const given = isObj(a.inputs) ? a.inputs : {};
    const inputs = {};
    for (const f of riff.fields) {
      const raw = given[f.id];
      if (f.options) {
        if (raw != null && !f.options.some((o) => o.value === raw)) return text(`"${f.id}" must be one of: ${f.options.map((o) => o.value).join(', ')}.`, true);
        if (raw != null) inputs[f.id] = raw;
      } else {
        const v = str(raw == null ? '' : String(raw), f.max || 300);
        if (f.required && !v) return text(`"${f.id}" is required for ${riff.id}: ${f.label}.`, true);
        if (v) inputs[f.id] = v;
      }
    }
    sweep();
    if (sql(`SELECT COUNT(*) AS n FROM requests WHERE status = 'queued'`)[0].n >= MAX_WAITING) return text('The inbox is full. The user needs to open Riff so it can pick up what is waiting.', true);
    const goal = Number.isInteger(a.goal) ? Math.min(riff.goal.max, Math.max(riff.goal.min, a.goal)) : riff.goal.default;
    const id = `req_${hex(crypto.getRandomValues(new Uint8Array(9)))}`;
    sql(`INSERT INTO requests (id, body, at) VALUES (?, ?, ?)`, id, JSON.stringify({ riff: riff.id, title: str(a.title, 120), inputs, goal, why: str(a.why, 300) }), clock());
    return text(`Queued as ${id}. The card will appear in Ideas on the user's Riff board the next time Riff Home is open. It does not run until the user makes it ready. Tell the user it is waiting there.`);
  }

  function requestStatus(a) {
    const row = sql(`SELECT status, reason FROM requests WHERE id = ?`, str(a?.request, 80))[0];
    if (!row) return text('No such request (requests are kept for 30 days).', true);
    if (row.status === 'accepted') return text('Accepted: the card is on the board, in Ideas. It runs only when the user makes it ready.');
    if (row.status === 'rejected') return text(`Rejected: ${row.reason || 'Riff did not accept it.'}`);
    return text('Waiting: Riff has not picked it up yet. It will when the user next has Riff Home open.');
  }

  function rpc(msg) {
    if (!isObj(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    if (msg.id === undefined) return null; // a notification: nothing to answer
    const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const p = isObj(msg.params) ? msg.params : {};
    if (msg.method === 'initialize')
      return ok({
        protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'riff-inbox', version: VERSION },
        instructions: 'An inbox for the user’s Riff board. You can ask for cards; they land in Ideas and never run until the user makes them ready. You cannot read the board.',
      });
    if (msg.method === 'ping') return ok({});
    if (msg.method === 'tools/list') return ok({ tools: TOOLS });
    if (msg.method === 'tools/call') {
      if (p.name === 'riff_list_riffs') return ok(listRiffs());
      if (p.name === 'riff_request_card') return ok(requestCard(p.arguments));
      if (p.name === 'riff_request_status') return ok(requestStatus(p.arguments));
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${str(String(p.name ?? ''), 60)}` } };
    }
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
  }

  async function mcp(request) {
    const b = await bodyOf(request);
    if (b === undefined) return json(request, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    const out = Array.isArray(b) ? b.map(rpc).filter(Boolean) : rpc(b);
    if (out == null || (Array.isArray(out) && !out.length)) return json(request, null, 202);
    return json(request, out);
  }

  // ---------------------------------------------------------------- routes

  async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;
    if (method === 'OPTIONS') return json(request, null, 204);
    try {
      if (path === '/' && method === 'GET') {
        const agent = getMeta('agent');
        // name stays 'riff-inbox': Riff 1.1.0 and 1.1.1 check it when pairing. It changes with Riff at the rename (M6).
        return json(request, { name: 'riff-inbox', version: VERSION, protocol: PROTOCOL, paired: sql(`SELECT COUNT(*) AS n FROM keys WHERE kind = 'riff'`)[0].n > 0, hermes: { connected: !!opts.relay?.connected(), plugin: agent?.v || null, since: agent?.at || null } });
      }
      if (path === '/pair' && method === 'POST') return await pair(request);
      if (path === '/pair/hermes' && method === 'POST') return await pairHermes(request);
      if (path === '/link') {
        if (!(await keyOf(request, 'hermes'))) return fail(request, 401, 'A valid Hermes key is needed. Send it as "Authorization: Bearer <key>".');
        if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return fail(request, 426, 'This endpoint takes a WebSocket.');
        return opts.link ? opts.link(request) : fail(request, 501, 'No WebSocket here.');
      }
      // The relay. Riff adds this Worker as a Hermes agent (its address, a Riff key), so Hermes's own
      // paths (/v1/…, /api/sessions…) are relayed from the root; /hermes/<path> works too.
      const relayed = path === '/hermes' || path.startsWith('/hermes/') ? path.slice('/hermes'.length) || '/' : RELAYED.some((re) => re.test(path)) ? path : null;
      if (relayed != null) {
        if (!(await keyOf(request, 'riff'))) return fail(request, 401, 'This Worker does not know that Riff key. Pair Riff again.');
        if (!opts.relay) return fail(request, 501, 'No relay here.');
        return await opts.relay.forward(request, relayed + url.search, cors(request));
      }
      if (path === '/hermes-code' && method === 'POST') {
        if (!(await keyOf(request, 'riff'))) return fail(request, 401, 'This Worker does not know that Riff key. Pair Riff again.');
        return await newHermesCode(request);
      }
      if (path === '/steps' && method === 'GET') {
        if (!(await keyOf(request, 'riff'))) return fail(request, 401, 'This Worker does not know that Riff key. Pair Riff again.');
        return readSteps(request);
      }
      if (path === '/mcp') {
        if (method !== 'POST') return json(request, { error: 'This endpoint takes POST only.' }, 405, { allow: 'POST' });
        if (!(await keyOf(request, 'hermes'))) return fail(request, 401, 'A valid Hermes key is needed. Send it as "Authorization: Bearer <key>".');
        return await mcp(request);
      }
      if (['/inbox', '/inbox/ack', '/hermes-key', '/unpair'].includes(path)) {
        const key = await keyOf(request, 'riff');
        if (!key) return fail(request, 401, 'This Worker does not know that Riff key. Pair Riff again.');
        if (path === '/inbox' && method === 'GET') return read(request, key);
        if (path === '/inbox/ack' && method === 'POST') return await ack(request, key);
        if (path === '/hermes-key' && method === 'POST') return await replaceHermesKey(request);
        if (path === '/unpair' && method === 'POST') return (sql(`DELETE FROM keys WHERE id = ?`, key.id), json(request, { ok: true }));
      }
      return fail(request, 404, 'Not found.');
    } catch (e) {
      return fail(request, 500, 'The inbox hit an error.');
    }
  }

  return { handle, onFrame };
}
