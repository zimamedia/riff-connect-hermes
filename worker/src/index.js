// The Worker: one Durable Object holds the whole connector (keys, waiting card requests,
// tool steps) in its own SQLite storage, on your Cloudflare account, and the WebSocket
// the riff-connect-hermes plugin keeps open. See core.js and relay.js for what it does.

import { DurableObject } from 'cloudflare:workers';
import { createInbox } from './core.js';
import { createRelay } from './relay.js';

const TAG = 'hermes';

export class Inbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.relay = createRelay({
      socket: () => ctx.getWebSockets(TAG)[0] || null,
      onFrame: (f) => this.inbox.onFrame(f),
    });
    this.inbox = createInbox((query, ...params) => ctx.storage.sql.exec(query, ...params).toArray(), env, Date.now, {
      relay: this.relay,
      link: () => this.link(),
    });
    // The plugin's keep-alive pings are answered without waking the Durable Object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  fetch(request) {
    return this.inbox.handle(request);
  }

  // One Hermes at a time: a new connection replaces the old one.
  link() {
    for (const old of this.ctx.getWebSockets(TAG)) {
      try {
        old.close(4000, 'Replaced by a newer connection.');
      } catch {}
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [TAG]);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    this.relay.onMessage(message);
  }

  webSocketClose(ws) {
    this.relay.onClose();
  }

  webSocketError(ws) {
    this.relay.onClose();
  }
}

export default {
  fetch(request, env) {
    return env.INBOX.get(env.INBOX.idFromName('inbox')).fetch(request);
  },
};
