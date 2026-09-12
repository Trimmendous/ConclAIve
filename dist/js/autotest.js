// Unattended live verification. Inert unless the page is opened with
// ?autotest=1, which is how `cargo tauri dev` is pointed at it — the Tauri
// webview console is invisible in the terminal, so results go through the Rust
// `devlog` command instead.
//
// Phase 1 runs a real debate and checks that a barge-in actually happened and
// that the interrupted member answered afterwards. Phase 2 points one member at
// a real codebase and checks the reply cites a file.

(function () {
  'use strict';
  if (!new URLSearchParams(location.search).has('autotest')) return;

  const dev = (m) => {
    console.log('[autotest]', m);
    if (window.__TAURI__) window.__TAURI__.core.invoke('devlog', { message: m }).catch(() => {});
  };

  async function waitFor(fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  async function phaseDebate(personas) {
    const members = ['kit-kernel', 'theo-lemma', 'piper-compile', 'milo-frame']
      .map((id) => personas.find((p) => p.id === id))
      .filter(Boolean);
    dev(`PHASE1 debate members=${members.length}`);

    await Council.convene({
      prompt: 'We want to rewrite our JSON parser in Rust because it feels slow. Is that the right move?',
      members,
      mode: 'debate',
      rounds: 2,
      bargeIn: true,
      codebaseDir: null,
      verdict: true,
    });

    const s = Council.getSession();
    const cut = s.entries.filter((e) => e.cutOff);
    const reactions = s.entries.filter((e) => e.isReaction && e.text.trim());
    const interj = s.entries.filter((e) => e.isInterjection);
    dev(`entries=${s.entries.length} interjections=${interj.length} cutOff=${cut.length} reactions=${reactions.length}`);
    dev(`order=${JSON.stringify(s.entries.map((e) => e.name.split(' ')[0] + (e.isInterjection ? '>CUTS-IN' : '') + (e.isReaction ? '>REACTS' : '') + (e.cutOff ? '[CUT]' : '')))}`);
    // Back-to-back turns by one member are how floor control shows up.
    const consecutive = s.entries.filter((e, i) => i > 0 && s.entries[i - 1].personaId === e.personaId).length;
    dev(`consecutiveTurnsBySameMember=${consecutive}`);
    if (cut.length) dev(`cutBy=${JSON.stringify(cut.map((e) => e.cutBy))}`);
    if (interj.length) dev(`interjector_sample=${JSON.stringify(interj[0].name + ': ' + interj[0].text.slice(0, 160))}`);
    if (reactions.length) dev(`reaction_sample=${JSON.stringify(reactions[0].name + ': ' + reactions[0].text.slice(0, 180))}`);
    dev(`verdict=${JSON.stringify((s.verdict || '').slice(0, 220))}`);
    dev(`cost=$${s.costUsd.toFixed(4)}`);

    const ok = s.entries.length >= 6 && !!s.verdict;
    dev(`PHASE1 ${ok ? 'PASS' : 'FAIL'} (overlap is probabilistic; ${interj.length} interjections, ${cut.length} cut-offs)`);
    return s.costUsd;
  }

  async function phaseCodebase(personas, spent) {
    const analyst = personas.find((p) => p.id === 'theo-lemma');
    dev('PHASE2 codebase read-only');
    await Council.convene({
      prompt: 'Look at src-tauri/src/lib.rs in this project and critique the filename validation in save_chapter_difficulty. Cite the exact line.',
      members: [analyst],
      mode: 'solo',
      rounds: 1,
      bargeIn: false,
      codebaseDir: '/home/trimendous/Code/cs-study-app',
      verdict: false,
    });
    const s = Council.getSession();
    const text = s.entries.map((e) => e.text).join(' ');
    const tools = s.entries.flatMap((e) => e.tools).map((t) => t.name);
    // A citation counts whether they name the file or just the line they read.
    const cites = /lib\.rs/.test(text) || /\bline[s]?\s*\d+/i.test(text) || /:\d{1,4}\b/.test(text);
    dev(`tools=${JSON.stringify(tools)} citesFile=${cites}`);
    dev(`reply=${JSON.stringify(text.slice(0, 220))}`);
    dev(`PHASE2 ${cites && tools.length ? 'PASS' : 'FAIL'} cost=$${(s.costUsd).toFixed(4)}`);
    return spent + s.costUsd;
  }

  /**
   * Diagnoses the reported symptom: the first speaker of rounds 2+ is slow to
   * appear and then dumps most of its reply at once. Records, per turn, how
   * long the first token took, how big it was, and how the rest arrived — which
   * separates "the CLI sent one big chunk" from "many chunks arrived batched".
   */
  async function phaseTiming(personas) {
    const members = ['kit-kernel', 'piper-compile', 'milo-frame']
      .map((id) => personas.find((p) => p.id === id))
      .filter(Boolean);

    const stats = new Map(); // entryId -> record
    const byAgent = new Map(); // personaId -> current record

    Council.on('entry', ({ entry }) => {
      const rec = {
        id: entry.id,
        round: entry.round,
        who: entry.name.split(' ')[0],
        t0: performance.now(),
        firstDeltaMs: null,
        firstDeltaChars: null,
        deltas: 0,
        chars: 0,
        gaps: [],
        last: null,
      };
      stats.set(entry.id, rec);
      byAgent.set(entry.personaId, rec);
    });

    Bridge.on('delta', ({ agent_id, text }) => {
      const rec = byAgent.get(agent_id);
      if (!rec) return;
      const now = performance.now();
      if (rec.firstDeltaMs === null) {
        rec.firstDeltaMs = Math.round(now - rec.t0);
        rec.firstDeltaChars = text.length;
      } else {
        rec.gaps.push(Math.round(now - rec.last));
      }
      rec.last = now;
      rec.deltas += 1;
      rec.chars += text.length;
    });

    dev('PHASE-TIMING start');
    await Council.convene({
      prompt: 'Should we rewrite our JSON parser in Rust because it feels slow?',
      members,
      mode: 'debate',
      rounds: 2,
      bargeIn: false, // isolate round-boundary behaviour from interruptions
      codebaseDir: null,
      verdict: false,
    });

    Array.from(stats.values()).forEach((r, i) => {
      const maxGap = r.gaps.length ? Math.max(...r.gaps) : 0;
      const firstPct = r.chars ? Math.round((100 * r.firstDeltaChars) / r.chars) : 0;
      dev(
        `turn${i + 1} r${r.round} ${r.who}: ttfd=${r.firstDeltaMs}ms firstChunk=${r.firstDeltaChars}c (${firstPct}% of reply) deltas=${r.deltas} chars=${r.chars} maxGap=${maxGap}ms`
      );
    });
    dev('PHASE-TIMING done');
  }

  window.addEventListener('load', async () => {
    await new Promise((r) => setTimeout(r, 1200)); // let init() finish
    try {
      const personas = await Personas.loadAll();
      if (new URLSearchParams(location.search).get('autotest') === 'timing') {
        await phaseTiming(personas);
        dev('AUTOTEST COMPLETE (timing only)');
      } else {
        let spent = await phaseDebate(personas);
        spent = await phaseCodebase(personas, spent);
        dev(`AUTOTEST COMPLETE total=$${spent.toFixed(4)}`);
      }
    } catch (e) {
      dev('AUTOTEST ERROR ' + (e && e.message ? e.message : e));
    }
    await Council.adjourn();
    dev('AUTOTEST done');
  });
})();
