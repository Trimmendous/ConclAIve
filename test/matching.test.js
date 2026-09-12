// Does the avenue mapping actually route a question to the right reflexes?
//
// Each case states a realistic question and who must appear in the suggested
// council. These are the claims the README's mapping table makes, checked.

const fs = require('fs');
const path = require('path');
const DIST = path.join(__dirname, '..', 'dist');

global.window = {};
global.localStorage = { getItem: () => null, setItem: () => {} };
global.location = { search: '' };
global.URLSearchParams = URLSearchParams;
new Function(fs.readFileSync(path.join(DIST, 'js/personas.js'), 'utf8'))();
const P = window.Personas;

const ids = JSON.parse(fs.readFileSync(path.join(DIST, 'personas/index.json'), 'utf8'));
const all = ids.map((id) =>
  P.normalize(JSON.parse(fs.readFileSync(path.join(DIST, `personas/${id}.json`), 'utf8')), true)
);

let failures = 0;
function expect(question, mustInclude) {
  const picks = P.suggest(question, all, 4).map((r) => r.persona.id);
  const missing = mustInclude.filter((id) => !picks.includes(id));
  const ok = missing.length === 0;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${question.slice(0, 54)}…\n        → ${picks.join(', ')}` +
      (ok ? '' : `\n        MISSING: ${missing.join(', ')}`)
  );
}

expect('Users can paste HTML into the comment box and we render it. Is that ok?', ['bobby-tables']);
expect('Two workers pull the same job off the queue and both mark it done.', ['rhea-condition']);
expect('The report page feels slow once an account has a lot of history.', ['bea-nchmark']);
expect('We loop over every order and run a query inside the loop to fetch the customer.', ['bill-o-notation']);
expect('What happens to in-flight uploads if the disk fills during a deploy?', ['paige-fault']);
expect('Should we add a plugin system so future integrations are easier to build?', ['ya-gnee']);
expect('Should we split the billing module into its own service with its own database?', ['mo-nolith', 'mike-roservice']);
expect('Our CI suite goes red maybe one run in five and everyone just retries it.', ['flake-e-test']);
expect('The modal traps focus and the close control is only indicated by colour.', ['axel-ess']);
expect('Customer address is stored on the order row and also on the customer row.', ['norm-alization']);
expect('It crashes intermittently in production but we cannot reproduce it locally.', ['stacy-trace']);
expect('If we rename this endpoint field, what happens to clients on the old SDK?', ['vera-sion']);

// A question with no technical vocabulary must still return a usable council.
const vague = P.suggest('what do you think of my idea', all, 4);
const vagueOk = vague.length >= 3;
if (!vagueOk) failures++;
console.log(`${vagueOk ? 'PASS' : 'FAIL'}  vague question still yields a council → ${vague.map(r=>r.persona.id).join(', ')}`);

// Specialists must beat generalists on their own turf.
const sec = P.scoreAgainst(all.find((p) => p.id === 'bobby-tables'), 'sql injection via untrusted user input');
const gen = P.scoreAgainst(all.find((p) => p.id === 'kit-kernel'), 'sql injection via untrusted user input');
const beats = sec.score > gen.score;
if (!beats) failures++;
console.log(`${beats ? 'PASS' : 'FAIL'}  specialist outscores generalist on their avenue (${sec.score.toFixed(2)} vs ${gen.score.toFixed(2)})`);

console.log(failures ? `\n${failures} FAILED` : '\nall matching tests passed');
process.exit(failures ? 1 : 0);
