import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { closeDb, getMessagesLastTwoHours, groupMessagesByChat, initDb } from "./db.js";
import { summarizeLastTwoHours } from "./summarize.js";
import { connectWhatsApp, sendSummaryToSelf as sendViaBaileys } from "./whatsapp.js";

const SUMMARY_FILE = path.resolve(process.cwd(), "latest-summary.md");
const ONCE = process.argv.includes("--once");
const USE_WEB = process.argv.includes("--web") || process.env.WHATSAPP_AUTH === "web";
const INTERVAL_MS = 5 * 60 * 1000;
const READY_DELAY_MS = 12_000;

let summarizing = false;
let sendSummaryToSelf: (markdown: string) => Promise<void> = sendViaBaileys;

function printSummary(markdown: string): void {
  const bar = "═".repeat(64);
  console.log(`\n${bar}`);
  console.log(markdown);
  console.log(`${bar}\n`);
}

async function runSummary(): Promise<void> {
  if (summarizing) {
    console.log(`[${new Date().toISOString()}] Skipping overlapping summary run.`);
    return;
  }

  summarizing = true;
  const started = new Date().toISOString();
  console.log(`[${started}] Running last-2-hours summary...`);

  try {
    const messages = getMessagesLastTwoHours();
    const groups = groupMessagesByChat(messages);
    const markdown = await summarizeLastTwoHours(groups);
    fs.writeFileSync(SUMMARY_FILE, `${markdown}\n`, "utf8");
    printSummary(markdown);
    console.log(`Wrote ${SUMMARY_FILE}`);
    await sendSummaryToSelf(markdown);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Summary failed:`, err);
  } finally {
    summarizing = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env and add your key.");
    process.exit(1);
  }

  initDb();
  console.log("Connecting to WhatsApp...");

  if (USE_WEB) {
    const web = await import("./whatsapp-web.js");
    await web.connectWhatsAppWeb();
    sendSummaryToSelf = web.sendSummaryToSelf;
  } else {
    await connectWhatsApp();
    sendSummaryToSelf = sendViaBaileys;
  }

  console.log(`Waiting ${READY_DELAY_MS / 1000}s for recent chats to arrive...`);
  await sleep(READY_DELAY_MS);

  await runSummary();

  if (ONCE) {
    console.log("One-shot run finished.");
    closeDb();
    process.exit(0);
  }

  console.log(
    "Staying connected like WhatsApp Web. Summaries go to your own chat every 5 minutes — read them in WhatsApp Web.",
  );
  setInterval(() => {
    void runSummary();
  }, INTERVAL_MS);
}

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  closeDb();
  process.exit(0);
});

main().catch((err) => {
  console.error(err);
  closeDb();
  process.exit(1);
});
