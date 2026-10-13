import { chats, preferences, defaultSettings, type Chat, type Settings } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { and, eq, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const sqlite = new Database(process.env.DATA_FILE || "data.db");
sqlite.pragma("journal_mode = WAL");
sqlite.exec(`
 CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, model TEXT NOT NULL, messages TEXT NOT NULL, updated_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS chats_owner ON chats(owner);
 CREATE TABLE IF NOT EXISTS preferences (owner TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
const db = drizzle(sqlite);
export interface IStorage {
  list(owner: string): Chat[];
  get(owner: string, id: string): Chat | undefined;
  create(owner: string, title: string, model: string): Chat;
  update(owner: string, id: string, patch: Partial<Pick<Chat, "title" | "model" | "messages">>): Chat | undefined;
  delete(owner: string, id: string): void;
  settings(owner: string): Settings;
  saveSettings(owner: string, value: Settings): Settings;
}
class Storage implements IStorage {
  list(owner: string) { return db.select().from(chats).where(eq(chats.owner, owner)).orderBy(desc(chats.updatedAt)).all(); }
  get(owner: string, id: string) { return db.select().from(chats).where(and(eq(chats.id, id), eq(chats.owner, owner))).get(); }
  create(owner: string, title: string, model: string) {
    return db.insert(chats).values({ id: randomUUID(), owner, title, model, messages: [], updatedAt: Date.now() }).returning().get();
  }
  update(owner: string, id: string, patch: Partial<Pick<Chat, "title" | "model" | "messages">>) {
    return db.update(chats).set({ ...patch, updatedAt: Date.now() }).where(and(eq(chats.id, id), eq(chats.owner, owner))).returning().get();
  }
  delete(owner: string, id: string) { db.delete(chats).where(and(eq(chats.id, id), eq(chats.owner, owner))).run(); }
  settings(owner: string) { return { ...defaultSettings, ...db.select().from(preferences).where(eq(preferences.owner, owner)).get()?.value }; }
  saveSettings(owner: string, value: Settings) {
    db.insert(preferences).values({ owner, value }).onConflictDoUpdate({ target: preferences.owner, set: { value } }).run();
    return value;
  }
}
export const storage = new Storage();
