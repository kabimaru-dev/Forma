import type { Express, Request, Response } from "express";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import { sqlite } from "./storage";

sqlite.exec(`
 CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
`);

const COOKIE = "forma_session";
const TTL = 30 * 24 * 3600 * 1000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
}
function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, Buffer.from(salt, "hex"), 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
export function currentUser(req: Request): { id: string; username: string } | null {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const row = sqlite.prepare(
    "SELECT u.id AS id, u.username AS username, s.expires_at AS expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"
  ).get(sha(token)) as any;
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, username: row.username };
}
function startSession(res: Response, userId: string) {
  const token = randomBytes(32).toString("hex");
  sqlite.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  sqlite.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha(token), userId, Date.now() + TTL);
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL / 1000}`);
}

const credentials = z.object({
  username: z.string().trim().min(3, "Имя: от 3 символов.").max(32, "Имя: до 32 символов.").regex(/^[a-zA-Z0-9_.-]+$/, "Имя: латиница, цифры, _ . -"),
  password: z.string().min(8, "Пароль: от 8 символов.").max(200),
});
const fail = (res: Response, message: string, status = 400) => res.status(status).json({ message });

export function registerAuthRoutes(app: Express) {
  app.get("/api/auth/me", (req, res) => res.json({ user: currentUser(req) }));

  app.post("/api/auth/register", (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) return fail(res, parsed.error.issues[0].message);
    const { username, password } = parsed.data;
    if (sqlite.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) return fail(res, "Это имя уже занято.", 409);
    const isFirst = (sqlite.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n === 0;
    const id = randomUUID();
    sqlite.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run(id, username, hashPassword(password), Date.now());
    if (isFirst) {
      // первый аккаунт забирает всю старую общую историю и настройки
      sqlite.prepare("UPDATE chats SET owner = ? WHERE owner = 'local'").run(id);
      sqlite.prepare("UPDATE preferences SET owner = ? WHERE owner = 'local'").run(id);
    }
    startSession(res, id);
    res.status(201).json({ user: { id, username } });
  });

  app.post("/api/auth/login", (req, res) => {
    const parsed = z.object({ username: z.string().max(64), password: z.string().max(200) }).safeParse(req.body);
    if (!parsed.success) return fail(res, "Введите имя и пароль.");
    const row = sqlite.prepare("SELECT id, username, password_hash FROM users WHERE username = ?").get(parsed.data.username.trim()) as any;
    if (!row || !verifyPassword(parsed.data.password, row.password_hash)) return fail(res, "Неверное имя или пароль.", 401);
    startSession(res, row.id);
    res.json({ user: { id: row.id, username: row.username } });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) sqlite.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
    res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });
}