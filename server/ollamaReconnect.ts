// Network-only reconnection. HTTP model errors must not trigger another generation.
// Retry limits prevent the server from producing unbounded duplicate requests.
export function retryableOllamaFailure(error: unknown): boolean {
  const value = error as { name?: string; code?: string; cause?: { code?: string }; message?: string } | null;
  if (!value || value.name === "AbortError") return false;
  const code = value.cause?.code || value.code || "";
  if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code)) return true;
  return value.message === "fetch failed" || value.message === "Поток Ollama оборвался до завершения ответа.";
}

export function reconnectDelay(attempt: number): number {
  return Math.min(4000, 700 * 2 ** Math.max(0, attempt - 1));
}

export async function cancellablePause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw Object.assign(new Error("Отменено"), { name: "AbortError" });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    const cancel = () => { clearTimeout(timer); reject(Object.assign(new Error("Отменено"), { name: "AbortError" })); };
    signal.addEventListener("abort", cancel, { once: true });
  });
}
