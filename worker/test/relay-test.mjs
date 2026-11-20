// The relay and the plugin's doors, under plain Node (a stand-in socket plays the plugin).
//   node --no-warnings test/relay-test.mjs
import { DatabaseSync } from 'node:sqlite';
import { createInbox } from '../src/core.js';
import { createRelay } from '../src/relay.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? pass++ : (fail++, console.log('FAIL', name, JSON.stringify(got), 'want', JSON.stringify(want))));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const CODE = 'a-long-pairing-code-1234';
const db = new DatabaseSync(':memory:');
let ws = null; // the plugin's socket, when connected
const sent = [];
const plugin = () => ({ send: (s) => sent.push(JSON.parse(s)) });
let inbox;
const relay = createRelay({ socket: () => ws, onFrame: (f) => inbox.onFrame(f) });
let linked = 0;
inbox = createInbox((q, ...p) => db.prepare(q).all(...p), { PAIRING_CODE: CODE }, Date.now, { relay, link: () => (linked++, (ws = plugin()), new Response(null, { status: 204 })) });
const req = (path, { method = 'GET', key, body, headers = {}, signal } = {}) =>
  inbox.handle(new Request(`https://c.example.workers.dev${path}`, { method, signal, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }));
const js = async (r) => ({ status: r.status, json: JSON.parse((await r.text()) || 'null') });
const say = (f) => relay.onMessage(JSON.stringify(f));
const lastReq = () => sent.filter((f) => f.t === 'req').at(-1);

// ---------------------------------------------------------------- pairing: Riff, then the plugin
const first = (await js(await req('/pair', { method: 'POST', body: { code: CODE, name: 'Riff' } }))).json;
const RIFF = first.riffKey;
const OLD_HERMES = first.hermesKey;
eq('plugin pairing: wrong code', (await req('/pair/hermes', { method: 'POST', body: { code: 'nope-nope-nope' } })).status, 403);
const ph = (await js(await req('/pair/hermes', { method: 'POST', body: { code: CODE, name: 'mini' } }))).json;
const HERMES = ph.hermesKey;
eq('plugin pairing gives a new Hermes key', [/^hermes_[0-9a-f]{48}$/.test(HERMES), HERMES !== OLD_HERMES, ph.protocol], [true, true, 1]);
eq('the old Hermes key stops working', (await req('/mcp', { method: 'POST', key: OLD_HERMES, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 401);
eq('the new one works on the MCP door', (await js(await req('/mcp', { method: 'POST', key: HERMES, body: { jsonrpc: '2.0', id: 1, method: 'ping' } }))).json.result, {});

// ---------------------------------------------------------------- the link
eq('link needs the Hermes key', [(await req('/link', { key: RIFF, headers: { upgrade: 'websocket' } })).status, (await req('/link', { headers: { upgrade: 'websocket' } })).status], [401, 401]);
eq('link needs a WebSocket', (await req('/link', { key: HERMES })).status, 426);
eq('not connected yet: Riff is told why', [(await js(await req('/hermes/v1/models', { key: RIFF }))).status, (await req('/', {})).status], [503, 200]);
await req('/link', { key: HERMES, headers: { upgrade: 'websocket' } });
eq('linked', [linked, (await js(await req('/'))).json.hermes.connected], [1, true]);
say({ t: 'hello', v: '0.1.0', hermes: '0.23.1', host: 'mini' });
eq('hello: the plugin version shows', (await js(await req('/'))).json.hermes.plugin, '0.1.0');

// ---------------------------------------------------------------- relaying
eq('Riff key needed', (await req('/hermes/v1/models', { key: HERMES })).status, 401);
eq('only the run and session API', [(await req('/hermes/admin/config', { key: RIFF })).status, (await req('/hermes/v1/../../etc', { key: RIFF })).status], [403, 404]);

// a stream of words
let p = req('/hermes/v1/runs/run_1/events?x=1', { key: RIFF, headers: { accept: 'text/event-stream', origin: 'chrome-extension://abc', 'last-event-id': '7' } });
await tick();
const f1 = lastReq();
eq('the request goes down the socket, without Riff’s key', [f1.method, f1.path, f1.headers, 'authorization' in f1.headers, f1.body], ['GET', '/v1/runs/run_1/events?x=1', { accept: 'text/event-stream', 'last-event-id': '7' }, false, null]);
say({ t: 'head', id: f1.id, status: 200, headers: { 'content-type': 'text/event-stream', 'set-cookie': 'no' } });
let r = await p;
eq('the answer starts at once', [r.status, r.headers.get('content-type'), r.headers.get('set-cookie'), r.headers.get('access-control-allow-origin')], [200, 'text/event-stream', null, 'chrome-extension://abc']);
const reader = r.body.getReader();
const dec = new TextDecoder();
say({ t: 'data', id: f1.id, chunk: 'event: message.delta\ndata: {"delta":"Hé"}\n\n' });
eq('pieces arrive as they are sent', dec.decode((await reader.read()).value), 'event: message.delta\ndata: {"delta":"Hé"}\n\n');
say({ t: 'data', id: f1.id, chunk: 'event: run.completed\ndata: {}\n\n' });
say({ t: 'end', id: f1.id });
let rest = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  rest += dec.decode(value);
}
eq('and it ends', [rest, relay.pendingCount()], ['event: run.completed\ndata: {}\n\n', 0]);

// Riff drops any path from an agent's address, so Hermes's paths work from the root too
p = req('/v1/models', { key: RIFF });
await tick();
eq('root path relayed as is', lastReq().path, '/v1/models');
say({ t: 'head', id: lastReq().id, status: 200, headers: { 'content-type': 'application/json' } });
say({ t: 'data', id: lastReq().id, chunk: '{"data":[]}' });
say({ t: 'end', id: lastReq().id });
eq('and answered', (await js(await p)).json, { data: [] });
eq('root relay needs the Riff key', [(await req('/v1/models')).status, (await req('/api/sessions?limit=5', { key: HERMES })).status], [401, 401]);
eq('other root paths stay closed', (await req('/v2/anything', { key: RIFF })).status, 404);

// a POST with a body and Riff's repeat-safe key
p = req('/hermes/v1/runs', { method: 'POST', key: RIFF, body: { input: 'hi' }, headers: { 'idempotency-key': 'rA' } });
await tick();
const f2 = lastReq();
eq('POST body and Idempotency-Key pass', [f2.method, f2.body, f2.headers['idempotency-key'], f2.headers['content-type']], ['POST', '{"input":"hi"}', 'rA', 'application/json']);
say({ t: 'head', id: f2.id, status: 202, headers: { 'content-type': 'application/json' } });
say({ t: 'data', id: f2.id, chunk: '{"run_id":"run_2"}' });
say({ t: 'end', id: f2.id });
eq('202 and the JSON', await js(await p), { status: 202, json: { run_id: 'run_2' } });

// Hermes not answering on its own computer
p = req('/hermes/v1/models', { key: RIFF });
await tick();
say({ t: 'error', id: lastReq().id, message: 'Cannot connect to host 127.0.0.1:8642' });
r = await js(await p);
eq('error before an answer: 502 with the reason', [r.status, /127\.0\.0\.1:8642/.test(r.json.error)], [502, true]);

// Riff goes away mid-stream: the plugin is told to stop
const ac = new AbortController();
p = req('/hermes/v1/runs/run_3/events', { key: RIFF, signal: ac.signal });
await tick();
const f3 = lastReq();
say({ t: 'head', id: f3.id, status: 200, headers: {} });
await p;
ac.abort();
await tick();
eq('cancel goes to the plugin', sent.at(-1), { t: 'cancel', id: f3.id });

// the socket closes while a request waits
p = req('/hermes/v1/models', { key: RIFF });
await tick();
relay.onClose();
r = await js(await p);
eq('socket closed before an answer: 502', [r.status, /closed/.test(r.json.error)], [502, true]);

// ---------------------------------------------------------------- one-time Hermes codes (0.3)
eq('only Riff can ask for one', (await req('/hermes-code', { method: 'POST', key: HERMES })).status, 401);
const oc = (await js(await req('/hermes-code', { method: 'POST', key: RIFF }))).json;
eq('a short code, readable', /^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/.test(oc.code), true);
const p1 = (await js(await req('/pair/hermes', { method: 'POST', body: { code: oc.code.toLowerCase().replace('-', ' '), name: 'mini' } }))).json;
eq('it pairs Hermes (any case, any separator)', /^hermes_/.test(p1.hermesKey), true);
eq('it works once', (await req('/pair/hermes', { method: 'POST', body: { code: oc.code } })).status, 403);
const oc2 = (await js(await req('/hermes-code', { method: 'POST', key: RIFF }))).json;
eq('and not for Riff’s own pairing', (await req('/pair', { method: 'POST', body: { code: oc2.code } })).status, 403);
eq('the pairing code still pairs Hermes', (await req('/pair/hermes', { method: 'POST', body: { code: CODE } })).status, 200);

// ---------------------------------------------------------------- tool steps
say({ t: 'step', session: 'sess_1', state: 'done', tool: 'browser_cdp', preview: 'x.com', result: 'ok '.repeat(200), ms: 812, call: 'c1' });
say({ t: 'step', session: 'sess_2', state: 'fail', tool: 'web_search', preview: 'q', result: 'boom', ms: 3 });
eq('steps need the Riff key', (await req('/steps', { key: HERMES })).status, 401);
const all = (await js(await req('/steps', { key: RIFF }))).json;
eq('steps kept, results cut', [all.steps.length, all.steps[0].tool, all.steps[0].result.length, all.steps[1].state, all.last], [2, 'browser_cdp', 300, 'fail', 2]);
eq('by session, after a cursor', [(await js(await req('/steps?session=sess_2', { key: RIFF }))).json.steps.map((s) => s.tool), (await js(await req('/steps?after=1', { key: RIFF }))).json.steps.length], [['web_search'], 1]);

console.log(`relay: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
