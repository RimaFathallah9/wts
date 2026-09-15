import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH = path.resolve(process.cwd(), "messages.db");

export type StoredMessage = {
  id: number;
  messageId: string;
  chatId: string;
  chatName: string;
  sender: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
};

export type ChatGroup = {
  chatId: string;
  chatName: string;
  isGroup: boolean;
  messages: StoredMessage[];
};

export type NewMessage = {
  messageId: string;
  chatId: string;
  chatName: string;
  sender: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
};

let db: Database.Database | null = null;

export function initDb(): Database.Database {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      chat_name TEXT NOT NULL DEFAULT '',
      sender TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      is_group INTEGER NOT NULL DEFAULT 0,
      UNIQUE (chat_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_id, timestamp);
  `);

  return db;
}

function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

export function insertMessage(msg: NewMessage): boolean {
  const result = getDb()
    .prepare(
      `
      INSERT OR IGNORE INTO messages
        (message_id, chat_id, chat_name, sender, text, timestamp, is_group)
      VALUES
        (@messageId, @chatId, @chatName, @sender, @text, @timestamp, @isGroup)
    `,
    )
    .run({
      messageId: msg.messageId,
      chatId: msg.chatId,
      chatName: msg.chatName,
      sender: msg.sender,
      text: msg.text,
      timestamp: msg.timestamp,
      isGroup: msg.isGroup ? 1 : 0,
    });

  return result.changes > 0;
}

function rowToMessage(row: {
  id: number;
  message_id: string;
  chat_id: string;
  chat_name: string;
  sender: string;
  text: string;
  timestamp: number;
  is_group: number;
}): StoredMessage {
  return {
    id: row.id,
    messageId: row.message_id,
    chatId: row.chat_id,
    chatName: row.chat_name,
    sender: row.sender,
    text: row.text,
    timestamp: row.timestamp,
    isGroup: Boolean(row.is_group),
  };
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export function getMessagesLastTwoHours(now = Date.now()): StoredMessage[] {
  const since = now - TWO_HOURS_MS;
  const rows = getDb()
    .prepare(
      `
      SELECT id, message_id, chat_id, chat_name, sender, text, timestamp, is_group
      FROM messages
      WHERE timestamp >= ?
      ORDER BY chat_id, timestamp ASC
    `,
    )
    .all(since) as Array<{
    id: number;
    message_id: string;
    chat_id: string;
    chat_name: string;
    sender: string;
    text: string;
    timestamp: number;
    is_group: number;
  }>;

  return rows.map(rowToMessage);
}

export function groupMessagesByChat(messages: StoredMessage[]): ChatGroup[] {
  const groups = new Map<string, ChatGroup>();

  for (const message of messages) {
    const existing = groups.get(message.chatId);
    if (existing) {
      existing.messages.push(message);
      if (message.chatName) existing.chatName = message.chatName;
      continue;
    }

    groups.set(message.chatId, {
      chatId: message.chatId,
      chatName: message.chatName || message.chatId,
      isGroup: message.isGroup,
      messages: [message],
    });
  }

  return [...groups.values()];
}

export function closeDb(): void {
  db?.close();
  db = null;
}
