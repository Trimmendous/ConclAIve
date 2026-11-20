// Per-persona harnesses and their model overrides must remain independent.

const fs = require('fs');
const path = require('path');
const DIST = path.join(__dirname, '..', 'dist');
const storage = new Map();

global.window = {};
global.localStorage = {
  getItem: (key) => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, value),
};

new Function(fs.readFileSync(path.join(DIST, 'js/personas.js'), 'utf8'))();
const P = window.Personas;
const persona = { id: 'test-persona' };
let failed = 0;

function expect(label, actual, wanted) {
  const ok = actual === wanted;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : ` — got ${actual}, wanted ${wanted}`));
}

expect('persona initially follows council harness', P.effectiveHarness(persona, 'codex'), 'codex');
P.setHarness(persona.id, 'claude-code');
expect('persona keeps its chosen harness', P.effectiveHarness(persona, 'codex'), 'claude-code');

P.setModel(persona.id, 'opus', 'claude-code');
P.setModel(persona.id, 'gpt-6-astra', 'codex');
expect('Claude model override is isolated', P.effectiveModel(persona, 'claude-code'), 'opus');
expect('Codex model override is isolated', P.effectiveModel(persona, 'codex'), 'gpt-6-astra');
expect('OpenCode still uses its default', P.effectiveModel(persona, 'opencode'), P.DEFAULT_MODELS.opencode);

// Only Claude Code installed: defaults and stale overrides must land on it.
P.setInstalled({ codex: false, opencode: false, 'claude-code': true });
expect('missing default falls back to an installed harness', P.usableHarness('codex'), 'claude-code');
P.setHarness('other-persona', 'opencode');
expect('override to a missing CLI follows the council default',
  P.effectiveHarness({ id: 'other-persona' }, 'codex'), 'claude-code');
expect('override to an installed CLI is kept', P.effectiveHarness(persona, 'codex'), 'claude-code');
P.setInstalled({ codex: true, opencode: false, 'claude-code': true });
expect('installed default is respected', P.usableHarness('codex'), 'codex');
P.setInstalled(null);
expect('unknown status hides nothing', P.isInstalled('opencode'), true);

console.log(failed ? `\n${failed} FAILED` : '\nall harness tests passed');
process.exit(failed ? 1 : 0);
