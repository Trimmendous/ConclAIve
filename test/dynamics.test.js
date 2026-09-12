// Deterministic tests for the conversation dynamics.
//
// These do not run the app. Timer-driven behaviour cannot be measured in a
// hidden browser tab (timers are throttled to seconds there), so the parts
// that decide *who speaks* and *how often anyone cuts in* are exercised
// directly, with a seeded RNG where randomness matters.

const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
global.window = {};
global.document = { documentElement: {} };
global.localStorage = { getItem: () => null, setItem: () => {} };
global.location = { search: '' };
global.URLSearchParams = URLSearchParams;
global.setTimeout = setTimeout;
global.setInterval = setInterval;

// council.js expects these globals to already exist.
new Function(fs.readFileSync(path.join(DIST, 'js/bridge.js'), 'utf8'))();
new Function(fs.readFileSync(path.join(DIST, 'js/personas.js'), 'utf8'))();
new Function(fs.readFileSync(path.join(DIST, 'js/prompt.js'), 'utf8'))();
new Function(fs.readFileSync(path.join(DIST, 'js/council.js'), 'utf8'))();

const T = window.Council.__test;
const P = window.Personas;
const C = T.constants;

let failures = 0;
function check(label, pass, detail) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!pass) failures++;
}

// Real weights, read from the shipped persona packs rather than duplicated.
const personas = JSON.parse(fs.readFileSync(path.join(DIST, 'personas/index.json'), 'utf8')).map(
  (id) => JSON.parse(fs.readFileSync(path.join(DIST, `personas/${id}.json`), 'utf8'))
);
const rt = (p) => ({ persona: p, active: false, spokeAt: 0, state: 'idle', buffer: '' });
const all = personas.map(rt);

// --- 1. interruptiveness is read from the pack --------------------------------

const weights = Object.fromEntries(all.map((r) => [r.persona.id, T.interruptiveness(r)]));
check(
  'personas carry distinct interruptiveness',
  weights['kit-kernel'] > weights['piper-compile'] &&
    weights['piper-compile'] > weights['milo-frame'] &&
    weights['milo-frame'] > weights['clara-invariant'] &&
    weights['theo-lemma'] === 0,
  JSON.stringify(weights)
);

// --- 2. weightedPick follows those weights ------------------------------------

const N = 60000;
const counts = {};
for (let i = 0; i < N; i++) {
  const pick = T.weightedPick(all);
  counts[pick.persona.id] = (counts[pick.persona.id] || 0) + 1;
}
const total = all.reduce((s, r) => s + T.interruptiveness(r), 0);
let maxErr = 0;
all.forEach((r) => {
  const expected = T.interruptiveness(r) / total;
  const actual = (counts[r.persona.id] || 0) / N;
  maxErr = Math.max(maxErr, Math.abs(expected - actual));
});
check('weightedPick matches persona weights', maxErr < 0.01, `max error ${maxErr.toFixed(4)}`);
check(
  'a zero-interruptiveness member never cuts in',
  !counts['theo-lemma'],
  `Theo picked ${counts['theo-lemma'] || 0} times in ${N}`
);

// --- 3. overall interjection rate stays occasional ----------------------------
//
// Mirrors the gate in scheduleInterjection: pick weighted, then roll against
// that persona's own eagerness, damped globally.

let interjected = 0;
for (let i = 0; i < N; i++) {
  const pick = T.weightedPick(all);
  if (Math.random() < T.interruptiveness(pick) * C.INTERJECT_BASE) interjected++;
}
const rate = interjected / N;
check(
  'interjection rate is occasional, not routine',
  rate > 0.1 && rate < 0.4,
  `${(rate * 100).toFixed(1)}% of turns draw an interjection`
);

// --- 4. speaker rotation is fair and never repeats back to back ---------------

T.setSession({ floor: null });
const order = [];
let last = null;
// A five-member room over 40 turns divides evenly; the full roster of 18 would
// not, and would test arithmetic rather than fairness.
const room5 = all.slice(0, 5);
room5.forEach((r, i) => { r.spokeAt = i - room5.length; });
for (let turn = 0; turn < 40; turn++) {
  const sp = T.pickSpeaker(room5, last, turn);
  sp.spokeAt = turn;
  last = sp.persona.id;
  order.push(sp.persona.id);
}
const backToBack = order.filter((id, i) => i > 0 && order[i - 1] === id).length;
const spread = {};
order.forEach((id) => (spread[id] = (spread[id] || 0) + 1));
const turnsEach = Object.values(spread);
check('no member speaks twice in a row', backToBack === 0, `${backToBack} repeats`);
check(
  'floor rotates evenly across members',
  Math.max(...turnsEach) - Math.min(...turnsEach) <= 1,
  JSON.stringify(spread)
);
check('every member gets the floor', Object.keys(spread).length === room5.length);

// --- 5. winning an interruption takes control of the floor --------------------

const holder = all.find((r) => r.persona.id === 'kit-kernel');
let grabbed = 0;
const TRIALS = 4000;
const NOW = 1000;
for (let i = 0; i < TRIALS; i++) {
  T.setSession({ floor: { id: 'kit-kernel', turns: C.FLOOR_CONTROL_TURNS } });
  all.forEach((r, idx) => { r.spokeAt = idx; });
  holder.spokeAt = NOW - 1; // just spoke, so only floor control can select him
  if (T.pickSpeaker(all, 'someone-else', NOW) === holder) grabbed++;
}
const grabRate = grabbed / TRIALS;
check(
  'interrupter takes the floor despite having just spoken',
  Math.abs(grabRate - C.FLOOR_CONTROL_BIAS) < 0.05,
  `${(grabRate * 100).toFixed(1)}% vs configured ${(C.FLOOR_CONTROL_BIAS * 100).toFixed(0)}%`
);

T.setSession({ floor: null });
holder.spokeAt = NOW - 1;
all.filter((r) => r !== holder).forEach((r, idx) => { r.spokeAt = idx; });
check(
  'without floor control the recent speaker is not favoured',
  T.pickSpeaker(all, 'someone-else', NOW) !== holder
);

// --- 6. echo / stall detection ------------------------------------------------
//
// Modelled on the real failure: every member answering "Nothing to add.
// Waiting for symbols." after one of them set that tone.

const echo = [
  { text: 'Nothing to add. Waiting for symbols.', done: true },
  { text: 'Nothing to add. Waiting for symbols.', done: true },
  { text: 'Waiting for symbols. Nothing to add here either.', done: true },
];
check(
  'identical short replies are detected as echo',
  T.isDegenerate(echo[1], [echo[0]]),
  `similarity ${T.similarity(echo[0].text, echo[1].text).toFixed(2)}`
);
check(
  'reworded short echo is still detected',
  T.isDegenerate(echo[2], [echo[0]]),
  `similarity ${T.similarity(echo[0].text, echo[2].text).toFixed(2)}`
);
check('bare abstention is detected on its own', T.isDegenerate({ text: 'I have nothing to add.' }, []));
check('empty reply is degenerate', T.isDegenerate({ text: '' }, []));

// Substance must survive, including short sharp objections and genuine
// disagreement that happens to share vocabulary with what came before.
const sharp = { text: 'No. Profile it first — you have not shown the parser is the bottleneck.' };
check('a short sharp objection is not flagged', !T.isDegenerate(sharp, [echo[0]]));

const longAgreement = {
  text:
    'I agree with the above, but the reason matters: the allocation churn in the tokenizer is ' +
    'the actual cost, and a Rust rewrite that keeps the same allocation pattern will buy you ' +
    'nothing at all. Fix the pattern first and you may find the language was never the problem.',
};
check('substantive reply that opens with agreement is not flagged', !T.isDegenerate(longAgreement, []));

const related = { text: 'The parser allocates on every token, which is the real bottleneck here.' };
const prior = { text: 'The parser allocates on every token and that is the bottleneck.' };
check(
  'shared vocabulary alone does not flag a longer contribution',
  !T.isDegenerate({ text: related.text + ' Measure the arena allocator against it before deciding anything further, please.' }, [prior])
);

// --- 7. tuning dials actually do something ------------------------------------

const mk = (over) => P.normalize(Object.assign({
  id: 'x', name: 'X', voice: { system_prompt: 'You are X.' }, reaction: {},
}, over), false);

// Defaults fill in, and legacy packs that declared interruptiveness the old way
// keep working.
const legacy = mk({ reaction: { interruptiveness: 0.9 } });
check('tuning block gets defaults', legacy.tuning.talkativeness === 0.5 && legacy.tuning.verbosity === 130);
check('legacy interruptiveness is carried into tuning', legacy.tuning.interruptiveness === 0.9);
check('effort defaults to medium and rejects junk',
  mk({}).tuning.effort === 'medium' && mk({ tuning: { effort: 'ludicrous' } }).tuning.effort === 'medium');
check('out-of-range values are clamped',
  mk({ tuning: { bluntness: 5, verbosity: 5000 } }).tuning.bluntness === 1 &&
  mk({ tuning: { verbosity: 5000 } }).tuning.verbosity === 320);

// Slider positions must reach the prompt as instructions, not as numbers.
const ctx = { mode: 'debate', members: [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }] };
const blunt = window.Prompt.composeSystem(mk({ tuning: { bluntness: 0.95, stubbornness: 0.95, verbosity: 60 } }), ctx);
const gentle = window.Prompt.composeSystem(mk({ tuning: { bluntness: 0.05, stubbornness: 0.05, verbosity: 300 } }), ctx);
check('bluntness changes the instruction', /brutal/i.test(blunt) && /diplomatic/i.test(gentle));
check('stubbornness changes the instruction', /do not move/i.test(blunt) && /update readily/i.test(gentle));
check('word budget reaches the prompt', blunt.includes('under 60 words') && gentle.includes('under 300 words'));
check('example lines are injected when present',
  window.Prompt.composeSystem(mk({ tuning: { examples: 'Show me the profile.' } }), ctx).includes('Show me the profile.'));
check('director note is appended per turn, not to the system prompt',
  window.Prompt.directorNote(mk({ tuning: { note: 'Push back more.' } })).includes('Push back more.') &&
  !window.Prompt.composeSystem(mk({ tuning: { note: 'Push back more.' } }), ctx).includes('Push back more.'));

// Talkativeness must bias the floor without starving anyone.
const loud = { persona: mk({ id: 'loud', name: 'Loud', tuning: { talkativeness: 1 } }), spokeAt: 0 };
const quiet = { persona: mk({ id: 'quiet', name: 'Quiet', tuning: { talkativeness: 0 } }), spokeAt: 0 };
const mid = { persona: mk({ id: 'mid', name: 'Mid', tuning: { talkativeness: 0.5 } }), spokeAt: 0 };
const room = [loud, quiet, mid];
T.setSession({ floor: null });
room.forEach((r, i) => { r.spokeAt = i - room.length; });
const tally = {};
let prev = null;
for (let turn = 0; turn < 60; turn++) {
  const sp = T.pickSpeaker(room, prev, turn);
  sp.spokeAt = turn;
  prev = sp.persona.id;
  tally[sp.persona.id] = (tally[sp.persona.id] || 0) + 1;
}
check('talkative member gets the floor most', tally.loud > tally.mid && tally.mid > tally.quiet, JSON.stringify(tally));
check('quiet member is never starved', tally.quiet > 0, `quiet spoke ${tally.quiet || 0} times`);

console.log(failures ? `\n${failures} FAILED` : '\nall dynamics tests passed');
process.exit(failures ? 1 : 0);
