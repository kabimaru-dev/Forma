// Preload the REAL Ollama runner with the selected num_ctx, not a UI-only state.
// Ollama accepts an empty messages array on /api/chat to load the model.
const loaded = new Map<string, { context: number; until: number }>();
const pending = new Map<string, Promise<void>>();
export async function preloadModel(host: string, model: string, context: number): Promise<void> {
  const key = JSON.stringify([host, model]);
  const cached = loaded.get(key);
  if (cached?.context === context && cached.until > Date.now()) return;
  const inflight = pending.get(key);
  if (inflight) {
    await inflight;
    if (loaded.get(key)?.context === context && (loaded.get(key)?.until ?? 0) > Date.now()) return;
  }
  const job = (async () => {
    const response = await fetch(`${host}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5 * 60 * 1000),
      body: JSON.stringify({ model, messages: [], stream: false, keep_alive: "10m", options: { num_ctx: context } }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error?.error || `Ollama не загрузила модель (${response.status}).`);
    }
    const payload = await response.json();
    if (!payload || payload.error || payload.done !== true || (payload.done_reason && payload.done_reason !== "load"))
      throw new Error(payload?.error || "Ollama не подтвердила загрузку модели.");
    loaded.set(key, { context, until: Date.now() + 5 * 60 * 1000 });
  })();
  pending.set(key, job);
  try { await job; } finally { if (pending.get(key) === job) pending.delete(key); }
}

// If a context change was already being prepared in the background, wait for
// that runner to settle before starting another /api/chat for the same model.
// Never fail the user's generation solely because an optional preload failed.
export async function waitForModelPreload(host: string, model: string, signal: AbortSignal): Promise<void> {
  const inflight = pending.get(JSON.stringify([host, model]));
  if (!inflight || signal.aborted) return;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<void>(resolve => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { await Promise.race([inflight.catch(() => {}), interrupted]); }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}
