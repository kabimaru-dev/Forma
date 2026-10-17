/**
 * Forma mode routing. Model identifiers are read from config/modes.yaml on the
 * SERVER ONLY. The API intentionally publishes only availability booleans.
 *
 * This small strict parser supports the documented mapping-only YAML subset
 * (indentation, string scalars, booleans, comments), not arbitrary YAML syntax.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export const LEVELS = ["minimal", "moderate", "intensive", "extreme"] as const;
export const REASONING = ["minimal", "low", "medium", "high", "extra_high", "max", "ultra"] as const;
export const SPEEDS = ["normal", "fast"] as const;
export const CUSTOM_KEYS = ["option_1", "option_2", "option_3", "option_4", "option_5"] as const;
export type Level = typeof LEVELS[number];
export type Reasoning = typeof REASONING[number];
export type Speed = typeof SPEEDS[number];
const selector = /^forma:(minimal|moderate|intensive|extreme|core|plus|pro|ultra):(minimal|low|medium|high|extra_high|max|ultra):(normal|fast)(?::(model_0[2-7]))?$/;
const legacyLevels: Record<string, Level> = { core: "minimal", plus: "moderate", pro: "intensive", ultra: "extreme" };
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
  const modelChoices: Record<string, {label:string; enabled:boolean}> = {default:{label:"Anime-Sakura",enabled:true}};
  const overrides: Record<string,string> = {};
  for (let i = 2; i <= 7; i++) {
    const key = `model_0${i}`, item = object(object(root.model_choices)[key]);
    const model = typeof item.model === "string" ? item.model : "";
    if (model && !modelName.test(model)) throw new Error("Некорректная модель в model_choices.");
    modelChoices[key] = {label: typeof item.label === "string" ? item.label.slice(0,48) : `Model 0${i}`, enabled:item.enabled === "true" && !!model};
    overrides[key] = model;
  }
  const tiers = object(root.levels);
  const speedConfig = object(root.speed);
  const customConfig = object(root.custom);
  const enabled = {} as Record<Level, boolean>;
  const reasoningEnabled = {} as Record<Level, Record<Reasoning, boolean>>;
  const speedEnabled = {} as Record<Speed, boolean>;
  for (const speed of SPEEDS) speedEnabled[speed] = object(speedConfig[speed]).enabled === "true";
  const customOptions = {} as Record<typeof CUSTOM_KEYS[number], { enabled: boolean; label: string }>;
  for (const [index, key] of CUSTOM_KEYS.entries()) {
    const item = object(object(customConfig.options)[key]);
    customOptions[key] = {
      enabled: item.enabled === "true",
      label: typeof item.label === "string" && item.label.trim() ? item.label.trim().slice(0, 48) : `Скоро ${index + 1}`,
    };
  }
  const custom = { enabled: customConfig.enabled === "true", options: customOptions };
  const available = {} as Record<Level, Record<Reasoning, Record<Speed, boolean>>>;
  const models = {} as Record<Level, Record<Reasoning, Record<Speed, string>>>;
  for (const level of LEVELS) {
    const entry = object(tiers[level]);
    enabled[level] = entry.enabled === "true";
    reasoningEnabled[level] = {} as Record<Reasoning, boolean>;
    models[level] = {} as Record<Reasoning, Record<Speed, string>>;
    available[level] = {} as Record<Reasoning, Record<Speed, boolean>>;
    for (const reasoning of REASONING) {
      const defined = object(object(entry.models)[reasoning]);
      reasoningEnabled[level][reasoning] = defined.enabled === "true";
      const dest = {} as Record<Speed, string>;
      const flags = {} as Record<Speed, boolean>;
      for (const speed of SPEEDS) {
        const v = defined[speed];
        const raw = typeof v === "string" ? v : "";
        if (raw && !modelName.test(raw)) throw new Error(`Некорректное имя модели в ${level}/${reasoning}/${speed}.`);
        dest[speed] = raw;
        flags[speed] = enabled[level] && reasoningEnabled[level][reasoning] && speedEnabled[speed] && !!raw;
      }
      models[level][reasoning] = dest;
      available[level][reasoning] = flags;
    }
  }
  return { enabled, reasoningEnabled, speedEnabled, custom, available, models, modelChoices, overrides };
}

export function publicModes() {
  const { enabled, reasoningEnabled, speedEnabled, custom, available, modelChoices } = configuration();
  // Never expose Ollama model names through this endpoint.
  return { levels: enabled, reasoning: reasoningEnabled, speed: speedEnabled, custom, available, modelChoices };
}
export function resolveMode(selection: string): string {
  const match = selector.exec(selection);
  if (!match) throw new Error("Неизвестный режим Forma.");
  const level = (legacyLevels[match[1]] || match[1]) as Level;
  const reasoning = match[2] as Reasoning;
  const speed = match[3] as Speed;
  const { enabled, reasoningEnabled, speedEnabled, models, modelChoices, overrides } = configuration();
  if (!enabled[level]) throw new Error("Этот уровень пока недоступен.");
  if (!reasoningEnabled[level][reasoning]) throw new Error(`Thinking Effort ${reasoning} отключён для ${level} в config/modes.yaml.`);
  if (!speedEnabled[speed]) throw new Error("Этот Speed заблокирован в config/modes.yaml.");
  if (match[4]) {
    if (!modelChoices[match[4]]?.enabled) throw new Error("Эта модель отключена в config/modes.yaml.");
    return overrides[match[4]];
  }
  const model = models[level][reasoning][speed];
  if (!model) throw new Error("Для этого режима не назначена модель. Заполните config/modes.yaml.");
  return model;
}
