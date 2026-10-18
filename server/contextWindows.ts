import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Settings } from "@shared/schema";

export const MAX_CONTEXT = 256 * 1024;
export type ContextSettings = Pick<Settings, "context" | "contextStep" | "contextPreload">;
export type ContextState = { model: string; context: number; observed: number | null; step: number; preload: number };
type Ledger = Record<string, ContextState>;

const contextFile = process.env.FORMA_CONTEXT_FILE || join(dirname(resolve(process.env.DATA_FILE || "data.db")), ".forma-context-windows.json");
function safeInt(n: unknown): n is number { return typeof n === "number" && Number.isSafeInteger(n) && n >= 0; }
function readLedger(): Ledger {
  try {
    const loaded: unknown = JSON.parse(readFileSync(contextFile, "utf8"));
    if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) return {};
    const result: Ledger = {};
    for (const [id, entry] of Object.entries(loaded)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const s = entry as Partial<ContextState>;
      if (typeof s.model === "string" && safeInt(s.context) && s.context >= 2048 && s.context <= MAX_CONTEXT &&
          (s.observed === null || safeInt(s.observed)) && safeInt(s.step) && safeInt(s.preload)) {
        result[id] = { model: s.model, context: s.context, observed: s.observed ?? null, step: s.step, preload: s.preload };
      }
    }
    return result;
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw new Error(`Не удалось прочитать статистику окон ${contextFile}: ${e?.message || e}`);
  }
}
const ledger = readLedger();
function persist() {
  const tmp = `${contextFile}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(ledger), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, contextFile);
}
function validSettings(s: ContextSettings) {
  if (!safeInt(s.context) || s.context < 2048 || s.context > MAX_CONTEXT ||
      !safeInt(s.contextStep) || s.contextStep > 32768 ||
      !safeInt(s.contextPreload) || s.contextPreload > 16384) throw new Error("Некорректные настройки контекстного окна.");
}

/**
 * Exact usage is taken from Ollama's completed chat response:
 * prompt_eval_count + eval_count. It is NOT the UI's cumulative n_gen.
 * A threshold triggers for the NEXT request; old responses cannot be re-tokenized exactly.
 */
export function selectContext(used: number | null, current: number, settings: ContextSettings): number {
  validSettings(settings);
  const step = settings.contextStep;
  if (!step) return settings.context;
  let target = Math.max(2048, Math.min(MAX_CONTEXT, current || step));
  if (used === null || !safeInt(used)) return target;
  while (used >= target && target < MAX_CONTEXT) target = Math.min(MAX_CONTEXT, target + step);
  if (settings.contextPreload > 0 && target < MAX_CONTEXT) {
    const margin = Math.min(settings.contextPreload, Math.floor(target / 2));
    if (used >= target - margin) {
      // In advance mode, preload up to double the current window, as requested
      // (32K -> 64K, 48K -> 96K), never beyond 256K.
      target = Math.min(MAX_CONTEXT, Math.max(target + step, target * 2));
    }
  }
  return target;
}
function initialContext(settings: ContextSettings): number { return settings.contextStep ? Math.max(2048, settings.contextStep) : settings.context; }
function currentState(chatId: string, model: string, settings: ContextSettings): ContextState {
  validSettings(settings);
  const old = ledger[chatId];
  if (old?.model === model && old.step === settings.contextStep && old.preload === settings.contextPreload) {
    // Fixed manual context might have been changed since previous request.
    return { ...old, context: settings.contextStep ? old.context : settings.context };
  }
  const observed = old?.model === model ? old.observed : null;
  return { model, observed: observed ?? null, context: selectContext(observed ?? null, initialContext(settings), settings),
    step: settings.contextStep, preload: settings.contextPreload };
}
export const contextWindows = {
  current(chatId: string, model: string, settings: ContextSettings) { return currentState(chatId, model, settings).context; },
  display(chatId: string, settings: ContextSettings) {
    // This is a display fallback; only the send route knows the actual upstream model.
    const old = ledger[chatId];
    if (!settings.contextStep) return settings.context;
    return old && old.step === settings.contextStep && old.preload === settings.contextPreload
      ? old.context : initialContext(settings);
  },
  record(chatId: string, model: string, settings: ContextSettings, promptCount: number | null, generationCount: number | null) {
    const current = currentState(chatId, model, settings);
    // Do not infer usage from text lengths, and do not equate n_gen with context.
    const observed = safeInt(promptCount) && safeInt(generationCount) ? promptCount + generationCount : current.observed;
    const next = selectContext(observed, current.context, settings);
    ledger[chatId] = { ...current, observed, context: next };
    persist();
    return { before: current.context, after: next, observed, changed: next !== current.context };
  },
  remove(chatId: string) { const previous = ledger[chatId]; delete ledger[chatId]; try { persist(); } catch(e) { if (previous) ledger[chatId] = previous; throw e; } },
};
