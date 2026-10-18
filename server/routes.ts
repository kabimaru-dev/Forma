import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { storage } from "./storage";
import { sendSchema, settingsSchema, type Message } from "@shared/schema";
import { checkOllama, normalizeOllamaUrl, ollamaUrl, previewMode, connectionError } from "./ollama";
import { registerComputerRoutes } from "./computer";
import { registerAuthRoutes, currentUser } from "./auth";
import { isFormaMode, publicModes, resolveMode } from "./modes";
import { generatedUsage } from "./generatedUsage";
import { contextWindows } from "./contextWindows";
import { preloadModel, waitForModelPreload } from "./modelPreload";

const owner = (req: Request) => currentUser(req)!.id;
const active = new Map<string, AbortController>();
const unavailable = "Ollama недоступна. Запустите Ollama на компьютере, где работает сервер Forma, и проверьте подключение.";
const modelSchema = z.string().min(1).max(150).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/, "Проверьте имя модели");
function fail(res: Response, message: string, status = 400) { res.status(status).json({ message }); }
function streamHeaders(res: Response) {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}
async function readLines(response: globalThis.Response, onLine: (line: any) => void) {
  if (!response.body) throw new Error("Сервер не вернул поток ответа.");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as any) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n"); buffer = lines.pop() || "";
    for (const line of lines) if (line.trim()) onLine(JSON.parse(line));
  }
  buffer += decoder.decode();
  if (buffer.trim()) onLine(JSON.parse(buffer));
}
export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  registerAuthRoutes(app);
  app.use("/api", (req, res, next) => {
    if (!currentUser(req)) return fail(res, "Войдите в аккаунт.", 401);
    next();
  });
  app.post("/api/connection", async (req, res) => {
    if (previewMode) return fail(res, "В облачном превью локальные адреса недоступны. Запустите полный проект на своём компьютере.", 403);
    const parsed = z.object({ url: z.string().min(1).max(500) }).safeParse(req.body);
    if (!parsed.success) return fail(res, "Укажите адрес Ollama.");
    try {
      const url = normalizeOllamaUrl(parsed.data.url);
      const status = await checkOllama(url);
      if (status.connected) storage.saveSettings(owner(req), { ...storage.settings(owner(req)), ollamaUrl: url });
      res.json({ ...status, saved: status.connected });
    } catch (error: any) { fail(res, error.message); }
  });
  app.get("/api/modes", (_req, res) => {
    try { res.json(publicModes()); }
    catch { fail(res, "Не удалось прочитать config/modes.yaml. Проверьте файл на сервере.", 500); }
  });
  app.get("/api/settings", (req, res) => res.json(storage.settings(owner(req))));
  app.put("/api/settings", (req, res) => {
    const result = settingsSchema.safeParse(req.body);
    if (!result.success) return fail(res, "Проверьте параметры генерации.");
    if (result.data.ollamaUrl) {
      if (previewMode && result.data.ollamaUrl !== storage.settings(owner(req)).ollamaUrl) return fail(res, "Адрес Ollama нельзя менять в облачном превью.", 403);
      try { result.data.ollamaUrl = normalizeOllamaUrl(result.data.ollamaUrl); } catch (e: any) { return fail(res, e.message); }
    }
    res.json(storage.saveSettings(owner(req), result.data));
  });
  app.get("/api/chats", (req, res) => {
    res.json(storage.list(owner(req)).map(({ owner: _, messages, ...chat }) => ({ ...chat, preview: messages.map(m => m.content).join(" "), count: messages.length })));
  });
  app.post("/api/chats", (req, res) => {
    const result = z.object({ title: z.string().min(1).max(120), model: z.string().max(150) }).safeParse(req.body);
    if (!result.success) return fail(res, "Некорректные данные чата.");
    const { owner: _, ...chat } = storage.create(owner(req), result.data.title, result.data.model);
    res.status(201).json(chat);
  });
  app.get("/api/chats/:id", (req, res) => {
    const chat = storage.get(owner(req), String(req.params.id));
    if (!chat) return fail(res, "Чат не найден.", 404);
    const { owner: _, ...result } = chat; res.json(result);
  });
  app.patch("/api/chats/:id", (req, res) => {
    const result = z.object({ title: z.string().trim().min(1).max(120) }).safeParse(req.body);
    if (!result.success) return fail(res, "Название должно содержать от 1 до 120 символов.");
    const chat = storage.update(owner(req), String(req.params.id), result.data);
    if (!chat) return fail(res, "Чат не найден.", 404);
    res.json({ title: chat.title });
  });
  app.patch("/api/chats/:id/messages/:messageId", (req, res) => {
    const id = String(req.params.id), messageId = String(req.params.messageId);
    const who = owner(req);
    if (active.has(id)) return fail(res, "Дождитесь завершения генерации перед редактированием.", 409);
    const chat = storage.get(who, id);
    if (!chat) return fail(res, "Чат не найден.", 404);
    const parsed = z.union([
      z.object({ content: z.string().trim().min(1).max(100000) }).strict(),
      z.object({ revisionIndex: z.number().int().min(0) }).strict(),
    ]).safeParse(req.body);
    if (!parsed.success) return fail(res, "Введите текст сообщения или номер сохранённой редакции.");
    const index = chat.messages.findIndex(m => m.id === messageId);
    if (index < 0) return fail(res, "Сообщение не найдено.", 404);
    const original = chat.messages[index];
    const revisions = original.revisions?.length ? [...original.revisions] : [original.content];
    let revisionIndex: number;
    if ("content" in parsed.data) {
      const content = parsed.data.content;
      if (!content) return fail(res, "Текст не может быть пустым.");
      if (content === original.content) return res.json({ message: original });
      revisions.push(content);
      revisionIndex = revisions.length - 1;
    } else {
      revisionIndex = parsed.data.revisionIndex;
      if (revisionIndex >= revisions.length) return fail(res, "Такой редакции нет.", 400);
    }
    const message: Message = { ...original, content: revisions[revisionIndex], revisions, revisionIndex };
    const messages = [...chat.messages];
    messages[index] = message;
    storage.update(who, id, { messages });
    res.json({ message });
  });
  app.delete("/api/chats/:id", (req, res) => {
    const id = String(req.params.id);
    if (!storage.get(owner(req), id)) return fail(res, "Чат не найден.", 404);
    if (active.has(id)) return fail(res, "Сначала остановите ответ.", 409);
    storage.delete(owner(req), id);
    // Usage is stored outside SQLite; remove its sidecar entry on chat deletion.
    try { generatedUsage.remove(id); } catch (e) { console.warn("Forma usage cleanup failed:", e); }
    try { contextWindows.remove(id); } catch (e) { console.warn("Forma context cleanup failed:", e); }
    res.json({ ok: true });
  });
  // n_gen is llama.cpp's generated-token count. Ollama's /api/chat calls
  // expose this as eval_count in the final response, NOT prompt_eval_count.
  // The original n_gen of old completions cannot be recovered from Ollama
  // after the fact. Never generate a new response to fake that old metric.
  app.get("/api/chats/:id/tokens", (req, res) => {
    const chat = storage.get(owner(req), String(req.params.id));
    if (!chat) return fail(res, "Чат не найден.", 404);
    const { nGen, knownNGen, missing } = generatedUsage.summarize(chat);
    res.json({ tokens: nGen, knownTokens: knownNGen, missing, context: contextWindows.display(chat.id, storage.settings(owner(req))) });
  });
  app.get("/api/chats/:id/export", (req, res) => {
    const chat = storage.get(owner(req), String(req.params.id));
    if (!chat) return fail(res, "Чат не найден.", 404);
    res.setHeader("Content-Disposition", `attachment; filename="forma-chat.md"; filename*=UTF-8''${encodeURIComponent(chat.title + ".md").replace(/'/g, "%27")}`);
    res.type("text/markdown").send(`# ${chat.title}\n\n${chat.messages.map(m => `## ${m.role === "user" ? "Вы" : m.model || "Forma"}\n\n${m.content}${m.thinking ? `\n\n<details><summary>Ход рассуждений</summary>\n\n${m.thinking}\n\n</details>` : ""}${m.interrupted ? "\n\n[Ответ остановлен]" : ""}`).join("\n\n")}\n`);
  });
  app.post("/api/chats/:id/stop", async (req, res) => {
    const id = String(req.params.id);
    if (!storage.get(owner(req), id)) return fail(res, "Чат не найден.", 404);
    active.get(id)?.abort();
    for (let i = 0; active.has(id) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 25));
    res.json({ ok: !active.has(id) });
  });
  app.post("/api/chats/:id/send", async (req, res) => {
    const id = String(req.params.id), who = owner(req);
    const OLLAMA = ollamaUrl(who);
    const chat = storage.get(who, id);
    if (!chat) return fail(res, "Чат не найден.", 404);
    const result = sendSchema.safeParse(req.body);
    if (!result.success || !modelSchema.safeParse(result.data?.model).success) return fail(res, "Выберите модель и проверьте сообщение.");
    if (active.has(id)) return fail(res, "Дождитесь завершения текущего ответа.", 409);
    const { content, model, retry } = result.data;
    let upstreamModel = model;
    if (isFormaMode(model)) {
      try { upstreamModel = resolveMode(model); }
      catch (error: any) { return fail(res, error?.message || "Режим не настроен.", 422); }
    }
    let messages = [...chat.messages];
    if (retry) {
      while (messages.at(-1)?.role === "assistant") messages.pop();
      if (messages.at(-1)?.role !== "user") return fail(res, "Нет сообщения для повторного ответа.");
    } else {
      if (!content.trim()) return fail(res, "Введите сообщение.");
      messages.push({ id: randomUUID(), role: "user", content });
    }
    storage.update(who, id, { messages, model });
    const controller = new AbortController();
    active.set(id, controller);
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    const assistant: Message = { id: randomUUID(), role: "assistant", content: "", model };
    let complete = false, errorMessage = "";
    let nGen: number | null = null;
    let promptTokens: number | null = null;
    let usedContext = 0;
    let contextSettings: ReturnType<typeof storage.settings> | undefined;
    let lastSave = Date.now();
    // Save long-running streams periodically. A browser/network disconnect must
    // not erase everything the model has already generated.
    const persistPartial = () => {
      if (!assistant.content && !assistant.thinking) return;
      storage.update(who, id, { messages: [...messages, { ...assistant, interrupted: !complete }], model });
      lastSave = Date.now();
    };
    const forward = (value: object) => {
      if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(value) + "\n");
    };
    // Keep the browser and reverse proxies from treating long reasoning phases
    // (or model load time) as an idle request.
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    // Only time out after 5 minutes without an upstream token. A fixed 15-minute
    // wall-clock limit prematurely aborts legitimate long-running answers.
    let inactivity: ReturnType<typeof setTimeout> | undefined;
    let inactivityExpired = false;
    const resetInactivity = () => {
      if (inactivity) clearTimeout(inactivity);
      inactivity = setTimeout(() => { inactivityExpired = true; controller.abort(); }, 5 * 60 * 1000);
    };
    // A model can take a while to load before responding; bound that phase too.
    resetInactivity();
    try {
      // Start the browser stream before Ollama spends time loading the model.
      // This avoids a silent connection while preparing a large context window.
      streamHeaders(res);
      forward({ type: "start", messages, assistantId: assistant.id });
      heartbeat = setInterval(() => forward({ type: "heartbeat" }), 5000);
      const settings = storage.settings(who);
      contextSettings = settings;
      usedContext = contextWindows.current(id, upstreamModel, settings);
      // A real /api/chat request loads the runner implicitly. Previously, an
      // extra empty /api/chat was sent *before every message*, leading to
      // needless model reloads and apparent reconnects.
      // An already-running background preload is allowed to settle first.
      await waitForModelPreload(OLLAMA, upstreamModel, controller.signal);
      const upstream = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: upstreamModel, stream: true,
          messages: [
            ...(settings.system ? [{ role: "system", content: settings.system }] : []),
            ...messages.filter(m => m.content).map(({ role, content }) => ({ role, content })),
          ],
          options: { temperature: settings.temperature, num_ctx: usedContext },
          keep_alive: "10m",
        }),
      });
      if (!upstream.ok) {
        const info = await upstream.json().catch(() => ({}));
        throw new Error(info.error || `Ollama вернула ошибку ${upstream.status}.`);
      }
      forward({ type: "context", context: usedContext });
      await readLines(upstream, event => {
        resetInactivity();
        if (event.error) throw new Error(event.error);
        if (typeof event.message?.thinking === "string" && event.message.thinking) {
          assistant.thinking = (assistant.thinking || "") + event.message.thinking;
          forward({ type: "thinking", content: event.message.thinking });
        }
        if (typeof event.message?.content === "string" && event.message.content) {
          assistant.content += event.message.content;
          forward({ type: "token", content: event.message.content });
        }
        if (event.done) {
          complete = true;
          // The authoritative generated-token count: llama.cpp n_gen maps to
          // Ollama eval_count. Do not replace it with prompt_eval_count.
          if (Number.isSafeInteger(event.prompt_eval_count) && event.prompt_eval_count >= 0) promptTokens = event.prompt_eval_count;
          if (Number.isSafeInteger(event.eval_count) && event.eval_count >= 0) {
            nGen = event.eval_count;
            forward({ type: "usage", n_gen: nGen });
          }
        }
        if ((assistant.content || assistant.thinking) && Date.now() - lastSave >= 2000) persistPartial();
      });
      if (!complete) throw new Error("Поток оборвался до завершения ответа. Полученная часть сохранена.");
      if (!assistant.content.trim()) throw new Error("Модель не сформировала окончательный ответ. Её рассуждения сохранены в истории.");
    } catch (error: any) {
      errorMessage = inactivityExpired ? "Ollama не присылала данные более пяти минут. Полученная часть сохранена."
        : controller.signal.aborted ? "Ответ остановлен. Полученная часть сохранена."
        : isFormaMode(model)
          ? "Ошибка режима Forma. Проверьте назначенную модель в config/modes.yaml и доступность Ollama."
          : connectionError(error, OLLAMA);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (inactivity) clearTimeout(inactivity);
      // The data was kept even when the final response never arrived.
      if (assistant.content || assistant.thinking) messages.push({ ...assistant, interrupted: !complete || !!errorMessage });
      storage.update(who, id, { messages, model });
      if (complete && !errorMessage && nGen !== null && (assistant.content || assistant.thinking)) {
        try { generatedUsage.record(id, assistant.id, nGen); }
        catch (e) { console.warn("Forma could not persist Ollama n_gen:", e); }
      }
      // After a completed reply, advance the window for the NEXT turn using
      // Ollama's actual prompt and generation counters (not estimates).
      let nextContext: number | null = null;
      if (complete && !errorMessage && contextSettings && promptTokens !== null && nGen !== null) {
        try {
          const transition = contextWindows.record(id, upstreamModel, contextSettings, promptTokens, nGen);
          if (transition.changed) nextContext = transition.after;
        } catch (e) { console.warn("Forma context metadata write failed:", e); }
      }
      active.delete(id);
      if (!res.destroyed) {
        if (errorMessage) forward({ type: "error", message: errorMessage });
        if (nextContext !== null) forward({ type: "context", context: nextContext });
        forward({ type: "done", complete: complete && !errorMessage });
        res.end();
      }
      // Start actual preloading only AFTER the stream has ended: no concurrent
      // runner reload during a response. The next send waits for this preload.
      if (nextContext !== null && active.size === 0) void preloadModel(OLLAMA, upstreamModel, nextContext)
        .catch(e => console.warn("Forma next context preload failed:", e));
    }
  });
  app.post("/api/models/pull", async (req, res) => {
    const OLLAMA = ollamaUrl(owner(req));
    const result = z.object({ model: modelSchema }).safeParse(req.body);
    if (!result.success) return fail(res, "Введите корректное имя модели из библиотеки Ollama.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2 * 60 * 60 * 1000);
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    try {
      const upstream = await fetch(`${OLLAMA}/api/pull`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: result.data.model, stream: true }), signal: controller.signal });
      if (!upstream.ok) throw new Error("Не удалось начать загрузку. Проверьте имя модели и соединение.");
      streamHeaders(res);
      await readLines(upstream, event => { if (!res.destroyed) res.write(JSON.stringify(event) + "\n"); });
    } catch (e: any) {
      const message = controller.signal.aborted ? "Загрузка отменена." : connectionError(e, OLLAMA);
      if (!res.destroyed) {
        if (!res.headersSent) fail(res, message, 422);
        else res.write(JSON.stringify({ error: message }) + "\n");
      }
    } finally { clearTimeout(timeout); if (!res.destroyed) res.end(); }
  });
  registerComputerRoutes(app, owner);
  app.use("/api", (_req, res) => fail(res, "API-маршрут не найден. Проверьте версии клиента и сервера Forma.", 404));
  return httpServer;
}
