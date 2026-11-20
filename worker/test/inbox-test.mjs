// The inbox's logic under plain Node (node:sqlite stands in for the Durable Object's storage).
//   npm test
import { DatabaseSync } from 'node:sqlite';
import { createInbox, VERSION } from '../src/core.js';
import { RIFFS, PROTOCOL } from '../src/riffs.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? pass++ : (fail++, console.log('FAIL', name, JSON.stringify(got), 'want', JSON.stringify(want))));
const ok = (name, v) => eq(name, !!v, true);

const CODE = 'a-long-pairing-code-1234';
let now = Date.parse('2026-11-17T12:00:00Z');
function fresh(env = { PAIRING_CODE: CODE }) {
  const db = new DatabaseSync(':memory:');
  const inbox = createInbox((q, ...p) => db.prepare(q).all(...p), env, () => now);
  const call = async (path, { method = 'GET', key, body, origin, raw } = {}) => {
    const r = await inbox.handle(new Request(`https://inbox.example.workers.dev${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(origin ? { origin } : {}), ...(body || raw ? { 'content-type': 'application/json' } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) }));
    const t = await r.text();
    return { status: r.status, headers: r.headers, json: t ? JSON.parse(t) : null };
  };
  let rid = 0;
  const tool = async (key, name, args = {}) => (await call('/mcp', { method: 'POST', key, body: { jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } } })).json.result;
  return { call, tool };
}

// ---------------------------------------------------------------- who it is, and pairing
let { call, tool } = fresh();
eq('says what it is, and nothing secret', (await call('/')).json, { name: 'riff-inbox', version: VERSION, protocol: PROTOCOL, paired: false, hermes: { connected: false, plugin: null, since: null } });
eq('no pairing code set', [(await fresh({}).call('/pair', { method: 'POST', body: { code: '' } })).status, (await fresh({ PAIRING_CODE: 'short' }).call('/pair', { method: 'POST', body: { code: 'short' } })).status], [503, 503]);
eq('wrong code', (await call('/pair', { method: 'POST', body: { code: 'nope' } })).status, 403);
eq('not JSON', (await call('/pair', { method: 'POST', raw: 'hello' })).status, 400);
const first = (await call('/pair', { method: 'POST', body: { code: CODE, name: 'Riff 1.1.0', extensionId: 'abc' } })).json;
ok('first pairing gives both keys', /^riff_[0-9a-f]{48}$/.test(first.riffKey) && /^hermes_[0-9a-f]{48}$/.test(first.hermesKey) && first.protocol === PROTOCOL);
const second = (await call('/pair', { method: 'POST', body: { code: CODE } })).json;
ok('a second Riff gets its own key, and no Hermes key', /^riff_/.test(second.riffKey) && second.riffKey !== first.riffKey && !('hermesKey' in second));
eq('paired now', (await call('/')).json.paired, true);
const RIFF = first.riffKey;
const HERMES = first.hermesKey;

// lockout after too many wrong codes
{
  const t = fresh();
  for (let i = 0; i < 8; i++) await t.call('/pair', { method: 'POST', body: { code: `wrong${i}` } });
  eq('locked after 8 wrong codes, even with the right one', (await t.call('/pair', { method: 'POST', body: { code: CODE } })).status, 429);
  now += 16 * 60000;
  eq('open again after 15 minutes', (await t.call('/pair', { method: 'POST', body: { code: CODE } })).status, 200);
}

// ---------------------------------------------------------------- the two doors take different keys
eq('inbox: no key, Hermes key', [(await call('/inbox')).status, (await call('/inbox', { key: HERMES })).status], [401, 401]);
eq('mcp: no key, Riff key', [(await call('/mcp', { method: 'POST', body: {} })).status, (await call('/mcp', { method: 'POST', key: RIFF, body: {} })).status], [401, 401]);
eq('mcp is POST only', [(await call('/mcp')).status, (await call('/mcp')).headers.get('allow')], [405, 'POST']);
eq('unknown path', (await call('/board', { key: RIFF })).status, 404);

// ---------------------------------------------------------------- MCP
const init = (await call('/mcp', { method: 'POST', key: HERMES, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hermes', version: '1' } } } })).json;
eq('initialize', [init.id, init.result.protocolVersion, init.result.serverInfo.name, Object.keys(init.result.capabilities)], [1, '2025-03-26', 'riff-inbox', ['tools']]);
eq('a notification gets 202 and no body', [(await call('/mcp', { method: 'POST', key: HERMES, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, (await call('/mcp', { method: 'POST', key: HERMES, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).json], [202, null]);
eq('ping', (await call('/mcp', { method: 'POST', key: HERMES, body: { jsonrpc: '2.0', id: 2, method: 'ping' } })).json, { jsonrpc: '2.0', id: 2, result: {} });
const tools = (await call('/mcp', { method: 'POST', key: HERMES, body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } })).json.result.tools;
eq('three tools, each with a schema', tools.map((t) => [t.name, t.inputSchema.type, !!t.description]), [['riff_list_riffs', 'object', true], ['riff_request_card', 'object', true], ['riff_request_status', 'object', true]]);
eq('unknown method and tool', [(await call('/mcp', { method: 'POST', key: HERMES, body: { jsonrpc: '2.0', id: 4, method: 'resources/list' } })).json.error.code, (await call('/mcp', { method: 'POST', key: HERMES, body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'riff_read_board' } } })).json.error.code], [-32601, -32602]);
eq('a batch', (await call('/mcp', { method: 'POST', key: HERMES, body: [{ jsonrpc: '2.0', id: 6, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 7, method: 'ping' }] })).json.map((m) => m.id), [6, 7]);
eq('not JSON-RPC', [(await call('/mcp', { method: 'POST', key: HERMES, raw: '{oops' })).status, (await call('/mcp', { method: 'POST', key: HERMES, body: { id: 1, method: 'ping' } })).json.error.code], [400, -32600]);

const listed = (await tool(HERMES, 'riff_list_riffs')).content[0].text;
ok('the list names every riff and its fields', RIFFS.every((r) => listed.includes(`${r.id}: ${r.name}`)) && listed.includes('- topics (required): Keywords or topics') && listed.includes('[general | groups]'));

// ---------------------------------------------------------------- asking for a card
const bad = async (args) => {
  const r = await tool(HERMES, 'riff_request_card', args);
  return [r.isError === true, r.content[0].text];
};
eq('unknown riff', await bad({ riff: 'post-to-x', inputs: {} }), [true, 'There is no riff called "post-to-x". Call riff_list_riffs to see the riffs.']);
eq('a required field is missing', await bad({ riff: 'search-x' }), [true, '"topics" is required for search-x: Keywords or topics.']);
eq('a choice that is not offered', await bad({ riff: 'search-linkedin', inputs: { topics: 'ai', where: 'everywhere' } }), [true, '"where" must be one of: general, groups.']);
const made = await tool(HERMES, 'riff_request_card', { riff: 'search-x', title: 'Local models', inputs: { topics: `  ${'x'.repeat(500)}`, secret: 'ignored' }, goal: 9999, why: 'You asked me to line this up for tomorrow.' });
const REQ = made.content[0].text.match(/req_[0-9a-f]{18}/)?.[0];
ok('queued, and told to tell the user', !made.isError && REQ && made.content[0].text.includes('does not run until the user makes it ready'));
eq('status: waiting', (await tool(HERMES, 'riff_request_status', { request: REQ })).content[0].text.startsWith('Waiting'), true);
eq('status of something else', (await tool(HERMES, 'riff_request_status', { request: 'req_nope' })).isError, true);

// ---------------------------------------------------------------- Riff reads, then says what became of it
let got = (await call('/inbox', { key: RIFF })).json;
eq('Riff reads the request, cleaned', [got.protocol, got.requests.length, got.more, got.requests[0].id, got.requests[0].riff, got.requests[0].title, got.requests[0].inputs, got.requests[0].goal, got.requests[0].why], [PROTOCOL, 1, 0, REQ, 'search-x', 'Local models', { topics: 'x'.repeat(300) }, 50, 'You asked me to line this up for tomorrow.']);
eq('reading again before answering gives it again', (await call('/inbox', { key: RIFF })).json.requests.length, 1);
eq('ack needs results', (await call('/inbox/ack', { method: 'POST', key: RIFF, body: {} })).status, 400);
eq('accepted', (await call('/inbox/ack', { method: 'POST', key: RIFF, body: { results: [{ id: REQ, result: 'accepted' }] } })).json, { ok: true, cursor: got.requests[0].seq });
eq('nothing left for this Riff', (await call('/inbox', { key: RIFF })).json.requests, []);
eq('Hermes learns it was accepted', (await tool(HERMES, 'riff_request_status', { request: REQ })).content[0].text.startsWith('Accepted'), true);

// the second Riff was paired before the request, so it gets it too; a rejection there doesn't undo "accepted"
eq('the other Riff gets it as well', (await call('/inbox', { key: second.riffKey })).json.requests.map((r) => r.id), [REQ]);
await call('/inbox/ack', { method: 'POST', key: second.riffKey, body: { results: [{ id: REQ, result: 'rejected', reason: 'unknown riff' }] } });
eq('accepted stays accepted', (await tool(HERMES, 'riff_request_status', { request: REQ })).content[0].text.startsWith('Accepted'), true);

const REQ2 = (await tool(HERMES, 'riff_request_card', { riff: 'search-threads', inputs: { topics: 'pricing' } })).content[0].text.match(/req_[0-9a-f]+/)[0];
await call('/inbox/ack', { method: 'POST', key: RIFF, body: { results: [{ id: REQ2, result: 'rejected', reason: 'This Riff has no riff called search-threads.' }, { id: 'req_made_up', result: 'accepted' }] } });
eq('Hermes learns it was rejected, and why', (await tool(HERMES, 'riff_request_status', { request: REQ2 })).content[0].text, 'Rejected: This Riff has no riff called search-threads.');

// a Riff paired later starts at the oldest request nobody has picked up
const REQ3 = (await tool(HERMES, 'riff_request_card', { riff: 'search-x', inputs: { topics: 'agents' } })).content[0].text.match(/req_[0-9a-f]+/)[0];
const third = (await call('/pair', { method: 'POST', body: { code: CODE } })).json.riffKey;
eq('a Riff paired later sees only what is still waiting', (await call('/inbox', { key: third })).json.requests.map((r) => r.id), [REQ3]);

// ---------------------------------------------------------------- keys can be replaced and removed
const replaced = (await call('/hermes-key', { method: 'POST', key: RIFF })).json.hermesKey;
eq('a new Hermes key; the old one stops working', [/^hermes_/.test(replaced) && replaced !== HERMES, (await call('/mcp', { method: 'POST', key: HERMES, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, (await call('/mcp', { method: 'POST', key: replaced, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status], [true, 401, 200]);
eq('Hermes cannot replace keys or unpair', [(await call('/hermes-key', { method: 'POST', key: replaced })).status, (await call('/unpair', { method: 'POST', key: replaced })).status], [401, 401]);
eq('unpair', [(await call('/unpair', { method: 'POST', key: third })).json, (await call('/inbox', { key: third })).status, (await call('/inbox', { key: RIFF })).status], [{ ok: true }, 401, 200]);

// ---------------------------------------------------------------- limits
eq('a body that is too big', (await call('/mcp', { method: 'POST', key: replaced, raw: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(20000) } }) })).status, 400);
eq('extensions get CORS, web pages do not', [(await call('/', { origin: 'chrome-extension://abcdef' })).headers.get('access-control-allow-origin'), (await call('/', { origin: 'https://evil.example' })).headers.get('access-control-allow-origin'), (await call('/inbox', { method: 'OPTIONS', origin: 'chrome-extension://abcdef' })).status], ['chrome-extension://abcdef', null, 204]);
{
  const t = fresh();
  const k = (await t.call('/pair', { method: 'POST', body: { code: CODE } })).json;
  for (let i = 0; i < 200; i++) await t.tool(k.hermesKey, 'riff_request_card', { riff: 'search-x', inputs: { topics: `t${i}` } });
  const full = await t.tool(k.hermesKey, 'riff_request_card', { riff: 'search-x', inputs: { topics: 'one more' } });
  eq('the inbox fills up at 200 waiting', [full.isError, full.content[0].text.startsWith('The inbox is full')], [true, true]);
  const page = (await t.call('/inbox', { key: k.riffKey })).json;
  eq('read 50 at a time', [page.requests.length, page.more], [50, 150]);
  now += 31 * 86400000;
  eq('requests are kept for 30 days', (await t.call('/inbox', { key: k.riffKey })).json.requests.length, 0);
}

console.log(`riff-inbox: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
