import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = (()=>{ try { return require('typescript'); } catch { return require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); }})();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forma-context-test-'));
process.env.FORMA_CONTEXT_FILE = path.join(tempDir,'context.json');
async function loadTs(source) {
  const js = ts.transpileModule(fs.readFileSync(source, 'utf8'), {fileName:source,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  return import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
}
const {selectContext,contextWindows,MAX_CONTEXT} = await loadTs('server/contextWindows.ts');
const {preloadModel} = await loadTs('server/modelPreload.ts');
const settings = (step,preload=0,manual=8192)=>({context:manual,contextStep:step,contextPreload:preload});

test('manual mode uses existing selected context and disables automatic scaling',()=>{
  assert.equal(selectContext(120000,8192,settings(0)),8192);
  assert.equal(contextWindows.current('manual','test',settings(0)),8192);
});
test('8K ladder increases one step at exactly 8K, 16K, 24K',()=>{
  const s=settings(8192);
  assert.equal(selectContext(0,8192,s),8192);
  assert.equal(selectContext(8191,8192,s),8192);
  assert.equal(selectContext(8192,8192,s),16384);
  assert.equal(selectContext(16384,16384,s),24576);
  assert.equal(selectContext(24576,24576,s),32768);
  assert.equal(selectContext(64000,8192,s),65536);
});
test('early 16K warning doubles 32K to 64K and 48K to 96K',()=>{
  assert.equal(selectContext(16383,32768,settings(32768,16384)),32768);
  assert.equal(selectContext(16384,32768,settings(32768,16384)),65536);
  assert.equal(selectContext(32768,49152,settings(16384,16384)),98304);
});
test('max context stays 256K and initial small context is never below 2K',()=>{
  assert.equal(selectContext(300000,4096,settings(4096)),MAX_CONTEXT);
  assert.equal(selectContext(251000,131072,settings(32768,16384)),MAX_CONTEXT);
  assert.equal(contextWindows.current('tiny','model',settings(1024)),2048);
});
test('real Ollama counts drive next context window per chat and persist outside SQLite',()=>{
  const s=settings(8192);
  assert.equal(contextWindows.current('chat-a','model',s),8192);
  assert.equal(contextWindows.record('chat-a','model',s,8000,192).after,16384);
  assert.equal(contextWindows.current('chat-a','model',s),16384);
  assert.equal(contextWindows.current('chat-b','model',s),8192);
  assert.equal(JSON.parse(fs.readFileSync(process.env.FORMA_CONTEXT_FILE,'utf8'))['chat-a'].context,16384);
  contextWindows.remove('chat-a');
  assert.equal(JSON.parse(fs.readFileSync(process.env.FORMA_CONTEXT_FILE,'utf8'))['chat-a'],undefined);
});
test('no fabricated observed context when Ollama does not supply both counters',()=>{
  const s=settings(8192);
  assert.equal(contextWindows.record('no-counters','model',s,null,99).after,8192);
});
test('explicit Ollama preload uses empty messages and options.num_ctx',async()=>{
  const previous=globalThis.fetch;
  let calls=[];
  globalThis.fetch=async (url,request)=>{
    calls.push({url,payload:JSON.parse(request.body)});
    return new Response(JSON.stringify({done:true,done_reason:'load'}),{status:200});
  };
  try {
    await preloadModel('http://127.0.0.1:11434','example:7b',32768);
    await preloadModel('http://127.0.0.1:11434','example:7b',32768);
    await preloadModel('http://127.0.0.1:11434','example:7b',65536);
    assert.equal(calls.length,2);
    assert.deepEqual(calls.map(x=>x.payload.options.num_ctx),[32768,65536]);
    assert.deepEqual(calls[0].payload.messages,[]);
    assert.equal(calls[0].payload.keep_alive,'10m');
  } finally {globalThis.fetch=previous;}
});
test('new TypeScript files parse with no errors',()=>{
  for (const file of ['server/contextWindows.ts','server/modelPreload.ts','server/routes.ts','shared/schema.ts','client/src/App.tsx']) {
    const s=fs.readFileSync(file,'utf8');
    const result=ts.transpileModule(s,{fileName:file,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}});
    const errors=(result.diagnostics || []).filter(d=>d.category===ts.DiagnosticCategory.Error);
    assert.equal(errors.length,0,`${file}: ${errors.map(e=>e.messageText).join('; ')}`);
  }
});
