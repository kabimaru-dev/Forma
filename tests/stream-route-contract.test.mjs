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
  const generatedCounts = new Map();
  const generatedUsage = {
    record(chatId, messageId, nGen) { generatedCounts.set(`${chatId}/${messageId}`, nGen); },
    summarize(chat) {
      let knownNGen = 0, missing = 0;
      for (const message of chat.messages) {
        if (message.role !== 'assistant') continue;
        const n = generatedCounts.get(`${chat.id}/${message.id}`);
        if (n === undefined) missing++; else knownNGen += n;
      }
      return { nGen: missing ? null : knownNGen, knownNGen, missing };
    },
    remove(chatId) { for (const key of generatedCounts.keys()) if (key.startsWith(chatId + '/')) generatedCounts.delete(key); },
  };
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
  const valid = { min() { return this; }, max() { return this; }, regex() { return this; }, trim() { return this; }, int() { return this; }, strict() { return this; }, safeParse(data) { return { success: true, data }; } };
  const z = { string: () => valid, object: () => valid, number: () => valid, union: () => valid };
  const handlers = new Map();
  const app = { use() {}, get(p, f) { handlers.set(p, f); }, put() {}, patch(p, f) { handlers.set(p, f); }, delete() {}, post(p, f) { handlers.set(p, f); } };
  const Readable = globalThis.ReadableStream;
  let lastRequest = null;
  let tokenCalls = 0;
  const fetch = async (_url, opts) => {
    lastRequest = JSON.parse(opts.body);
    if (lastRequest.stream === false) {
      tokenCalls++;
      return new Response(JSON.stringify({ prompt_eval_count: 420, eval_count: 1 }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(new Readable({
      start(c) {
        const write = () => { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(JSON.stringify(chunk) + '\n')); c.close(); };
        if (delay) setTimeout(write, delay); else write();
      },
    }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  };
  const create = new Function('generatedUsage', 'contextWindows', 'preloadModel', 'waitForModelPreload', 'z', 'storage', 'randomUUID', 'sendSchema', 'checkOllama', 'normalizeOllamaUrl', 'ollamaUrl', 'previewMode', 'connectionError', 'registerComputerRoutes', 'registerAuthRoutes', 'currentUser', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', `const isFormaMode = () => false;\n${code}\nreturn registerRoutes;`);
  const contextWindows = {
    current: (_id, _model, settings) => settings.context,
    display: (_id, settings) => settings.context,
    record: () => ({ changed: false }),
    remove() {},
  };
  const route = create(generatedUsage, contextWindows, async () => {}, async () => {}, z, storage, () => 'assistant-id', valid, () => {}, () => {}, () => 'http://localhost:11434', false, (e) => String(e?.message || e), () => {}, () => {}, () => ({id:'u'}), fetch,
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
    state, out, generatedUsage,
    get lastRequest() { return lastRequest; },
    get tokenCalls() { return tokenCalls; },
    async runEdit(messages, messageId, body) {
      if (messages) state.set('chat', { ...state.get('chat'), messages: structuredClone(messages) });
      await route({}, app);
      await handlers.get('/api/chats/:id/messages/:messageId')({ params: { id: 'chat', messageId }, body }, new FakeResponse());
      return { result: out.json, status: out.status, saved: state.get('chat').messages };
    },
    async runTokens(messages) {
      const saved = { ...state.get('chat'), messages: structuredClone(messages) };
      state.set('chat', saved);
      await route({}, app);
      await handlers.get('/api/chats/:id/tokens')({ params: { id: 'chat' } }, new FakeResponse());
      return { response: out.json, status: out.status, saved: state.get('chat') };
    },
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

test('n_gen is read from Ollama eval_count, not prompt_eval_count, and persisted outside messages', async () => {
  const f = fixture([
    { message: { content: 'Ready.' } },
    { done: true, prompt_eval_count: 153, eval_count: 41 },
  ]);
  const { events, saved } = await f.run();
  assert.deepEqual(events.find(e => e.type === 'usage'), { type: 'usage', n_gen: 41 });
  assert.equal(events.at(-1).type, 'done');
  assert.equal(saved.at(-1).usage, undefined);
  const { response } = await f.runTokens(saved);
  assert.deepEqual(response, { tokens: 41, knownTokens: 41, missing: 0, context: 8192 });
  assert.equal(f.tokenCalls, 0, 'reading usage must not generate tokens with Ollama');
});

test('eval_count alone is sufficient without any prompt token count', async () => {
  const f = fixture([{ message: { content: 'Done.' } }, { done: true, eval_count: 77 }]);
  const { events, saved } = await f.run();
  assert.deepEqual(events.find(e => e.type === 'usage'), { type: 'usage', n_gen: 77 });
  const { response } = await f.runTokens(saved);
  assert.equal(response.tokens, 77);
});

test('old replies without original n_gen remain unknown, never counted by a new generation', async () => {
  const items = [
    { id: 'old-user', role: 'user', content: 'Old message' },
    { id: 'old-assistant', role: 'assistant', content: 'Old reply' },
  ];
  const f = fixture([]);
  const { response, saved } = await f.runTokens(items);
  assert.deepEqual(response, { tokens: null, knownTokens: 0, missing: 1, context: 8192 });
  assert.deepEqual(saved.messages, items);
  assert.equal(f.tokenCalls, 0);
});

test('partially known history does not pretend to have a complete n_gen', async () => {
  const f = fixture([]);
  f.generatedUsage.record('chat', 'new-assistant', 41);
  const { response } = await f.runTokens([
    { id: 'old-assistant', role: 'assistant', content: 'Old reply' },
    { id: 'new-assistant', role: 'assistant', content: 'New reply' },
  ]);
  assert.deepEqual(response, { tokens: null, knownTokens: 41, missing: 1, context: 8192 });
});

test('no fabricated usage if Ollama provides no eval_count', async () => {
  const f = fixture([{ message: { content: 'Done.' } }, { done: true }]);
  const { events, saved } = await f.run();
  assert.equal(events.find(e => e.type === 'usage'), undefined);
  const { response } = await f.runTokens(saved);
  assert.equal(response.tokens, null);
  assert.equal(response.missing, 1);
});

test('empty chat reports 0 without asking Ollama', async () => {
  const f = fixture([]);
  const { response } = await f.runTokens([]);
  assert.deepEqual(response, { tokens: 0, knownTokens: 0, missing: 0, context: 8192 });
  assert.equal(f.tokenCalls, 0);
});


test('editing user and assistant messages persists revisions and selected version in chat storage', async () => {
  const f = fixture([]);
  const original = [
    {id:'one',role:'user',content:'Original question'},
    {id:'two',role:'assistant',content:'First response',model:'fixture'},
  ];
  let result = await f.runEdit(original, 'one', { content: 'Edited question' });
  assert.equal(result.saved[0].content, 'Edited question');
  assert.deepEqual(result.saved[0].revisions, ['Original question', 'Edited question']);
  result = await f.runEdit(null, 'two', { content: 'Revised answer' });
  assert.equal(result.saved[1].content, 'Revised answer');
  assert.equal(result.saved[1].model, 'fixture');
  result = await f.runEdit(null, 'one', { revisionIndex: 0 });
  assert.equal(result.saved[0].content, 'Original question');
  assert.deepEqual(result.saved[0].revisions, ['Original question','Edited question']);
  result = await f.runEdit(null, 'one', { revisionIndex: 1 });
  assert.equal(result.saved[0].content, 'Edited question');
});
