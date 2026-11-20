# Setting up Riff Connect for Hermes (for an agent)

Read `README.md` first. The usual setup is driven from Riff, under **Home › Models › Add › Hermes agent, through Riff Connect**, and the user doesn't need you for it. Use these notes when the user asks you to help.

## If the user pastes a message from Riff

The message gives an address (ending in `workers.dev`) and a one-time code, like `K7QM-3XRA`.

1. Call `riff_connect_pair` with that address and code.
2. Tell the user what it answered.

The code works once, for 15 minutes. If it's refused, ask the user to press **New code** in Riff.

Don't restart the Hermes gateway yourself, because that ends your session. If the gateway isn't running, ask the user to start it.

## If the user asks you to deploy the Worker

Before you start:

- You need Node 20 or later.
- You need a way to deploy to the user's Cloudflare account: either `npx wrangler login` has been done, or `CLOUDFLARE_API_TOKEN` is set.
- Ask the user before you deploy, because it creates a Worker on their account.

Then follow these steps:

```sh
cd worker
npm install
npm test
npx wrangler deploy
```

1. Set the pairing code as a secret with `npx wrangler secret put PAIRING_CODE`. Use the code the user made in Riff (**Make and copy a code**), or make one with `openssl rand -hex 16`. Don't write it to a file in this repository.
2. Give the user the Worker's address and tell them where it goes: **Riff › Models**, in the connector form.

## Rules

- Never commit `.dev.vars`, `.env`, the pairing code or any key.
- The Hermes key lets you leave card requests and ask about your own requests. It doesn't let you read the board, and you shouldn't try another way to.
- A card you ask for lands in Ideas. Only the user can make it ready and run it. Tell them it's waiting, and don't start the work yourself unless they ask you to.
