// Dependency-free regression test for the *actual* streaming route implementation.
// This uses TypeScript's installed transpiler and replaces unrelated Express/DB
// dependencies with small fakes; no Ollama server is contacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = (() => {
  try { return require('typescript'); }
  catch { return require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); }
})();
const file = path.resolve('server/routes.ts');
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\r?\n/gm, '').replace('export async function registerRoutes', 'async function registerRoutes');

function fixture(chunks, { delay = 0 } = {}) {
  const state = new Map();
  const storage = {
    get: (_user, id) => state.get(id) ? structuredClone(state.get(id)) : undefined,
    update: (_user, id, patch) => {
      const updated = { ...state.get(id), ...structuredClone(patch) };
      state.set(id, updated);
      return structuredClone(updated);
    },
    settings: () => ({ system: '', temperature: 0.3, context: 8192 }),
  };
  state.set('chat', { id: 'chat', owner: 'u', title: 'Test', model: 'fixture', messages: [] });
  const valid = { min() { return this; }, max() { return this; }, regex() { return this; }, trim() { return this; }, safeParse(data) { return { success: true, data }; } };
  const z = { string: () => valid, object: () => valid };
  const handlers = new Map();
  const app = { use() {}, get() {}, put() {}, patch() {}, delete() {}, post(p, f) { handlers.set(p, f); } };
  const Readable = globalThis.ReadableStream;
  const fetch = async (_url, opts) => new Response(new Readable({
    start(c) {
      const write = () => { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(JSON.stringify(chunk) + '\n')); c.close(); };
      if (delay) setTimeout(write, delay); else write();
    },
  }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  const create = new Function('z', 'storage', 'randomUUID', 'sendSchema', 'checkOllama', 'normalizeOllamaUrl', 'ollamaUrl', 'previewMode', 'connectionError', 'registerComputerRoutes', 'registerAuthRoutes', 'currentUser', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', `const isFormaMode = () => false;\n${code}\nreturn registerRoutes;`);
  const route = create(z, storage, () => 'assistant-id', valid, () => {}, () => {}, () => 'http://localhost:11434', false, (e) => String(e?.message || e), () => {}, () => {}, () => ({id:'u'}), fetch,
    (fn, ms) => setInterval(fn, Math.min(ms, 25)), clearInterval, setTimeout, clearTimeout);
  const out = { text: '' };
  class FakeResponse extends EventEmitter {
    headersSent = false; destroyed = false; writableEnded = false;
    setHeader() {}
    flushHeaders() { this.headersSent = true; }
    write(chunk) { out.text += chunk; return true; }
    end() { this.writableEnded = true; this.emit('close'); }
    status(code) { out.status = code; return this; }
    json(value) { out.json = value; this.end(); }
  }
  return {
    state, out,
    async run() {
      await route({}, app);
      await handlers.get('/api/chats/:id/send')({ params: { id: 'chat' }, body: {content:'Hello',model:'fixture',retry:false} }, new FakeResponse());
      return { events: out.text.trim().split('\n').filter(Boolean).map(JSON.parse), saved: state.get('chat').messages };
    },
  };
}

test('thinking fragments reach the browser and persist alongside the final answer', async () => {
  const { events, saved } = await fixture([
    { message: { thinking: 'step1 ' } }, { message: { thinking: 'step2 ' } },
    { message: { content: 'Answer.' } }, { done: true },
  ]).run();
  assert.equal(events.filter(e => e.type === 'thinking').map(e => e.content).join(''), 'step1 step2 ');
  assert.equal(events.find(e => e.type === 'token').content, 'Answer.');
  assert.deepEqual(saved.at(-1).thinking, 'step1 step2 ');
  assert.equal(saved.at(-1).content, 'Answer.');
  assert.equal(events.at(-1).complete, true);
});

test('thinking-only response is saved and marked unfinished', async () => {
  const { events, saved } = await fixture([{ message: { thinking: 'Long thought' } }, { done: true }]).run();
  assert.equal(saved.at(-1).thinking, 'Long thought');
  assert.equal(saved.at(-1).interrupted, true);
  assert.equal(events.at(-1).complete, false);
  assert.match(events.find(e => e.type === 'error').message, /сохранены/);
});

test('truncated upstream keeps partial thinking and content', async () => {
  const { events, saved } = await fixture([{ message: { thinking: 'Partial thought' } }, { message: { content: 'Partial answer' } }]).run();
  assert.equal(saved.at(-1).thinking, 'Partial thought');
  assert.equal(saved.at(-1).content, 'Partial answer');
  assert.equal(saved.at(-1).interrupted, true);
  assert.equal(events.at(-1).complete, false);
});

test('idle stream stays alive using heartbeat events before first token', async () => {
  const { events } = await fixture([{ message: { content: 'Delayed answer' } }, { done: true }], {delay: 130}).run();
  assert.ok(events.some(e => e.type === 'heartbeat'), 'expected keepalive heartbeat during delayed model output');
  assert.equal(events.at(-1).complete, true);
});
