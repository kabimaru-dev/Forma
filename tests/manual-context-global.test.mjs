import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = (() => { try { return require('typescript'); } catch { return require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); } })();
const transpile = filename => ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename, reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
});

function testStorage(initial = new Map()) {
  const records = new Map(initial);
  const source = transpile('server/storage.ts').outputText.replace(/^import .*;\r?\n/gm, '').replace(/\bexport\s+/g, '');
  const database = {
    select: () => ({ from: () => ({ where: predicate => ({
      get: () => records.has(predicate.owner) ? { value: structuredClone(records.get(predicate.owner)) } : undefined,
    }) }) }),
    insert: () => ({ values: ({ owner, value }) => ({ onConflictDoUpdate: () => ({
      run: () => records.set(owner, structuredClone(value)),
    }) }) }),
  };
  class Sqlite { pragma() {} exec() {} }
  const create = new Function('chats','preferences','defaultSettings','drizzle','Database','eq','and','desc','randomUUID',
    `${source}\nreturn storage;`);
  const storage = create({}, {owner: 'owner'}, {
    temperature:0.7, context:262144, contextStep:16384, contextPreload:8192,
    contextDefaultsApplied:true,contextManualDefaultsApplied:true,
    system:'',theme:'system',model:'',ollamaUrl:'',
  }, () => database, Sqlite, (_key, owner) => ({owner}), () => ({}), () => ({}), ()=>'id');
  return {storage,records};
}

test('new accounts receive a persistent 256K manual default, 16K step and 8K preload', () => {
  const { storage } = testStorage();
  assert.equal(storage.settings('alice').context, 262144);
  assert.equal(storage.settings('alice').contextStep, 16384);
  assert.equal(storage.settings('alice').contextPreload, 8192);
});

test('existing accounts on old 8K default migrate once without affecting their automatic preferences', () => {
  const prior = {context:8192,contextStep:4096,contextPreload:2048,contextDefaultsApplied:true};
  const { storage, records } = testStorage(new Map([['alice',prior]]));
  const next = storage.settings('alice');
  assert.equal(next.context,262144);
  assert.equal(next.contextStep,4096);
  assert.equal(next.contextPreload,2048);
  assert.equal(next.contextManualDefaultsApplied,true);
  assert.equal(records.get('alice').context,262144);
  assert.equal(storage.settings('alice').context,262144);
});

test('a chosen manual size survives history switching, reload and another account', () => {
  const { storage, records } = testStorage();
  const changed = {...storage.settings('alice'),context:65536};
  storage.saveSettings('alice',changed);
  assert.equal(storage.settings('alice').context,65536);
  assert.equal(storage.settings('bob').context,262144);
  const {storage: restarted} = testStorage(records);
  assert.equal(restarted.settings('alice').context,65536);
  assert.equal(restarted.settings('bob').context,262144);
});

test('manual slider is always enabled with an exact 2K–256K range and auto-saving handler', () => {
  const ui = fs.readFileSync('client/src/App.tsx','utf8');
  const slider = ui.match(/<input id="context".*?\/>/)?.[0];
  assert.ok(slider,'manual slider must be present');
  assert.match(slider,/data-testid="slider-context-manual"/);
  assert.match(slider,/type="range"/);
  assert.match(slider,/min="2048" max="262144" step="1024"/);
  assert.doesNotMatch(slider,/disabled=/);
  assert.match(slider,/saveSlider\("context", Number\(e\.currentTarget\.value\)\)/);
  assert.match(ui,/const saveQueue = useRef<Promise<void>>/);
  for (const file of ['shared/defaults.ts','shared/schema.ts','server/storage.ts','client/src/App.tsx']) {
    const result=transpile(file);
    assert.equal(result.diagnostics?.filter(x=>x.category===ts.DiagnosticCategory.Error).length ?? 0,0,file);
  }
});
