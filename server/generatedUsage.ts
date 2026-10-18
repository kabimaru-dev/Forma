import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Chat } from "@shared/schema";

// A separate local metadata file. SQLite data, schema and config remain untouched.
// Store only original Ollama eval_count (llama.cpp n_gen) per completed reply.
const usageFile = process.env.FORMA_GENERATED_USAGE_FILE ||
  join(dirname(resolve(process.env.DATA_FILE || "data.db")), ".forma-n-gen.json");
type Ledger = Record<string, Record<string, number>>;
function validNGen(n: unknown): n is number {
  return Number.isSafeInteger(n) && typeof n === "number" && n >= 0;
}
function load(): Ledger {
  try {
    const raw: unknown = JSON.parse(readFileSync(usageFile, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const result: Ledger = {};
    for (const [chatId, messages] of Object.entries(raw)) {
      if (!messages || typeof messages !== "object" || Array.isArray(messages)) continue;
      result[chatId] = {};
      for (const [messageId, n] of Object.entries(messages)) {
        if (validNGen(n)) result[chatId][messageId] = n;
      }
    }
    return result;
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw new Error(`Cannot read Forma usage file ${usageFile}: ${e?.message || e}`);
  }
}
const ledger = load();
function save(): void {
  const temp = usageFile + `.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(ledger), { encoding: "utf8", mode: 0o600 });
  renameSync(temp, usageFile);
}
export const generatedUsage = {
  record(chatId: string, assistantMessageId: string, nGen: number): void {
    if (!validNGen(nGen)) throw new Error("Invalid Ollama eval_count");
    const chat = ledger[chatId] || (ledger[chatId] = {});
    const previous = chat[assistantMessageId];
    chat[assistantMessageId] = nGen;
    try { save(); } catch (e) {
      if (previous === undefined) delete chat[assistantMessageId]; else chat[assistantMessageId] = previous;
      throw e;
    }
  },
  summarize(chat: Chat): { nGen: number | null; knownNGen: number; missing: number } {
    const stored = ledger[chat.id] || {};
    let knownNGen = 0, missing = 0;
    for (const message of chat.messages) {
      if (message.role !== "assistant") continue;
      const value = stored[message.id];
      if (!validNGen(value)) missing++;
      else knownNGen += value;
    }
    return { nGen: missing ? null : knownNGen, knownNGen, missing };
  },
  remove(chatId: string): void {
    const old = ledger[chatId];
    delete ledger[chatId];
    try { save(); } catch (e) { if (old) ledger[chatId] = old; throw e; }
  },
};
