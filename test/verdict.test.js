// The synthesis prompt asks for fixed labels; the parser must split them out
// reliably, tolerate the formatting models add anyway, and drop nothing.

const fs = require('fs');
const path = require('path');
const DIST = path.join(__dirname, '..', 'dist');

global.window = {};
new Function(fs.readFileSync(path.join(DIST, 'js/prompt.js'), 'utf8'))();
const P = window.Prompt;
let failed = 0;

function expect(label, actual, wanted) {
  const a = JSON.stringify(actual);
  const w = JSON.stringify(wanted);
  const ok = a === w;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : ` — got ${a}, wanted ${w}`));
}

const labels = (text) => P.parseVerdict(text).map((s) => s.label);

expect(
  'splits every section in order',
  labels('AGREED: a\nSPLIT: b\nRISKS: c\nDECISION: d\nOPEN: e'),
  ['AGREED', 'SPLIT', 'RISKS', 'DECISION', 'OPEN']
);
expect(
  'keeps continuation lines with their section',
  P.parseVerdict('SPLIT: Kit wants X.\nTheo wants Y.\nDECISION: ship'),
  [{ label: 'SPLIT', body: 'Kit wants X.\nTheo wants Y.' }, { label: 'DECISION', body: 'ship' }]
);
expect(
  'tolerates bold and lower-case labels',
  labels('**Agreed:** a\n**RISKS**: b'),
  ['AGREED', 'RISKS']
);
expect(
  'keeps preamble before the first label',
  P.parseVerdict('Here is the record.\nAGREED: a'),
  [{ label: null, body: 'Here is the record.' }, { label: 'AGREED', body: 'a' }]
);
expect('a label word mid-sentence is not a section', labels('AGREED: they never agreed: at all'), ['AGREED']);
expect('partially streamed label stays as text', P.parseVerdict('AGREED: a\nSPL'), [
  { label: 'AGREED', body: 'a\nSPL' },
]);
expect('empty text yields no sections', P.parseVerdict(''), []);

const solo = P.verdictSystem('solo');
const debate = P.verdictSystem('debate');
expect('solo prompt frames independent reviewers', /independent reviews/.test(solo), true);
expect('debate prompt frames a debate', /council debate/.test(debate), true);
expect(
  'prompt names every label',
  P.VERDICT_SECTIONS.every(([l]) => debate.includes(`${l}:`)),
  true
);
expect(
  'request marks cut-off speakers',
  P.verdictRequest('Q?', [{ name: 'Kit', text: 'no', cutOff: true }]).includes('Kit (cut off mid-sentence): no'),
  true
);

console.log(failed ? `\n${failed} FAILED` : '\nall verdict tests passed');
process.exit(failed ? 1 : 0);
