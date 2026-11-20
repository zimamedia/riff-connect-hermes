# Security

Riff Connect for Hermes passes requests from your browser to your Hermes agent, so a security problem here matters. Thank you for reporting one.

## How to report a problem

Please don't open a public issue. Do one of these instead:

- **Report it privately on GitHub:** open the Security tab of this repository and choose **Report a vulnerability**.
- **Email:** hello@zimamedia.com, with "Riff Connect security" in the subject.

Tell us which part is affected (the Worker, the Hermes plugin, or both), and include its version and how to reproduce the problem. We reply within a week and tell you what we're doing about it. Once a fix is released, we credit you if you'd like that.

## Which versions are fixed

Only the latest version on `main` is fixed. Update with these commands:

- **Worker:** `npx wrangler deploy` from `worker/`. If you used the Deploy button, push to your copy of the repository instead.
- **Plugin:** `hermes plugins update riff-connect-hermes`, then `hermes gateway restart`.

## In scope

- Reaching Hermes through a Worker without Riff's key.
- Pairing without the pairing code or a valid one-time code.
- Using the Hermes key for more than leaving card requests and reading its own.
- The relay passing paths other than `/v1/*`, `/api/sessions*` and `/health`.
- Keys or codes stored in plain text, or written to logs.

## Out of scope

- Problems in Hermes itself. Report those to Nous Research.
- Problems in Cloudflare. Report those to Cloudflare.
- Anything that needs control of the user's own computer or Cloudflare account.
