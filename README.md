# WhatsApp "Most Important Message" Agent

Connects to your WhatsApp account, stores incoming text (and media placeholders) in a local SQLite database, then asks Claude which single conversation from the last 2 hours actually matters.

## Disclaimer — read this first

**This uses unofficial WhatsApp Web libraries.** They reverse-engineer WhatsApp Web. Using them **violates WhatsApp's Terms of Service**. Meta can **ban, flag, or restrict the linked number at any time**, without warning.

**Do not use this on a primary personal or business number.** Use a secondary / throwaway WhatsApp account you can afford to lose. This project is for personal triage on a number you control. It is not affiliated with WhatsApp or Meta.

## What it does

1. Logs in **without a QR code** (pairing code, or your existing Chrome WhatsApp Web session).
2. Listens for incoming messages and writes them to `messages.db`.
3. Pulls everything from the last 2 hours, grouped by chat.
4. Sends that batch to Claude (`claude-sonnet-4-6`) to pick the most urgent thread and list other notable items.
5. Prints the result, overwrites `latest-summary.md`, and sends the same summary to **your own WhatsApp chat**.

## Setup

You need **Node.js 20 or newer** (22 LTS is a good choice). Check with `node -v`. Windows: if `better-sqlite3` fails to install after upgrading Node, install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload.

```bash
npm install
copy .env.example .env
```

On macOS/Linux use `cp .env.example .env`. Then edit `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
WHATSAPP_PHONE=351912345678
```

`WHATSAPP_PHONE` is country code + number, digits only (no `+` or spaces).

## Login (no QR)

### Option A — pairing code (default)

```bash
npm run start
```

The terminal prints an 8-digit code like `ABCD-1234`. On the phone that owns the number:

**WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead**

Type that code. Do not scan a QR.

If `./auth` already exists from a previous login, it reconnects with no code.

### Option B — existing WhatsApp Web in Chrome

If you already use [web.whatsapp.com](https://web.whatsapp.com) in Chrome:

1. **Quit Chrome completely** (all windows).
2. Run:

```bash
npm run start:web
```

That reuses your Chrome WhatsApp Web login. No QR, no pairing code. If Chrome is still open, Windows will block the profile — close it first.

## Run

`npm run start` (or `start:web`) stays connected and sends a summary to your own chat every 5 minutes. Leave the window open and read the note in WhatsApp Web under the chat with **yourself**.

One-shot (connect, summarize, send, then exit):

```bash
npm run start:once
```

## Re-auth

If the session dies:

1. Stop the process.
2. Delete the `auth` folder (pairing) or fix Chrome login (web mode).
3. Set `WHATSAPP_PHONE` in `.env`.
4. Run `npm run start` again and enter the new pairing code.

Do not commit `auth/`, `.env`, `messages.db`, or Chrome profile folders. They are gitignored.

## Project layout

| Path | Role |
| --- | --- |
| `src/index.ts` | Startup; pairing vs `--web`; stays online unless `--once` |
| `src/whatsapp.ts` | Baileys connection, pairing-code login, message listener |
| `src/whatsapp-web.ts` | Existing Chrome WhatsApp Web session |
| `src/db.ts` | SQLite schema and last-2-hours query |
| `src/summarize.ts` | Claude ranking + markdown summary |
| `.env.example` | `ANTHROPIC_API_KEY=` and `WHATSAPP_PHONE=` |

Media binaries are not stored. Image/audio/video/etc. become placeholders such as `[image]` or `[voice note]`.
