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
