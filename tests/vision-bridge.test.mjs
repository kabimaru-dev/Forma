import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = (() => { try { return require('typescript'); } catch { return require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); } })();
function imported(file) {
  const code = ts.transpileModule(readFileSync(file,'utf8'), { fileName:file,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}
test('one configurable vision model, hidden from public modes', async () => {
  const { visionModel, publicModes } = await imported('server/modes.ts');
  const saved = process.cwd(), dir=mkdtempSync(join(tmpdir(),'forma-vision-'));
  try {
    mkdirSync(join(dir,'config'));
    const source=readFileSync('config/modes.example.yaml','utf8');
    writeFileSync(join(dir,'config/modes.yaml'),source.replace('vision_model: ""','vision_model: "private-vl:tag"'));
    process.chdir(dir);
    assert.equal(visionModel(),'private-vl:tag');
    assert.doesNotMatch(JSON.stringify(publicModes()),/private-vl:tag/);
    writeFileSync(join(dir,'config/modes.yaml'),source.replace('vision_model: ""','vision_model: "bad model"'));
    assert.throws(()=>visionModel(),/Неверное имя/);
    writeFileSync(join(dir,'config/modes.yaml'),source);
    assert.equal(visionModel(),'');
    // Existing installations without the key are upgraded without losing other settings.
    const old = source.replace(/^vision_model: ""\n/m, '');
    writeFileSync(join(dir,'config/modes.yaml'), old);
    assert.equal(visionModel(),'');
    const migrated = readFileSync(join(dir,'config/modes.yaml'),'utf8');
    assert.ok(migrated.includes(old));
    assert.equal((migrated.match(/^vision_model:/gm)||[]).length,1);
    assert.equal(readFileSync(join(dir,'config/modes.before-vision.bak'),'utf8'),old);
    visionModel();
    assert.equal((readFileSync(join(dir,'config/modes.yaml'),'utf8').match(/^vision_model:/gm)||[]).length,1);
  } finally {process.chdir(saved);rmSync(dir,{recursive:true,force:true});}
});
test('photos are described by designated Ollama model and used as plain text', async () => {
  const { describeImages } = await imported('server/vision.ts');
  const former=globalThis.fetch;
  const requests=[];
  globalThis.fetch = async (url, opts) => {
    requests.push({url, body:JSON.parse(opts.body)});
    return new Response(JSON.stringify({message:{content:'Кот на столе. Надпись: TEST'}}), {status:200});
  };
  try {
    const result = await describeImages('http://127.0.0.1:11434','private-vl:tag',[
      {name:'cat.png',mimeType:'image/png',data:'eHl6'},
      {name:'dog.jpg',mimeType:'image/jpeg',data:'eHl6'},
    ],new AbortController().signal);
    assert.match(result,/Изображение 1: cat.png/);
    assert.match(result,/Изображение 2: dog.jpg/);
    assert.match(result,/Кот на столе/);
    assert.equal(requests.length,2);
    assert.equal(requests[0].body.keep_alive, '5m');
    assert.equal(requests[1].body.keep_alive, 0);
    assert.ok(requests.every(({body})=>body.model==='private-vl:tag' && body.stream===false && body.messages[0].images[0]==='eHl6'));
  } finally {globalThis.fetch=former;}
});
test('vision failure never invents a description or silently omits images', async () => {
  const { describeImages } = await imported('server/vision.ts');
  const former=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'model not found'}),{status:404});
  try {
    await assert.rejects(()=>describeImages('http://localhost:11434','missing', [{name:'x.png',mimeType:'image/png',data:'eHl6'}],new AbortController().signal),/model not found/);
  } finally {globalThis.fetch=former;}
});
test('model config, client multi-select and server images validate without syntax errors', () => {
  for (const file of ['server/vision.ts','server/modes.ts','server/routes.ts','shared/schema.ts','client/src/App.tsx']) {
    const result=ts.transpileModule(readFileSync(file,'utf8'),{fileName:file,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}});
    assert.deepEqual(result.diagnostics.filter(d=>d.category===ts.DiagnosticCategory.Error).map(d=>String(d.messageText)),[],file);
  }
  assert.match(readFileSync('client/src/App.tsx','utf8'),/<input ref=\{fileInput\} type="file" multiple/);
  assert.match(readFileSync('server/routes.ts','utf8'),/describeImages\(OLLAMA, imageModel, images/);
  assert.equal((readFileSync('config/modes.yaml','utf8').match(/^vision_model:/gm)||[]).length,1);
});
