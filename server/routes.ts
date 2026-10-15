import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { storage } from "./storage";
import { sendSchema, settingsSchema, type Message } from "@shared/schema";
import { checkOllama, normalizeOllamaUrl, ollamaUrl, previewMode, connectionError } from "./ollama";
import { registerComputerRoutes } from "./computer";
import { registerAuthRoutes, currentUser } from "./auth";

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
  app.delete("/api/chats/:id", (req, res) => {
    const id = String(req.params.id);
    if (!storage.get(owner(req), id)) return fail(res, "Чат не найден.", 404);
    if (active.has(id)) return fail(res, "Сначала остановите ответ.", 409);
    storage.delete(owner(req), id); res.json({ ok: true });
  });
  app.get("/api/chats/:id/export", (req, res) => {
    const chat = storage.get(owner(req), String(req.params.id));
    if (!chat) return fail(res, "Чат не найден.", 404);
    res.setHeader("Content-Disposition", `attachment; filename="forma-chat.md"; filename*=UTF-8''${encodeURIComponent(chat.title + ".md").replace(/'/g, "%27")}`);
    res.type("text/markdown").send(`# ${chat.title}\n\n${chat.messages.map(m => `## ${m.role === "user" ? "Вы" : m.model || "Forma"}\n\n${m.content}${m.interrupted ? "\n\n[Ответ остановлен]" : ""}`).join("\n\n")}\n`);
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
    const timeout = setTimeout(() => controller.abort(), 15 * 60 * 1000);
    try {
      const settings = storage.settings(who);
      const upstream = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model, stream: true,
          messages: [
            ...(settings.system ? [{ role: "system", content: settings.system }] : []),
            ...messages.filter(m => m.content).map(({ role, content }) => ({ role, content })),
          ],
          options: { temperature: settings.temperature, num_ctx: settings.context },
        }),
      });
      if (!upstream.ok) {
        const info = await upstream.json().catch(() => ({}));
        throw new Error(info.error || `Ollama вернула ошибку ${upstream.status}.`);
      }
      streamHeaders(res);
      res.write(JSON.stringify({ type: "start", messages, assistantId: assistant.id }) + "\n");
      await readLines(upstream, event => {
        if (event.error) throw new Error(event.error);
        if (event.message?.content) {
          assistant.content += event.message.content;
          if (!res.destroyed) res.write(JSON.stringify({ type: "token", content: event.message.content }) + "\n");
        }
        if (event.done) complete = true;
      });
      if (!complete) throw new Error("Поток оборвался до завершения ответа. Попробуйте ещё раз.");
      if (!assistant.content.trim()) throw new Error("Модель вернула пустой ответ. Попробуйте другую модель или измените запрос.");
    } catch (error: any) {
      errorMessage = controller.signal.aborted ? "Ответ остановлен." : connectionError(error, OLLAMA);
    } finally {
      clearTimeout(timeout);
      if (assistant.content) messages.push({ ...assistant, interrupted: !complete });
      storage.update(who, id, { messages, model });
      active.delete(id);
      if (!res.destroyed) {
        if (!res.headersSent && errorMessage) fail(res, errorMessage, 422);
        else {
          if (errorMessage) res.write(JSON.stringify({ type: "error", message: errorMessage }) + "\n");
          res.write(JSON.stringify({ type: "done" }) + "\n");
          res.end();
        }
      }
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
