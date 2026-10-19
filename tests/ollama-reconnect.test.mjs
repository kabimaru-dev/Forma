import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = (() => { try { return require('typescript'); } catch { return require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); } })();
function moduleCode(path, exports) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(`${code.replaceAll(/^export /gm, '')}\nreturn { ${exports.join(', ')} };`)();
}
const reconnect = moduleCode('../server/ollamaReconnect.ts', ['retryableOllamaFailure','reconnectDelay','cancellablePause']);
test('only transport failures are retried (not model failures or user abort)', () => {
  assert.equal(reconnect.retryableOllamaFailure(new Error('fetch failed')), true);
  assert.equal(reconnect.retryableOllamaFailure({cause:{code:'ECONNRESET'}}), true);
  assert.equal(reconnect.retryableOllamaFailure(new Error('Поток Ollama оборвался до завершения ответа.')), true);
  assert.equal(reconnect.retryableOllamaFailure(new Error('Ollama вернула ошибку 404.')), false);
  assert.equal(reconnect.retryableOllamaFailure({ name: 'AbortError', message: 'fetch failed' }), false);
  assert.equal(reconnect.reconnectDelay(50), 4000);
});
test('reconnect wait can be cancelled without starting another generation', async () => {
  const ctrl = new AbortController();
  const wait = reconnect.cancellablePause(200, ctrl.signal);
  ctrl.abort();
  await assert.rejects(wait, { name:'AbortError' });
});
test('status endpoint is registered before fallback and supplies the current user URL', () => {
  const routes = readFileSync(new URL('../server/routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /app\.get\("\/api\/status", async \(req, res\) =>/);
  assert.ok(routes.indexOf('app.get("/api/status"') < routes.indexOf('app.use("/api", (_req, res)'));
  assert.match(routes, /reconnectingStatus\(ollamaUrl\(owner\(req\)\)\)/);
});
test('frontend polls every 3 seconds while offline and retains the existing version', () => {
  const app = readFileSync(new URL('../client/src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /refetchInterval: query => busy \? false : .*3000/);
  assert.match(app, /Восстанавливаем Ollama/);
  assert.match(app, /v5\.5/);
});

test('recovering status tolerates one slow probe then observes real downtime and recovery', async () => {
  const file = readFileSync(new URL('../server/ollama.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(file, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const code = compiled.replace(/^import .*;\r?\n/gm, '').replaceAll(/^export /gm, '');
  let connected = true;
  const fakeFetch = async () => {
    if (!connected) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return new Response(JSON.stringify({ models: [{ name: 'mock-model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const fakeProcess = { env: { FORMA_OLLAMA_AUTOSTART: 'false' } };
  const init = new Function('storage', 'spawn', 'existsSync', 'process', 'fetch', 'AbortSignal', 'Response',
    `${code}\nreturn { reconnectingStatus, ensureLocalOllama };`);
  const health = init({}, () => {throw new Error('unexpected spawn');}, () => false, fakeProcess, fakeFetch, AbortSignal, Response);
  const host = 'http://127.0.0.1:11434';
  let result = await health.reconnectingStatus(host);
  assert.equal(result.connected, true);
  assert.equal(result.reconnecting, false);
  connected = false;
  result = await health.reconnectingStatus(host);
  assert.equal(result.connected, true, 'first temporary failure must not flicker offline');
  assert.equal(result.reconnecting, true);
  result = await health.reconnectingStatus(host);
  assert.equal(result.connected, false, 'second failure must reflect the outage');
  connected = true;
  result = await health.reconnectingStatus(host);
  assert.equal(result.connected, true);
  assert.equal(result.reconnecting, false);
  assert.equal(result.models[0].name, 'mock-model');
});

test('local Ollama autostart is single-instance and never starts remote servers', () => {
  const src = readFileSync(new URL('../server/ollama.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/^import .*;\r?\n/gm, '').replaceAll(/^export /gm, '');
  let launches = 0;
  const fakeChild = { exitCode: null, killed: false, on() { return this; } };
  const spawn = (binary, args, config) => {
    launches++;
    assert.equal(binary, '/opt/homebrew/bin/ollama');
    assert.deepEqual(args, ['serve']);
    assert.equal(config.env.OLLAMA_HOST, '127.0.0.1:11434');
    return fakeChild;
  };
  const init = new Function('storage','spawn','existsSync','process','fetch','AbortSignal', `${code}\nreturn {ensureLocalOllama};`);
  const { ensureLocalOllama } = init({}, spawn, p => p === '/opt/homebrew/bin/ollama', { env: {} }, async () => {}, AbortSignal);
  assert.equal(ensureLocalOllama('http://some.remote.server:11434'), false);
  assert.equal(ensureLocalOllama('http://127.0.0.1:11434'), true);
  assert.equal(ensureLocalOllama('http://127.0.0.1:11434'), true);
  assert.equal(launches, 1);
});
