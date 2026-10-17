import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = (() => { try { return require('typescript'); } catch { return require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); } })();
const app = fs.readFileSync('client/src/App.tsx', 'utf8');
const picker = fs.readFileSync('client/src/components/ModePicker.tsx', 'utf8');
const css = fs.readFileSync('client/src/index.css', 'utf8');
const backend = fs.readFileSync('server/modes.ts', 'utf8');

test('React and server TypeScript parse without syntax errors', () => {
  for (const [name, content] of [['App.tsx', app], ['ModePicker.tsx', picker], ['modes.ts', backend]]) {
    const result = ts.transpileModule(content, { fileName: name, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } });
    assert.equal(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length || 0, 0, name);
  }
});

test('no manual selection, Models tab or database work is introduced', () => {
  assert.doesNotMatch(picker, /Ручной выбор|onManual|onManage/);
  assert.doesNotMatch(app, /ModelsView|isModels|navigate\("\/models"\)/);
  assert.doesNotMatch(app, /setManualMode|button-models|button-connected-models/);
});


test('settings button opens the v4 generation settings dialog instead of the mode popover', () => {
  assert.match(picker, /onOpenSettings: \(\) => void;/);
  assert.match(picker, /data-testid="button-generation-settings" onClick=\{\(\) => \{ changeOpen\(false\); onOpenSettings\(\); \}\}/);
  assert.match(app, /onOpenSettings=\{\(\) => openSettings\("generation"\)\}/);
  assert.match(app, /function openSettings\(tab = "connection"\) \{ setSettingsTab\(tab\); setSettingsOpen\(true\); \}/);
  assert.match(app, /<SettingsDialog open=\{settingsOpen\}/);
  assert.match(app, /\[\["connection", "Подключение"\], \["generation", "Ответы"\], \["appearance", "Оформление"\]\]/);
  assert.doesNotMatch(picker, /onClick=\{\(\) => changeOpen\(!open\)\}/);
  assert.match(picker, /data-testid="button-mode-picker"/);
});
