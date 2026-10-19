import { storage } from "./storage";

export const previewMode = process.env.FORMA_PREVIEW === "true";
export function normalizeOllamaUrl(value: string): string {
  let raw = value.trim();
  if (!raw) raw = process.env.OLLAMA_URL || process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Укажите HTTP(S)-адрес Ollama без пароля, параметров и фрагмента.");
  }
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  if (url.pathname.replace(/\/$/, "") === "/api") url.pathname = "/";
  if (url.pathname !== "/") throw new Error("Нужен адрес сервера без /api/chat или /api/tags, например http://127.0.0.1:11434.");
  return url.origin;
}
export function ollamaUrl(owner: string) {
  return normalizeOllamaUrl(previewMode ? "" : storage.settings(owner).ollamaUrl);
}
export function connectionError(error: any, host: string) {
  const code = error?.cause?.code || error?.code;
  if (error?.name === "TimeoutError") return `Ollama по адресу ${host} не ответила за 8 секунд. Проверьте адрес и доступность сервера.`;
  if (["ECONNREFUSED", "ECONNRESET"].includes(code)) return `Соединение с ${host} отклонено (${code}). Сервер Forma работает, но по этому адресу нет доступной Ollama.`;
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return `Не удалось найти сервер ${host} (${code}). Проверьте имя хоста.`;
  return error?.message === "fetch failed" ? `Сервер Forma не смог обратиться к ${host}${code ? ` (${code})` : ""}.` : error?.message || "Не удалось подключиться к Ollama.";
}
export async function checkOllama(host: string) {
  try {
    const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(8000), redirect: "error" });
    if (!response.ok) throw new Error(`Ollama вернула HTTP ${response.status}. Проверьте адрес сервера.`);
    const json = await response.json().catch(() => { throw new Error("По этому адресу отвечает не Ollama: /api/tags вернул не JSON."); });
    if (!Array.isArray(json.models)) throw new Error("Ответ /api/tags не содержит списка моделей. Возможно, выбран другой сервер.");
    return { connected: true, backend: true, host, models: json.models, message: json.models.length ? `Найдено моделей: ${json.models.length}. Повторно скачивать их не нужно.` : "Ollama подключена, но список установленных моделей пуст.", editable: !previewMode, preview: previewMode };
  } catch (error) {
    return { connected: false, backend: true, host, models: [], message: connectionError(error, host), editable: !previewMode, preview: previewMode };
  }
}

// A local Ollama process may be stopped after sleep/reboot. For the default
// loopback endpoint only, Forma can launch an already-installed Ollama CLI.
// It never installs software, changes service definitions or starts remote hosts.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

let localRunner: ChildProcess | null = null;
let lastLaunch = 0;
let launchError = "";
const lastGood = new Map<string, { at: number; models: any[] }>();
const failures = new Map<string, number>();
const localOllamaHost = (host: string) => ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"].includes(host);

export function ensureLocalOllama(host: string): boolean {
  if (previewMode || !localOllamaHost(host) || process.env.FORMA_OLLAMA_AUTOSTART === "false") return false;
  if (localRunner && localRunner.exitCode === null && !localRunner.killed) return true;
  if (Date.now() - lastLaunch < 30000) return false;
  lastLaunch = Date.now();
  const candidate = [process.env.OLLAMA_BINARY, "/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"].find(p => p && existsSync(p));
  try {
    const child = spawn(candidate || "ollama", ["serve"], {
      stdio: "ignore", windowsHide: true,
      env: { ...process.env, OLLAMA_HOST: "127.0.0.1:11434" },
    });
    localRunner = child;
    launchError = "";
    child.on("error", error => {
      launchError = `Не удалось автоматически запустить Ollama: ${error.message}`;
      console.warn("Forma Ollama autostart:", error.message);
      if (localRunner === child) localRunner = null;
    });
    child.on("exit", (code, signal) => {
      if (localRunner === child) localRunner = null;
      if (code !== 0 && code !== null) launchError = `Ollama завершилась с кодом ${code}.`;
    });
    return true;
  } catch (error: any) {
    launchError = `Не удалось автоматически запустить Ollama: ${error.message}`;
    return false;
  }
}

export async function reconnectingStatus(host: string) {
  const status = await checkOllama(host);
  if (status.connected) {
    lastGood.set(host, { at: Date.now(), models: status.models });
    failures.delete(host);
    return { ...status, reconnecting: false };
  }
  const failureCount = (failures.get(host) || 0) + 1;
  failures.set(host, failureCount);
  const shouldLaunch = /ECONNREFUSED|ECONNRESET|fetch failed/.test(status.message);
  if (shouldLaunch) ensureLocalOllama(host);
  // A single slow /api/tags probe during model loading is not a disconnect.
  const previous = lastGood.get(host);
  if (previous && failureCount === 1 && Date.now() - previous.at < 120000) {
    return { ...status, connected: true, models: previous.models, reconnecting: true, message: "Проверяем связь с Ollama; повторное подключение выполняется автоматически." };
  }
  return { ...status, reconnecting: true, message: launchError ? `${status.message} ${launchError}` : status.message };
}
