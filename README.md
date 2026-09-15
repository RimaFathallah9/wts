# WhatsApp "Most Important Message" Agent

Connects to your WhatsApp account via WhatsApp Web, stores incoming text (and media placeholders) in a local SQLite database, then asks Claude which single conversation from the last 2 hours actually matters.

## Disclaimer — read this first

**Baileys is an unofficial library.** It reverse-engineers WhatsApp Web. Using it **violates WhatsApp's Terms of Service**. Meta can **ban, flag, or restrict the linked number at any time**, without warning.

**Do not use this on a primary personal or business number.** Use a secondary / throwaway WhatsApp account you can afford to lose. This project is for personal triage on a number you control. It is not affiliated with WhatsApp or Meta.

## What it does

1. Logs in with a QR code (session saved in `./auth` so you do not rescan every run).
2. Listens for incoming messages and writes them to `messages.db`.
3. Pulls everything from the last 2 hours, grouped by chat.
4. Sends that batch to Claude (`claude-sonnet-4-6`) to pick the most urgent thread and list other notable items.
5. Prints the result and overwrites `latest-summary.md`.

## Setup

You need **Node.js 20 or newer** (22 LTS is a good choice). Check with `node -v`. Windows: if `better-sqlite3` fails to install after upgrading Node, install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload.

```bash
npm install
copy .env.example .env
```

On macOS/Linux use `cp .env.example .env`. Then put your Anthropic key in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Run

One summary (connects, waits briefly for chats, writes `latest-summary.md`, exits):

```bash
npm run start
```

Keep running, store messages continuously, and re-summarize every 5 minutes:

```bash
npm run start:watch
```

First run prints a QR code. On your phone: **WhatsApp → Settings → Linked devices → Link a device**, then scan it.

## Re-auth

If the session dies, WhatsApp logs you out, or the QR never completes:

1. Stop the process.
2. Delete the `auth` folder.
3. Run `npm run start` (or `start:watch`) again and scan a new QR.

Do not commit `auth/`, `.env`, or `messages.db`. They are gitignored.

## Project layout

| Path | Role |
| --- | --- |
| `src/index.ts` | Startup, one-shot vs `--watch` schedule |
| `src/whatsapp.ts` | Baileys connection, QR login, message listener |
| `src/db.ts` | SQLite schema and last-2-hours query |
| `src/summarize.ts` | Claude ranking + markdown summary |
| `.env.example` | `ANTHROPIC_API_KEY=` |

Media binaries are not stored. Image/audio/video/etc. become placeholders such as `[image]` or `[voice note]`.
