/**
 * Forma mode routing. Model identifiers are read from config/modes.yaml on the
 * SERVER ONLY. The API intentionally publishes only availability booleans.
 *
 * This small strict parser supports the documented mapping-only YAML subset
 * (indentation, string scalars, booleans, comments), not arbitrary YAML syntax.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export const LEVELS = ["core", "plus", "pro", "ultra"] as const;
export const REASONING = ["low", "medium", "high", "extra_high", "max"] as const;
export const SPEEDS = ["normal", "fast"] as const;
export type Level = typeof LEVELS[number];
export type Reasoning = typeof REASONING[number];
export type Speed = typeof SPEEDS[number];
const selector = /^forma:(core|plus|pro|ultra):(low|medium|high|extra_high|max):(normal|fast)$/;
const modelName = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,149}$/;

export function isFormaMode(id: string): boolean { return id.startsWith("forma:"); }

function value(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    try { const parsed = JSON.parse(trimmed); if (typeof parsed === "string") return parsed; } catch { /* invalid below */ }
    throw new Error("Неверная строка в config/modes.yaml.");
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'")) throw new Error("Незакрытая строка в config/modes.yaml.");
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed.split(/\s+#/)[0].trim();
}

function readConfig(): Record<string, unknown> {
  // Always resolve relative to the app's working directory; no arbitrary paths.
  const local = resolve(process.cwd(), "config/modes.yaml");
  const source = existsSync(local) ? local : resolve(process.cwd(), "config/modes.example.yaml");
  const text = readFileSync(source, "utf8");
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; map: Record<string, unknown> }> = [{ indent: -1, map: root }];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (line.includes("\t")) throw new Error(`modes.yaml:${i + 1}: используйте пробелы, а не Tab.`);
    const match = /^( *)([a-z][a-z0-9_]*):(?:\s+(.*))?$/.exec(line);
    if (!match) throw new Error(`modes.yaml:${i + 1}: неверный формат поля.`);
    const indent = match[1].length;
    if (indent % 2 !== 0) throw new Error(`modes.yaml:${i + 1}: используйте отступы по 2 пробела.`);
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop();
    if (indent !== stack.at(-1)!.indent + 2 && !(indent === 0 && stack.length === 1)) {
      throw new Error(`modes.yaml:${i + 1}: неверный отступ.`);
    }
    const parent = stack.at(-1)!.map;
    const key = match[2];
    if (Object.prototype.hasOwnProperty.call(parent, key)) throw new Error(`modes.yaml:${i + 1}: повторное поле ${key}.`);
    const scalar = match[3];
    if (scalar === undefined || scalar.trim() === "") {
      const nested: Record<string, unknown> = {};
      parent[key] = nested;
      stack.push({ indent, map: nested });
    } else {
      parent[key] = value(scalar);
    }
  }
  return root;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function configuration() {
  const root = readConfig();
  const tiers = object(root.levels);
  const enabled = {} as Record<Level, boolean>;
  const available = {} as Record<Level, Record<Reasoning, Record<Speed, boolean>>>;
  const models = {} as Record<Level, Record<Reasoning, Record<Speed, string>>>;
  for (const level of LEVELS) {
    const entry = object(tiers[level]);
    enabled[level] = entry.enabled === "true";
    models[level] = {} as Record<Reasoning, Record<Speed, string>>;
    available[level] = {} as Record<Reasoning, Record<Speed, boolean>>;
    for (const reasoning of REASONING) {
      const defined = object(object(entry.models)[reasoning]);
      const dest = {} as Record<Speed, string>;
      const flags = {} as Record<Speed, boolean>;
      for (const speed of SPEEDS) {
        const v = defined[speed];
        const raw = typeof v === "string" ? v : "";
        if (raw && !modelName.test(raw)) throw new Error(`Некорректное имя модели в ${level}/${reasoning}/${speed}.`);
        dest[speed] = raw;
        flags[speed] = enabled[level] && !!raw;
      }
      models[level][reasoning] = dest;
      available[level][reasoning] = flags;
    }
  }
  return { enabled, available, models };
}

export function publicModes() {
  const { enabled, available } = configuration();
  return { levels: enabled, available };
}
export function resolveMode(selection: string): string {
  const match = selector.exec(selection);
  if (!match) throw new Error("Неизвестный режим Forma.");
  const [, level, reasoning, speed] = match as [string, Level, Reasoning, Speed];
  const { enabled, models } = configuration();
  if (!enabled[level]) throw new Error("Этот уровень пока недоступен.");
  const model = models[level][reasoning][speed];
  if (!model) throw new Error("Для этого режима не назначена модель. Заполните config/modes.yaml.");
  return model;
}
