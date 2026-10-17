import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = (() => { try { return require('typescript'); } catch { return require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); } })();
const source = readFileSync('server/modes.ts','utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }}).outputText;
const { publicModes, resolveMode } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

function setTierEffort(yaml, tier, effort, enabled) {
  const start = yaml.indexOf(`  ${tier}:\n`, yaml.indexOf('levels:\n'));
  assert.notEqual(start, -1, `Missing tier ${tier}`);
  const next = yaml.slice(start + 3).search(/\n  (?:minimal|moderate|intensive|extreme):\n/);
  const end = next < 0 ? -1 : start + 3 + next;
  const first = yaml.slice(0, start);
  const section = yaml.slice(start, end < 0 ? undefined : end);
  const last = end < 0 ? '' : yaml.slice(end);
  const before = `      ${effort}:\n        enabled: ${!enabled}`;
  assert.ok(section.includes(before), `Missing enabled flag for ${tier}/${effort}`);
  return first + section.replace(before, `      ${effort}:\n        enabled: ${enabled}`) + last;
}

test('thinking effort flags are independent for each of four levels', () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(),'forma-modes-'));
  try {
    mkdirSync(join(dir,'config'));
    const file = join(dir,'config','modes.yaml');
    let yaml = readFileSync('config/modes.example.yaml','utf8');
    // The same effort is independently routable to each level.
    yaml = yaml.replace('      medium:\n        enabled: true\n        normal: ""', '      medium:\n        enabled: true\n        normal: "installed:tag"');
    writeFileSync(file,yaml);
    process.chdir(dir);
    let pub = publicModes();
    assert.equal(pub.levels.minimal,true);
    assert.equal(pub.levels.moderate,true);
    assert.equal(pub.levels.intensive,false);
    assert.equal(pub.levels.extreme,false);
    for (const tier of ['minimal','moderate','intensive','extreme']) {
      for (const effort of ['low','medium','high','extra_high','max']) assert.equal(pub.reasoning[tier][effort],true);
    }
    assert.equal(pub.speed.normal,true);
    assert.equal(pub.custom.enabled,false);
    assert.equal(Object.keys(pub.custom.options).length,5);
    assert.equal(pub.available.minimal.medium.normal,true);
    assert.equal(resolveMode('forma:minimal:medium:normal'),'installed:tag');
    assert.equal(resolveMode('forma:core:medium:normal'),'installed:tag');
    assert.doesNotMatch(JSON.stringify(pub),/installed:tag/);
    assert.throws(() => resolveMode('forma:intensive:medium:normal'),/уровень/);

    // Disabling one effort for Minimal does NOT disable that effort for Moderate.
    yaml = setTierEffort(yaml, 'minimal', 'medium', false);
    writeFileSync(file,yaml);
    pub = publicModes();
    assert.equal(pub.reasoning.minimal.medium,false);
    assert.equal(pub.reasoning.moderate.medium,true);
    assert.equal(pub.available.minimal.medium.normal,false);
    assert.throws(() => resolveMode('forma:minimal:medium:normal'),/Thinking Effort/);

    // Enabling the Moderate model of the same effort works without touching Minimal.
    yaml = yaml.replace(/(  moderate:\n[\s\S]*?      medium:\n        enabled: true\n        normal:) ""/, '$1 "moderate:tag"');
    writeFileSync(file,yaml);
    assert.equal(publicModes().available.moderate.medium.normal,true);
    assert.equal(resolveMode('forma:moderate:medium:normal'), 'moderate:tag');

    // Reset Minimal and block only Moderate's Medium.
    yaml = setTierEffort(yaml, 'minimal', 'medium', true);
    yaml = setTierEffort(yaml, 'moderate', 'medium', false);
    writeFileSync(file,yaml);
    assert.equal(resolveMode('forma:minimal:medium:normal'),'installed:tag');
    assert.equal(publicModes().reasoning.moderate.medium,false);
    assert.throws(() => resolveMode('forma:moderate:medium:normal'),/Thinking Effort/);

    // Speed remains independently switchable from a shared two-value section.
    yaml = yaml.replace('normal:\n    enabled: true', 'normal:\n    enabled: false');
    writeFileSync(file,yaml);
    assert.equal(publicModes().speed.normal,false);
    assert.throws(() => resolveMode('forma:minimal:medium:normal'),/Speed/);
  } finally { process.chdir(cwd); rmSync(dir,{recursive:true,force:true}); }
});

test('v5 routes seven efforts and private model aliases while enforcing locks', () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(),'forma-v5-'));
  try {
    mkdirSync(join(dir,'config'));
    const file = join(dir,'config','modes.yaml');
    let yaml = readFileSync('config/modes.example.yaml','utf8').replaceAll('normal: ""','normal: "base:tag"');
    yaml = yaml.replace('    enabled: false\n    model: ""', '    enabled: true\n    model: "private:tag"');
    writeFileSync(file, yaml); process.chdir(dir);
    for (const effort of ['minimal','low','medium','high','extra_high','max','ultra']) {
      assert.equal(resolveMode(`forma:moderate:${effort}:normal`), 'base:tag');
      assert.equal(resolveMode(`forma:moderate:${effort}:normal:model_02`), 'private:tag');
    }
    assert.doesNotMatch(JSON.stringify(publicModes()), /private:tag|base:tag/);
    assert.throws(() => resolveMode('forma:moderate:medium:normal:model_03'), /отключена/);
    assert.throws(() => resolveMode('forma:extreme:medium:normal:model_02'), /уровень/);
    yaml = setTierEffort(yaml, 'moderate', 'medium', false); writeFileSync(file,yaml);
    assert.throws(() => resolveMode('forma:moderate:medium:normal:model_02'), /Thinking Effort/);
  } finally { process.chdir(cwd); rmSync(dir,{recursive:true,force:true}); }
});
