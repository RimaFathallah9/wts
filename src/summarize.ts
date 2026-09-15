import Anthropic from "@anthropic-ai/sdk";
import type { ChatGroup } from "./db.js";

const MODEL = "claude-sonnet-4-6";
const MAX_CHARS = 80_000;

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

function formatBatch(groups: ChatGroup[]): string {
  if (groups.length === 0) {
    return "(no messages in the last 2 hours)";
  }

  const parts = groups.map((group) => {
    const kind = group.isGroup ? "group" : "DM";
    const header = `## ${group.chatName} (${kind}, ${group.chatId})`;
    const lines = group.messages.map((m) => {
      const when = formatTimestamp(m.timestamp);
      return `- [${when}] ${m.sender}: ${m.text}`;
    });
    return [header, ...lines].join("\n");
  });

  let body = parts.join("\n\n");
  if (body.length > MAX_CHARS) {
    body = `${body.slice(0, MAX_CHARS)}\n\n[truncated — too many messages to include all]`;
  }
  return body;
}

export async function summarizeLastTwoHours(groups: ChatGroup[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is missing. Copy .env.example to .env and add your key.");
  }

  const generatedAt = new Date().toISOString();
  const chatCount = groups.length;
  const messageCount = groups.reduce((n, g) => n + g.messages.length, 0);

  if (messageCount === 0) {
    return [
      "# WhatsApp — most important (last 2 hours)",
      "",
      `Generated: ${generatedAt}`,
      "",
      "No messages were stored in the last 2 hours, so there is nothing to rank.",
      "",
      "If this is your first run, keep the process running (`npm run start:watch`) so incoming chats can be saved, then try again.",
    ].join("\n");
  }

  const client = new Anthropic({ apiKey });
  const batch = formatBatch(groups);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    messages: [
      {
        role: "user",
        content: `You are triaging my personal WhatsApp inbox.

Below are ALL incoming messages from the last 2 hours, grouped by chat. Media is represented as placeholders like [image] or [audio].

Your job:
1. Identify the SINGLE most important or urgent message or conversation thread in this batch. Importance means something that needs a reply, a decision, bad news, a deadline, or anything time-sensitive — NOT merely the most recent message.
2. Give a 2-3 sentence summary of why it matters.
3. Also give a short bullet list of other notable-but-less-urgent items, for context.
4. If nothing is actually important, say so clearly and still list anything mildly noteworthy.

Format your reply as markdown with exactly these sections:

## Most important
**Chat:** <chat name>
**Why it matters:** <2-3 sentences>

## Other notable items
- <bullet>
- <bullet>

If there are no other notable items, write "- None." under that heading.

---
Batch stats: ${messageCount} messages across ${chatCount} chats.
Generated at: ${generatedAt}

${batch}`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const body =
    textBlock && textBlock.type === "text"
      ? textBlock.text.trim()
      : "Claude returned no text for this batch.";

  return [
    "# WhatsApp — most important (last 2 hours)",
    "",
    `Generated: ${generatedAt}`,
    `Scope: ${messageCount} messages in ${chatCount} chats`,
    "",
    body,
  ].join("\n");
}
