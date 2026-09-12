// The only module that talks to Rust.
//
// Exposes one async API in two implementations: a real one backed by Tauri
// `invoke` + `council://` events, and a mock that replays canned streaming
// transcripts. The mock exists so the entire UI — tiles, bubbles, cut-off
// rendering, theming, responsive layout — can be built and verified under a
// plain static server at zero API cost. Add `?mock=1` to force it; it also
// engages automatically when the page is opened outside Tauri.

window.Bridge = (function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const hasTauri = !!(window.__TAURI__ && window.__TAURI__.core);
  const MOCK = params.has('mock') || !hasTauri;

  // --- tiny event emitter -------------------------------------------------

  const handlers = { delta: [], tool: [], turn_end: [], error: [], exit: [] };

  function on(name, fn) {
    (handlers[name] || (handlers[name] = [])).push(fn);
    return () => off(name, fn);
  }

  function off(name, fn) {
    const list = handlers[name];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  function emit(name, payload) {
    (handlers[name] || []).forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        console.error(`bridge handler for "${name}" threw`, e);
      }
    });
  }

  // --- real implementation ------------------------------------------------

  const real = (function () {
    if (!hasTauri) return null;
    const { invoke } = window.__TAURI__.core;
    const { listen } = window.__TAURI__.event;

    ['delta', 'tool', 'turn_end', 'error', 'exit'].forEach((name) => {
      listen(`council://${name}`, (e) => emit(name, e.payload));
    });

    return {
      spawn: (agentId, harness, systemPrompt, model, codebaseDir, effort) =>
        invoke('agent_spawn', {
          agentId,
          harness: harness || 'codex',
          systemPrompt,
          model,
          codebaseDir: codebaseDir || null,
          effort: effort || 'medium',
        }),
      send: (agentId, text) => invoke('agent_send', { agentId, text }),
      interrupt: (agentId) => invoke('agent_interrupt', { agentId }),
      kill: (agentId) => invoke('agent_kill', { agentId }),
      killAll: () => invoke('agent_kill_all'),
    };
  })();

  // --- mock implementation ------------------------------------------------

  const mock = (function () {
    // Flavoured so mock screenshots read like a real council rather than lorem
    // ipsum. Keyed by a substring of the agent id.
    const CORPUS = {
      // The neutral clerk that closes a debate; keyed off the 'council-clerk' id.
      clerk: [
        'AGREED: everyone accepts that the problem should be demonstrated with a measurement before any redesign is attempted.\nSPLIT: Kit and Milo want the simplest version shipped and profiled; Theo and Clara want the invariant stated and checked first. Piper sits closer to shipping but wants the failure modes watched.\nPATH: write the naive implementation, profile it against a realistic workload, and only then decide whether the abstraction earns its cost.',
      ],
      kit: [
        "This is a solution in search of a problem. You haven't measured anything, you've just decided the abstraction is pretty. Show me a profile where this is the bottleneck and then we can talk about rewriting it.",
        "No. Absolutely not. You're adding an indirection layer so you can avoid understanding the code underneath it, and in six months nobody will understand either layer.",
      ],
      theo: [
        "Let us be precise about what is being claimed. The assertion is that the average case is logarithmic, but the analysis assumes a uniform distribution of keys, which the problem statement does not guarantee. Without that hypothesis the bound does not follow.",
        "I would want to see the invariant stated formally before optimizing. Premature optimization is the root of all evil, yes — but so is premature generalization, and this design commits the second sin to avoid the first.",
      ],
      piper: [
        "Ship the simple version, watch what actually breaks, and let the failures tell you where the complexity belongs. You will guess wrong about that if you only reason about it.",
        "Habit is not a technical constraint. That said, the existing approach here works, and 'works' is not nothing. What specifically is failing?",
      ],
      clara: [
        "The question is not whether the program is fast but whether it is correct, and this one cannot be shown to be correct because its state space has not been constrained. Testing shows the presence of bugs, never their absence.",
        "Simplicity is a prerequisite for reliability. What has been proposed is not simple; it is merely familiar, and those are very different properties.",
      ],
      milo: [
        "I'd just write the dumb version first and measure it. Modern hardware is fast enough that the naive loop is probably fine, and if it isn't, the profile will point straight at the line that matters instead of the one you guessed.",
        "The complexity budget is real. Every abstraction you add here costs you debugging time later, and I don't see the payoff yet.",
      ],
      _default: [
        "There's a reasonable case on both sides, but the proposal skips the step where you demonstrate the problem is real. Establish that first and the right design tends to become obvious.",
        "I'd push back on the framing. The constraint you're treating as fixed is the one most worth questioning here.",
      ],
    };

    const INTERRUPT_REACTIONS = {
      irritated: [
        "— I wasn't finished. As I was saying, before the enthusiasm arrived: the measurement comes first. Everything else is decoration.",
        "— Let me finish a sentence. You're arguing against a position I hadn't stated yet.",
      ],
      gracious: [
        "— no, go on, that's a fair point and it actually sharpens mine. Let me put it differently, then.",
        "— you're right to jump in there. I was overstating it.",
      ],
      unfazed: [
        "As I was saying. The argument does not change because it was interrupted.",
        "That does not alter the conclusion. Continuing:",
      ],
      talks_over: [
        "— I'm still talking. And what you just said is exactly the mistake I was describing.",
        "— no, listen, this is the part that matters and you're stepping on it.",
      ],
    };

    const agents = new Map();
    let seq = 0;

    function corpusFor(agentId) {
      const key = Object.keys(CORPUS).find((k) => agentId.includes(k));
      return CORPUS[key] || CORPUS._default;
    }

    function stop(state) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.streaming = false;
    }

    function streamText(agentId, state, text) {
      const words = text.split(' ');
      let i = 0;
      state.streaming = true;
      state.cost = 0.0016 + Math.random() * 0.0008;

      const tick = () => {
        if (!state.streaming) return;
        if (i >= words.length) {
          stop(state);
          emit('turn_end', {
            agent_id: agentId,
            text,
            cost_usd: state.cost,
            input_tokens: 240,
            cached_input_tokens: 0,
            output_tokens: Math.max(1, Math.round(text.length / 4)),
            interrupted: false,
            is_error: false,
          });
          return;
        }
        const chunk = words[i++] + (i < words.length ? ' ' : '');
        emit('delta', { agent_id: agentId, text: chunk });
        // Paced to match observed live generation (~130 words in 6-10s) so the
        // mock rehearses the real turn-taking and interjection timing rather
        // than finishing before anyone could cut in.
        state.timer = setTimeout(tick, 60 + Math.random() * 80);
      };

      // "Thinking" pause before the first token, staggered per agent.
      state.timer = setTimeout(tick, 350 + Math.random() * 900);
    }

    return {
      spawn(agentId, harness, systemPrompt, model, codebaseDir, effort) {
        agents.set(agentId, { streaming: false, timer: null, codebaseDir, effort });
        return Promise.resolve();
      },
      send(agentId, text) {
        const state = agents.get(agentId);
        if (!state) return Promise.reject(new Error(`no such agent: ${agentId}`));
        stop(state);

        let reply;
        if (text.includes('[INTERRUPTED]')) {
          const styleMatch = /style:\s*(\w+)/.exec(text);
          const pool =
            INTERRUPT_REACTIONS[styleMatch && styleMatch[1]] || INTERRUPT_REACTIONS.irritated;
          reply = pool[seq++ % pool.length];
        } else {
          const pool = corpusFor(agentId);
          reply = pool[seq++ % pool.length];
        }

        if (state.codebaseDir) {
          setTimeout(
            () => emit('tool', { agent_id: agentId, name: 'Grep', detail: 'src-tauri/src/lib.rs' }),
            250
          );
        }
        streamText(agentId, state, reply);
        return Promise.resolve();
      },
      interrupt(agentId) {
        const state = agents.get(agentId);
        if (!state || !state.streaming) return Promise.resolve();
        stop(state);
        emit('turn_end', {
          agent_id: agentId,
          text: '',
          cost_usd: state.cost || 0.0012,
          input_tokens: 120,
          cached_input_tokens: 0,
          output_tokens: Math.max(1, Math.round((state.partial || '').length / 4)),
          interrupted: true,
          is_error: false,
        });
        return Promise.resolve();
      },
      kill(agentId) {
        const state = agents.get(agentId);
        if (state) stop(state);
        agents.delete(agentId);
        emit('exit', { agent_id: agentId });
        return Promise.resolve();
      },
      killAll() {
        Array.from(agents.keys()).forEach((id) => this.kill(id));
        return Promise.resolve();
      },
    };
  })();

  const impl = MOCK ? mock : real;

  return {
    isMock: MOCK,
    on,
    off,
    spawn: (...a) => impl.spawn(...a),
    send: (...a) => impl.send(...a),
    interrupt: (...a) => impl.interrupt(...a),
    kill: (...a) => impl.kill(...a),
    killAll: () => impl.killAll(),
  };
})();
