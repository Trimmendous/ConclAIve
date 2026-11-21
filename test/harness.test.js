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

// Only Claude Code installed: nothing to choose, so it is used.
P.setInstalled({ codex: false, opencode: false, 'claude-code': true });
expect('a single installed CLI is used', P.usableHarness('codex'), 'claude-code');
expect('nothing chosen yet still lands on the only CLI', P.usableHarness(null), 'claude-code');
P.setHarness('other-persona', 'opencode');
expect('override to a missing CLI follows the council default',
  P.effectiveHarness({ id: 'other-persona' }, 'claude-code'), 'claude-code');
expect('override to an installed CLI is kept', P.effectiveHarness(persona, 'codex'), 'claude-code');

// Several installed: an installed choice stands, and nothing is picked for the chair.
P.setInstalled({ codex: true, opencode: false, 'claude-code': true });
expect('installed choice is respected', P.usableHarness('codex'), 'codex');
expect('several installed and none chosen picks nothing', P.usableHarness(null), null);
expect('several installed and a missing choice picks nothing', P.usableHarness('opencode'), null);
expect('installed list has no preference order', P.installedHarnesses().join(','), 'codex,claude-code');

// None installed.
P.setInstalled({ codex: false, opencode: false, 'claude-code': false });
expect('no CLI means no harness', P.usableHarness('codex'), null);

P.setInstalled(null);
expect('unknown status hides nothing', P.isInstalled('opencode'), true);

console.log(failed ? `\n${failed} FAILED` : '\nall harness tests passed');
process.exit(failed ? 1 : 0);
