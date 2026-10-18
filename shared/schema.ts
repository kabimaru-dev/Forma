import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export type Message = { id: string; role: "user" | "assistant"; content: string; thinking?: string; model?: string; interrupted?: boolean; revisions?: string[]; revisionIndex?: number };
export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  title: text("title").notNull(),
  model: text("model").notNull(),
  messages: text("messages", { mode: "json" }).$type<Message[]>().notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export const insertChatSchema = createInsertSchema(chats).omit({ id: true, owner: true, updatedAt: true });
export type InsertChat = z.infer<typeof insertChatSchema>;
export type Chat = typeof chats.$inferSelect;
export const preferences = sqliteTable("preferences", {
  owner: text("owner").primaryKey(),
  value: text("value", { mode: "json" }).$type<Settings>().notNull(),
});
export const settingsSchema = z.object({
  temperature: z.number().min(0).max(2),
  context: z.number().int().min(2048).max(262144),
  contextStep: z.number().int().min(0).max(32768).default(16384),
  contextPreload: z.number().int().min(0).max(16384).default(8192),
  contextDefaultsApplied: z.boolean().default(true),
  system: z.string().max(12000),
  theme: z.enum(["system", "light", "dark"]),
  model: z.string().max(150),
  ollamaUrl: z.string().max(500).default(""),
});
export type Settings = z.infer<typeof settingsSchema>;
export const insertPreferenceSchema = createInsertSchema(preferences);
export type InsertPreference = z.infer<typeof insertPreferenceSchema>;
export type Preference = typeof preferences.$inferSelect;
export { defaultSettings } from "./defaults";
export const sendSchema = z.object({ content: z.string().max(100000).default(""), model: z.string().min(1).max(150), retry: z.boolean().default(false) });
