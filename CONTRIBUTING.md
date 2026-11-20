# Contributing

Thanks for helping. This repository has two parts. Both are small and have no build step.

| Part | Where | Language | Tests |
| --- | --- | --- | --- |
| The Cloudflare Worker | `worker/` | JavaScript (ES modules) | `cd worker && npm install && npm test` |
| The Hermes plugin | root (`__init__.py`, `plugin.yaml`, `skills/`) | Python 3.10+, standard library plus `aiohttp` | `python3 -m py_compile __init__.py` |

## Before you open a pull request

1. Run the Worker tests. They must pass.
2. If you change the protocol between the Worker and the plugin (frames, paths, pairing), change both sides in the same pull request. Raise `VERSION` in `worker/src/core.js` and in `__init__.py` (also `version` in `plugin.yaml`).
3. Keep `worker/` self-contained. The Deploy to Cloudflare button deploys that folder on its own.
4. Never commit `.dev.vars`, `.env`, a pairing code or a key.
5. Say in the pull request what you tested and how. For example: "`wrangler dev` with a real Hermes, a chat from Riff".

## What we'll accept

- **Bug fixes**, with a test for the Worker when possible.
- **Clearer messages and docs.** Users see the plugin's tool answers through Hermes, so plain words matter.
- **Smaller attack surface.** The relay and the keys stay as narrow as they are now. We won't accept a change that widens what the Hermes key can do, or what the relay passes, unless there's a strong reason.

For larger changes, open an issue first so we can agree on the approach.

## Licence

By contributing, you agree that your work is released under the MIT licence in `LICENSE`.
