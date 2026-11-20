// The hardware check must warn on councils that genuinely overload a machine,
// stay quiet on ordinary ones, and base its judgement on concurrency rather
// than session length.

const fs = require('fs');
const path = require('path');
const DIST = path.join(__dirname, '..', 'dist');

global.window = {};
new Function(fs.readFileSync(path.join(DIST, 'js/resources.js'), 'utf8'))();
const R = window.Resources;
let failed = 0;

function expect(label, actual, wanted) {
  const ok = actual === wanted;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : ` — got ${actual}, wanted ${wanted}`));
}

const many = (n, h) => Array.from({ length: n }, () => h || 'claude-code');
// A 16 GB laptop with some apps open: the numbers the backend reported on a dev machine.
const laptop = { total_memory_mb: 16384, available_memory_mb: 6389, logical_cpus: 12, load_average: 4.6 };
const small = { total_memory_mb: 8192, available_memory_mb: 1800, logical_cpus: 4, load_average: 0.5 };

let a = R.assess({ mode: 'debate', rounds: 3, harnesses: many(5) }, laptop);
expect('5-member debate on a laptop is fine', a.level, 'ok');
expect('debate runs at most two members at once', a.peakProcesses, 2);
expect('turns count rounds times members', a.turns, 15);

const longer = R.assess({ mode: 'debate', rounds: 20, harnesses: many(5) }, laptop);
expect('more rounds do not raise the hardware level', longer.level, a.level);
expect('more rounds do not raise peak memory', longer.peakMb, a.peakMb);

a = R.assess({ mode: 'debate', rounds: 3, overlap: 4, harnesses: many(5) }, laptop);
expect('raised overlap runs that many at once', a.peakProcesses, 4);
a = R.assess({ mode: 'debate', rounds: 3, overlap: 99, harnesses: many(20) }, laptop);
expect('an everyone-at-once debate of 20 is strain', a.level, 'strain');
expect('strain advice points at the overlap setting', a.advice.some((t) => /Talking at once/.test(t)), true);
a = R.assess({ mode: 'debate', rounds: 3, overlap: 1, harnesses: many(20) }, laptop);
expect('without barge-in only the speaker runs', a.peakProcesses, 1);

a = R.assess({ mode: 'solo', rounds: 1, harnesses: many(20) }, laptop);
expect('20 members in solo on a laptop is strain', a.level, 'strain');
expect('solo runs every member at once', a.peakProcesses, 20);
expect('strain suggests Debate mode', a.advice.some((t) => /Debate mode/.test(t)), true);

a = R.assess({ mode: 'solo', rounds: 1, harnesses: many(8) }, laptop);
expect('8 members in solo on a laptop is heavy', a.level, 'heavy');

a = R.assess({ mode: 'solo', rounds: 1, harnesses: many(8, 'codex') }, laptop);
expect('lighter CLIs fit where heavier ones do not', a.level, 'ok');

a = R.assess({ mode: 'debate', rounds: 3, harnesses: many(3) }, small);
expect('even a debate strains a machine with under 2 GB free', a.level, 'strain');

const plain = R.assess({ mode: 'solo', rounds: 1, harnesses: many(5) }, laptop);
const code = R.assess({ mode: 'solo', rounds: 1, codebase: true, harnesses: many(5) }, laptop);
expect('codebase mode needs more memory', code.peakMb > plain.peakMb, true);

a = R.assess({ mode: 'debate', rounds: 3, harnesses: many(3) },
  { total_memory_mb: 32768, available_memory_mb: 20000, logical_cpus: 4, load_average: 6 });
expect('a CPU already saturated is strain even with memory to spare', a.level, 'strain');

a = R.assess({ mode: 'debate', rounds: 3, harnesses: ['codex', 'claude-code', 'codex'] }, laptop);
expect('worst case pairs the heaviest members', a.peakMb, R.processMb('claude-code') + R.processMb('codex'));

console.log(failed ? `\n${failed} FAILED` : '\nall resource tests passed');
process.exit(failed ? 1 : 0);
