// Session orchestrator: spawns the council, runs rounds, and arbitrates
// interruptions.
//
// Personas think genuinely in parallel — each is its own OS process — so this
// module is written around the fact that several turns are in flight at once
// and may finish in any order.

window.Council = (function () {
  'use strict';

  // Guards that keep a round terminating. Without them a barge-in cascade can
  // loop forever: A cuts off B, B's reaction cuts off A, and so on.
  const MAX_INTERRUPTS_PER_PERSONA_PER_ROUND = 1;
  const ROUND_TIMEOUT_MS = 180000;

  // How long someone holds the floor before anyone considers cutting in, and
  // how often we re-check afterwards. A single timed check is not enough: at a
  // fixed moment the speaker may not have said enough to be worth interrupting
  // yet, and giving up then means nobody ever cuts in.
  const INTERJECT_AFTER_MS = 2000;
  const INTERJECT_POLL_MS = 500;

  // Global damping on top of each persona's own eagerness, so overlap stays
  // occasional rather than routine. Raising this makes the room rowdier.
  const INTERJECT_BASE = 0.6;

  // Turns a member keeps driving after they successfully cut someone off.
  const FLOOR_CONTROL_TURNS = 2;
  const FLOOR_CONTROL_BIAS = 0.65;

  // Cutting someone off two words in reads as a glitch rather than an
  // interruption. Let them get a thought out first.
  const MIN_CHARS_BEFORE_INTERRUPT = 120;

  // A council can collapse into mutual echo: one member answers tersely or
  // refuses to engage, the next sees that in the transcript and mirrors it,
  // and within a few turns everyone is saying the same empty thing. The
  // protocol forbids it, but models converge anyway, so it is also caught
  // here — otherwise the session burns every remaining round, and real money,
  // producing nothing.
  const STALL_WORD_LIMIT = 28;
  const STALL_SIMILARITY = 0.45;
  const STALL_STREAK_LIMIT = 3;

  const ABSTENTION = /\b(nothing (further |more )?to add|no notes|nothing to say|i (fully )?agree with (the above|everyone)|no objection here|seconded|as (above|stated)|likewise|same)\b/i;

  let session = null;
  let runtimes = new Map(); // personaId -> runtime
  let listeners = {};
  let entrySeq = 0;
  let bound = false;

  function emit(name, payload) {
    (listeners[name] || []).forEach((fn) => {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  }

  function on(name, fn) {
    (listeners[name] || (listeners[name] = [])).push(fn);
  }

  function getSession() { return session; }

  // --- bridge wiring ------------------------------------------------------

  function bindBridge() {
    if (bound) return;
    bound = true;

    Bridge.on('delta', ({ agent_id, text }) => {
      const rt = runtimes.get(agent_id);
      if (!rt || !rt.entry) return;
      rt.buffer += text;
      rt.entry.text = rt.buffer;
      if (rt.state !== 'streaming') {
        rt.state = 'streaming';
        emit('state', { personaId: rt.persona.id, state: 'streaming' });
      }
      emit('delta', { personaId: rt.persona.id, entry: rt.entry });
    });

    Bridge.on('tool', ({ agent_id, name, detail }) => {
      const rt = runtimes.get(agent_id);
      if (!rt || !rt.entry) return;
      rt.entry.tools.push({ name, detail });
      emit('tool', { personaId: rt.persona.id, entry: rt.entry });
    });

    Bridge.on('turn_end', (p) => onTurnEnd(p));

    Bridge.on('error', ({ agent_id, message }) => {
      console.warn(`[${agent_id}] ${message}`);
      emit('error', { personaId: agent_id, message });
    });
  }

  // --- turns --------------------------------------------------------------

  function startTurn(rt, message, meta) {
    rt.buffer = '';
    rt.state = 'thinking';
    rt.entry = {
      id: `e${++entrySeq}`,
      personaId: rt.persona.id,
      name: rt.persona.name,
      accent: rt.persona.accent,
      round: session.round,
      text: '',
      cutOff: false,
      cutBy: null,
      isReaction: !!(meta && meta.isReaction),
      isInterjection: !!(meta && meta.isInterjection),
      tools: [],
      done: false,
    };
    session.entries.push(rt.entry);
    rt.active = true;
    emit('entry', { entry: rt.entry });
    emit('state', { personaId: rt.persona.id, state: 'thinking' });
    Bridge.send(rt.persona.id, message).catch((e) => {
      console.error('send failed', e);
      rt.entry.text = rt.entry.text || `[could not reach ${rt.persona.name}: ${e}]`;
      finishTurn(rt, { interrupted: false, cost_usd: 0 });
    });
  }

  function finishTurn(rt, p) {
    rt.entry.done = true;
    rt.active = false;
    rt.state = 'done';
    // Interrupted turns are cut short by design, so they are not evidence of a
    // stall and must not count toward the streak.
    if (!rt.entry.cutOff) noteStall(rt.entry);
    session.costUsd += p.cost_usd || 0;
    session.inputTokens += p.input_tokens || 0;
    session.cachedInputTokens += p.cached_input_tokens || 0;
    session.outputTokens += p.output_tokens || 0;
    emitUsage();
    emit('entryEnd', { entry: rt.entry });
    emit('state', { personaId: rt.persona.id, state: 'done' });
    checkRoundComplete();
  }

  function emitUsage() {
    emit('cost', {
      total: session.costUsd,
      inputTokens: session.inputTokens,
      cachedInputTokens: session.cachedInputTokens,
      outputTokens: session.outputTokens,
    });
  }

  function onTurnEnd(p) {
    const rt = runtimes.get(p.agent_id);
    if (!rt || !rt.entry) return;

    // A completed turn reports its full text; an interrupted one reports
    // nothing, so the streamed buffer is all we have of what they were saying.
    const finalText = (p.text && p.text.trim()) || rt.buffer;
    rt.entry.text = finalText;

    if (p.interrupted) {
      rt.entry.cutOff = true;
      const pending = rt.pendingInterruption;
      rt.pendingInterruption = null;

      if (pending) {
        rt.entry.cutBy = pending.byName;
        rt.entry.done = true;
        emit('entryEnd', { entry: rt.entry });
        // They were cut off, they are told who did it and what was said, and
        // they answer in character. This second turn keeps the round open.
        rt.reacting = true;
        startTurn(
          rt,
          Prompt.interruption(rt.persona, pending.byName, finalText, pending.theirText),
          { isReaction: true }
        );
        return;
      }
      finishTurn(rt, p);
      return;
    }

    // The interrupt was sent but they finished before it landed — drop it, or
    // it would fire against their next turn instead.
    rt.pendingInterruption = null;
    rt.reacting = false;
    finishTurn(rt, p);
    maybeBargeIn(rt, finalText);
  }

  /**
   * Called when someone finishes speaking while others are still talking.
   * At most one person gets cut off per finisher — cutting off the whole room
   * at once is unreadable.
   */
  function maybeBargeIn(finisher, text) {
    if (!session || !session.opts.bargeIn || session.mode !== 'debate') return;
    if (!finisher.persona.reaction.interrupt_others) return;
    if (!text || !text.trim()) return;

    for (const rt of runtimes.values()) {
      if (rt === finisher) continue;
      if (rt.state !== 'streaming') continue;      // never cut off silence
      if (rt.reacting) continue;                   // not while they answer a cut-off
      if (rt.pendingInterruption) continue;        // already being cut off
      if (rt.buffer.length < MIN_CHARS_BEFORE_INTERRUPT) continue;
      if (rt.interruptsThisRound >= MAX_INTERRUPTS_PER_PERSONA_PER_ROUND) continue;

      rt.interruptsThisRound += 1;
      rt.pendingInterruption = { byName: finisher.persona.name, theirText: text };
      // Cutting someone off wins you the floor for a beat — this is what makes
      // an interruption change the direction of the argument rather than just
      // interrupting it.
      session.floor = { id: finisher.persona.id, turns: FLOOR_CONTROL_TURNS };
      emit('state', { personaId: rt.persona.id, state: 'cut' });
      Bridge.interrupt(rt.persona.id).catch((e) => {
        console.error('interrupt failed', e);
        rt.pendingInterruption = null;
      });
      return;
    }
  }

  /** The chair cutting someone off by hand, from the UI. */
  function chairInterrupt(personaId, chairText) {
    const rt = runtimes.get(personaId);
    if (!rt || rt.state !== 'streaming' || rt.reacting) return false;
    rt.pendingInterruption = {
      byName: 'the chair',
      theirText: chairText || 'Hold on — let me stop you there.',
    };
    emit('state', { personaId, state: 'cut' });
    Bridge.interrupt(personaId).catch(() => { rt.pendingInterruption = null; });
    return true;
  }

  // --- rounds -------------------------------------------------------------

  let roundResolve = null;

  function checkRoundComplete() {
    if (!roundResolve) return;
    const anyActive = Array.from(runtimes.values()).some((rt) => rt.active);
    if (!anyActive) {
      const r = roundResolve;
      roundResolve = null;
      r();
    }
  }

  function waitForRound() {
    return new Promise((resolve) => {
      roundResolve = resolve;
      const timer = setTimeout(() => {
        // Force-settle stragglers so one wedged process cannot hang the council.
        runtimes.forEach((rt) => {
          if (rt.active) {
            rt.pendingInterruption = null;
            Bridge.interrupt(rt.persona.id).catch(() => {});
          }
        });
      }, ROUND_TIMEOUT_MS);
      const orig = resolve;
      roundResolve = () => { clearTimeout(timer); orig(); };
      checkRoundComplete();
    });
  }

  /** What a persona has not yet heard, so nobody is re-fed their own words. */
  function unseenFor(rt) {
    const out = [];
    for (let i = rt.lastSeen; i < session.entries.length; i++) {
      const e = session.entries[i];
      if (!e.done) continue;
      if (e.personaId === rt.persona.id) continue;
      if (!e.text || !e.text.trim()) continue;
      out.push({ name: e.name, text: e.text, cutOff: e.cutOff });
    }
    rt.lastSeen = session.entries.length;
    return out;
  }

  // --- lifecycle ----------------------------------------------------------

  async function convene(opts) {
    await adjourn();
    bindBridge();

    session = {
      chairPrompt: opts.prompt,
      mode: opts.mode,
      members: opts.members,
      round: 0,
      totalRounds: opts.mode === 'solo' ? 1 : opts.rounds,
      entries: [],
      verdict: null,
      costUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      running: true,
      floor: null,
      stalled: false,
      stalledStreak: 0,
      opts,
    };
    runtimes = new Map();
    entrySeq = 0;

    const ctx = {
      mode: opts.mode,
      members: opts.members,
      codebaseDir: opts.codebaseDir || null,
    };

    // Spawn every member up front so round 1 starts them all at once.
    for (const persona of opts.members) {
      const rt = {
        persona,
        state: 'idle',
        buffer: '',
        entry: null,
        active: false,
        reacting: false,
        interruptsThisRound: 0,
        pendingInterruption: null,
        lastSeen: 0,
      };
      runtimes.set(persona.id, rt);
      const harness = Personas.effectiveHarness(persona, opts.harness);
      const defaultModel = (opts.harnessModels && opts.harnessModels[harness])
        || Personas.DEFAULT_MODELS[harness];
      await Bridge.spawn(
        persona.id,
        harness,
        Prompt.composeSystem(persona, ctx),
        Personas.effectiveModel(persona, harness, defaultModel),
        opts.codebaseDir || null,
        (persona.tuning && persona.tuning.effort) || 'medium'
      );
    }

    emit('start', { session });

    if (session.mode === 'solo') {
      // Solo critique is the one case where everyone genuinely does speak at
      // once: they are reviewing independently and never hear each other.
      session.round = 1;
      emit('round', { round: 1 });
      runtimes.forEach((rt) => startTurn(rt, Prompt.opening(opts.prompt, ctx)));
      await waitForRound();
    } else {
      await runConversation(opts, ctx);
    }

    if (session.running && opts.verdict !== false && session.entries.length) {
      await runVerdict(opts);
    }

    session.running = false;
    emit('end', { session });
  }

  // --- conversation dynamics (debate mode) --------------------------------
  //
  // Members do not all speak every round. One holds the floor at a time; the
  // others occasionally cut in over them, and how often is a property of the
  // person rather than a global setting. Whoever wins an interruption keeps
  // driving for a beat afterwards.

  function words(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  }

  /** Jaccard overlap of word sets — cheap and good enough to spot mirroring. */
  function similarity(a, b) {
    const A = new Set(words(a));
    const B = new Set(words(b));
    if (!A.size || !B.size) return 0;
    let shared = 0;
    A.forEach((w) => { if (B.has(w)) shared++; });
    return shared / (A.size + B.size - shared);
  }

  /**
   * A turn is degenerate if it is short and either refuses to engage or simply
   * restates a recent turn. Length alone is not enough — a short, sharp
   * objection is exactly what these personas should produce.
   */
  function isDegenerate(entry, recent) {
    const n = words(entry.text).length;
    if (n === 0) return true;
    if (n > STALL_WORD_LIMIT) return false;
    if (ABSTENTION.test(entry.text)) return true;
    return recent.some((prev) => similarity(entry.text, prev.text) >= STALL_SIMILARITY);
  }

  function noteStall(entry) {
    const recent = session.entries
      .filter((e) => e !== entry && e.done && e.text && e.text.trim())
      .slice(-4);

    if (isDegenerate(entry, recent)) {
      session.stalledStreak = (session.stalledStreak || 0) + 1;
      if (session.stalledStreak >= STALL_STREAK_LIMIT && !session.stalled) {
        session.stalled = true;
        emit('stalled', {
          reason:
            'The council started echoing itself — several members in a row said nothing new. ' +
            'Stopped early rather than spend the remaining rounds on it. A more specific question usually fixes this.',
        });
      }
    } else {
      session.stalledStreak = 0;
    }
  }

  function clearTimers(handle) {
    if (!handle.timer) return;
    clearTimeout(handle.timer);
    clearInterval(handle.timer);
    handle.timer = null;
  }

  function interruptiveness(rt) {
    const t = rt.persona.tuning || {};
    if (t.interruptiveness != null) return t.interruptiveness;
    return (rt.persona.reaction && rt.persona.reaction.interruptiveness) || 0;
  }

  function talkativeness(rt) {
    const t = rt.persona.tuning || {};
    return t.talkativeness == null ? 0.5 : t.talkativeness;
  }

  function pickSpeaker(all, lastSpeakerId, turn) {
    const eligible = all.filter((rt) => rt.persona.id !== lastSpeakerId);
    const pool = eligible.length ? eligible : all;

    if (session.floor && session.floor.turns > 0) {
      const holder = pool.find((rt) => rt.persona.id === session.floor.id);
      session.floor.turns -= 1;
      if (holder && Math.random() < FLOOR_CONTROL_BIAS) return holder;
    }

    // Pressure grows with silence and is amplified by how talkative someone is.
    // A quiet member still reaches the floor eventually — their pressure keeps
    // rising — so talkativeness biases the order without starving anyone.
    const now = typeof turn === 'number' ? turn : 0;
    let best = pool[0];
    let bestPressure = -Infinity;
    pool.forEach((rt) => {
      const waited = Math.max(0, now - rt.spokeAt);
      const pressure = waited * (0.35 + talkativeness(rt));
      if (pressure > bestPressure) { bestPressure = pressure; best = rt; }
    });
    return best;
  }

  function weightedPick(candidates) {
    const total = candidates.reduce((sum, rt) => sum + interruptiveness(rt), 0);
    if (total <= 0) return null;
    let r = Math.random() * total;
    for (const rt of candidates) {
      r -= interruptiveness(rt);
      if (r <= 0) return rt;
    }
    return candidates[candidates.length - 1];
  }

  /**
   * Rolls, once, for somebody to talk over the current speaker. Two people
   * streaming at once is the overlap; the existing barge-in logic then decides
   * who actually loses the floor.
   */
  function scheduleInterjection(all, speaker) {
    const handle = { timer: null, used: false, cancel() { clearTimers(handle); } };
    if (!session.opts.bargeIn) return handle;

    const candidates = all.filter(
      (rt) => rt !== speaker && !rt.active && interruptiveness(rt) > 0
    );
    if (!candidates.length) return handle;

    // Hold off until the speaker is genuinely mid-thought, then take exactly
    // one personality-weighted roll. Polling matters: at any single fixed
    // moment the speaker may not have said enough yet, and giving up then
    // means nobody ever cuts in. Rolling once — rather than once per tick —
    // keeps interrupting a chance rather than an eventual certainty.
    const attempt = () => {
      if (!session || !session.running) return clearTimers(handle);
      if (speaker.state !== 'streaming') return clearTimers(handle);
      if (speaker.buffer.length < MIN_CHARS_BEFORE_INTERRUPT) return;

      clearTimers(handle);
      const pick = weightedPick(candidates);
      if (!pick || pick.active) return;
      if (Math.random() >= interruptiveness(pick) * INTERJECT_BASE) return;

      handle.used = true;
      startTurn(
        pick,
        Prompt.interject(unseenFor(pick), speaker.persona.name, speaker.buffer),
        { isInterjection: true }
      );
    };

    handle.timer = setTimeout(() => {
      handle.timer = setInterval(attempt, INTERJECT_POLL_MS);
      attempt();
    }, INTERJECT_AFTER_MS);

    return handle;
  }

  async function runConversation(opts, ctx) {
    const all = Array.from(runtimes.values());
    const perRound = all.length;
    const totalTurns = Math.max(1, opts.rounds || 3) * perRound;
    let taken = 0;
    let lastSpeakerId = null;

    // Seed speaking order so the first pass follows the roster.
    all.forEach((rt, i) => { rt.spokeAt = i - perRound; });

    while (taken < totalTurns && session.running && !session.stalled) {
      const round = Math.min(session.totalRounds, Math.floor(taken / perRound) + 1);
      if (round !== session.round) {
        session.round = round;
        emit('round', { round });
        runtimes.forEach((rt) => { rt.interruptsThisRound = 0; });
      }

      const speaker = taken === 0 ? all[0] : pickSpeaker(all, lastSpeakerId, taken);
      const message =
        (taken === 0
          ? Prompt.opening(opts.prompt, ctx)
          : Prompt.roundBroadcast(unseenFor(speaker), round)) +
        Prompt.directorNote(speaker.persona);

      startTurn(speaker, message);
      speaker.spokeAt = taken;
      lastSpeakerId = speaker.persona.id;
      taken += 1;

      const interjection = scheduleInterjection(all, speaker);
      await waitForRound();
      if (interjection.cancel) interjection.cancel();
      if (interjection.used) taken += 1;
    }
  }

  /** A neutral clerk, not a council member — spawned only for the summary. */
  async function runVerdict(opts) {
    const VERDICT_ID = 'council-clerk';
    emit('verdictStart', {});
    try {
      await Bridge.spawn(
        VERDICT_ID,
        opts.harness,
        Prompt.verdictSystem(),
        opts.defaultModel,
        null,
        'medium'
      );
      const transcript = session.entries
        .filter((e) => e.text && e.text.trim())
        .map((e) => ({ name: e.name, text: e.text }));

      const text = await new Promise((resolve) => {
        let buf = '';
        const offD = Bridge.on('delta', (p) => {
          if (p.agent_id === VERDICT_ID) { buf += p.text; emit('verdictDelta', { text: buf }); }
        });
        const offE = Bridge.on('turn_end', (p) => {
          if (p.agent_id !== VERDICT_ID) return;
          session.costUsd += p.cost_usd || 0;
          session.inputTokens += p.input_tokens || 0;
          session.cachedInputTokens += p.cached_input_tokens || 0;
          session.outputTokens += p.output_tokens || 0;
          emitUsage();
          offD(); offE();
          resolve((p.text && p.text.trim()) || buf);
        });
        Bridge.send(VERDICT_ID, Prompt.verdictRequest(session.chairPrompt, transcript));
      });

      session.verdict = text;
      emit('verdict', { text });
    } catch (e) {
      console.error('verdict failed', e);
    } finally {
      await Bridge.kill(VERDICT_ID).catch(() => {});
    }
  }

  async function adjourn() {
    if (session) session.running = false;
    if (roundResolve) { const r = roundResolve; roundResolve = null; r(); }
    runtimes.forEach((rt) => { rt.active = false; });
    await Bridge.killAll().catch(() => {});
    runtimes = new Map();
  }

  // Exposed for the deterministic dynamics tests in test/dynamics.test.js.
  // Timer-driven behaviour cannot be measured reliably in a hidden browser
  // tab (timers there are throttled to seconds), so the selection and
  // probability logic is verified directly instead.
  const __test = {
    weightedPick,
    interruptiveness,
    pickSpeaker,
    similarity,
    isDegenerate,
    talkativeness,
    constants: {
      INTERJECT_BASE,
      MIN_CHARS_BEFORE_INTERRUPT,
      FLOOR_CONTROL_TURNS,
      FLOOR_CONTROL_BIAS,
      MAX_INTERRUPTS_PER_PERSONA_PER_ROUND,
    },
    setSession(s) { session = s; },
  };

  return { on, convene, adjourn, chairInterrupt, getSession, __test };
})();
