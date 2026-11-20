# Riff Connect for Hermes

Connects your [Hermes agent](https://github.com/NousResearch/hermes-agent) to [Riff](https://riffreply.com), the browser extension, through a small Worker on **your own** Cloudflare account. You don't need a tunnel or an open port, and nothing passes through Zima Media.

```
Riff (your browser)  ──HTTPS──▶  your Worker on Cloudflare  ◀──WebSocket──  Hermes plugin (your computer)
```

- **Chat with Hermes from Riff, and run Board cards on it.** Riff calls the Worker, and the Worker passes each request over the plugin's WebSocket to Hermes's API server on `127.0.0.1`.
- **Hermes can put cards on your Riff board.** It asks with `riff_request_card`, and the card lands in Ideas. Only you can make a card ready and run it.
- **Riff sees the tools Hermes runs** while it works, including after you reload the page.

This repository holds two parts:

| Folder | What it is |
| --- | --- |
| [`worker/`](worker) | The Cloudflare Worker. It's one Durable Object with SQLite storage, and it runs on the Workers Free plan. |
| `/` (the root) | The Hermes plugin `riff-connect-hermes` and its skill [`skills/riff-board`](skills/riff-board/SKILL.md). |

## Set it up from Riff (about two minutes)

In Riff, open **Home › Models › Add** and choose **Hermes agent, through Riff Connect**. Riff walks you through these steps:

1. **Make and copy a code.** Riff makes the pairing code for you.
2. **Deploy the Worker.**

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zimamedia/riff-connect-hermes/tree/main/worker)

   Sign in to Cloudflare, or sign up (it's free). When Cloudflare asks for `PAIRING_CODE`, paste the code, then press **Deploy**. Cloudflare also puts a copy of this repository in your GitHub account.
3. **Pair Riff.** Paste the Worker's address (it ends in `workers.dev`) into **Connector address** and press **Save and connect**.
4. **Install the plugin on the Hermes computer:**

   ```sh
   hermes plugins install zimamedia/riff-connect-hermes --enable
   hermes gateway restart
   ```

5. **Pair Hermes.** Riff shows a message with the Worker's address and a **one-time code**. Paste it into Hermes. Hermes calls `riff_connect_pair`, and within a few seconds Riff shows **Connected**.

The one-time code works once, for 15 minutes. Your pairing code never has to leave the browser.

Hermes's API server must be on, with `API_SERVER_ENABLED=true` in `~/.hermes/.env`. The plugin reaches it at `127.0.0.1:${API_SERVER_PORT:-8642}`, using `API_SERVER_KEY` when one is set.

## Set it up by hand

```sh
cd worker
npm install
npm test
npx wrangler deploy
npx wrangler secret put PAIRING_CODE
```

Pair Riff with the address and the code. For Hermes, either paste Riff's message as in step 5 above, or add these two lines to `~/.hermes/.env` and restart the gateway:

```
RIFF_CONNECT_URL=https://riff-connect-hermes.<you>.workers.dev
RIFF_CONNECT_CODE=<the pairing code>
```

## Updating

- **Worker:** push to your copy of the repository and Cloudflare redeploys it. You can also run `npx wrangler deploy` from `worker/`.
- **Plugin:** run `hermes plugins update riff-connect-hermes`, then `hermes gateway restart`.

## How it's kept safe

- **Two keys, both kept as hashes.** Riff gets one key and Hermes gets another, and the Worker stores only their SHA-256 hashes. Wrong pairing codes lock pairing for 15 minutes after 8 tries.
- **Only Hermes's API is passed through.** The Worker relays `/v1/*`, `/api/sessions*` and `/health`, and nothing else. Bodies are limited to 2 MB.
- **The plugin opens one outgoing WebSocket.** It opens it only from the Hermes gateway, and only after it has been paired. It sends nothing to anyone but your Worker.
- **The Hermes key has narrow rights.** It can leave card requests and ask about its own. It can't read your board.
- **Your data stays on your accounts.** Everything is stored on your Cloudflare account, in your browser and on your computer.

## The plugin's tools

| Tool | What it does |
| --- | --- |
| `riff_connect_pair` | Pairs with the Worker, using an address and a one-time code from Riff. |
| `riff_list_riffs` | Lists the kinds of cards Riff can run. |
| `riff_request_card` | Asks for a card. It lands in Ideas on the Riff board. |
| `riff_request_status` | Shows what happened to a request. |

For each tool Hermes runs, the plugin's hooks send a step to your Worker: the tool's name, its status, and a short preview of its input and result. The preview is cut short and passed through Hermes's redaction. Riff reads these steps to show what Hermes did.

## Licence

MIT. Riff and Riff Connect are made by [Zima Media OÜ](https://riffreply.com).
