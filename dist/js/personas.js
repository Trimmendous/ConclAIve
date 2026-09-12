// Persona registry: bundled packs, user-authored packs, validation, and the
// per-persona, per-harness model override.
//
// A persona is data, never code. Adding a council member means adding a JSON
// file and an index entry — nothing here needs to change.

window.Personas = (function () {
  'use strict';

  const USER_KEY = 'council_user_personas_v1';
  const OVERRIDE_KEY = 'council_model_overrides_v2';
  const HARNESS_OVERRIDE_KEY = 'council_harness_overrides_v1';

  // Presets are conveniences, not an allowlist. The Settings model field is
  // free-form so new/provider-specific model ids work without an app update.
  const MODELS_BY_HARNESS = {
    codex: [
      { id: 'gpt-6-astra', label: 'GPT-6 Astra — most capable' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra — balanced' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol — reliable' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna — fastest' },
    ],
    opencode: [
      { id: 'openai/gpt-5.6-terra', label: 'OpenAI · GPT-5.6 Terra' },
      { id: 'anthropic/claude-sonnet-4-6', label: 'Anthropic · Claude Sonnet 4.6' },
      { id: 'google/gemini-2.5-pro', label: 'Google · Gemini 2.5 Pro' },
    ],
    'claude-code': [
      { id: 'opus', label: 'Opus — most capable' },
      { id: 'sonnet', label: 'Sonnet — balanced' },
      { id: 'haiku', label: 'Haiku — fastest' },
    ],
  };

  const DEFAULT_MODELS = {
    codex: 'gpt-5.6-terra',
    opencode: 'openai/gpt-5.6-terra',
    'claude-code': 'sonnet',
  };

  function modelsFor(harness) {
    return MODELS_BY_HARNESS[harness] || MODELS_BY_HARNESS.codex;
  }

  function harnessOverrides() {
    return readJSON(HARNESS_OVERRIDE_KEY, {});
  }

  function harnessOverride(persona) {
    const harness = harnessOverrides()[persona.id];
    return MODELS_BY_HARNESS[harness] ? harness : null;
  }

  function effectiveHarness(persona, selectedDefault) {
    return harnessOverride(persona) || selectedDefault || 'codex';
  }

  function setHarness(personaId, harness) {
    const values = harnessOverrides();
    if (!MODELS_BY_HARNESS[harness]) delete values[personaId];
    else values[personaId] = harness;
    localStorage.setItem(HARNESS_OVERRIDE_KEY, JSON.stringify(values));
  }

  const INTERRUPT_STYLES = ['irritated', 'gracious', 'unfazed', 'talks_over'];
  const DEFAULT_MODEL = 'sonnet';

  // How hard the model thinks. Harness adapters translate this to their native
  // effort/variant control when supported; there are deliberately no sampling
  // sliders because the three CLIs do not expose those controls consistently.
  const EFFORTS = [
    { id: 'low', label: 'Low — fast, cheap' },
    { id: 'medium', label: 'Medium — default' },
    { id: 'high', label: 'High — more considered' },
    { id: 'xhigh', label: 'Extra high' },
    { id: 'max', label: 'Max — slowest, priciest' },
  ];

  // Behavioural dials the orchestrator and prompt builder implement themselves.
  const TUNING = {
    talkativeness:   { min: 0, max: 1, step: 0.05, def: 0.5,  label: 'Talkativeness', hint: 'How often the floor comes to them' },
    interruptiveness:{ min: 0, max: 1, step: 0.05, def: 0.25, label: 'Interruptiveness', hint: 'How readily they talk over whoever is speaking' },
    bluntness:       { min: 0, max: 1, step: 0.05, def: 0.5,  label: 'Bluntness', hint: 'Diplomatic at 0, brutal at 1' },
    stubbornness:    { min: 0, max: 1, step: 0.05, def: 0.5,  label: 'Stubbornness', hint: 'How hard it is to change their mind' },
    verbosity:       { min: 40, max: 320, step: 10, def: 130, label: 'Word budget', hint: 'Roughly how long each reply runs' },
  };

  function clampTo(n, spec, fallback) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(spec.max, Math.max(spec.min, v));
  }

  /** Fills the advanced block, honouring values a pack declared the old way. */
  function normalizeTuning(raw, reaction) {
    const t = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    Object.keys(TUNING).forEach((key) => {
      const spec = TUNING[key];
      let fallback = spec.def;
      // interruptiveness lived under `reaction` before the tuning block existed.
      if (key === 'interruptiveness' && reaction && reaction.interruptiveness != null) {
        fallback = Number(reaction.interruptiveness);
      }
      out[key] = clampTo(t[key], spec, fallback);
    });
    out.effort = EFFORTS.some((e) => e.id === t.effort) ? t.effort : 'medium';
    // Few-shot voice anchoring, the single most effective knob for fidelity.
    out.examples = String(t.examples || '').trim();
    // Appended to every turn rather than the system prompt, so it stays close
    // to the model's attention — SillyTavern calls this a depth prompt.
    out.note = String(t.note || '').trim();
    return out;
  }

  function clamp01(n) {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  }

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn(`could not read ${key}`, e);
      return fallback;
    }
  }

  /** Fills defaults and drops anything malformed, so the UI never has to guard. */
  function normalize(raw, builtin) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').trim();
    const name = String(raw.name || '').trim();
    if (!id || !name) return null;
    // Ids become agent ids, which Rust validates as [A-Za-z0-9_-]{1,64}.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;

    const voice = raw.voice || {};
    const reaction = raw.reaction || {};
    const style = INTERRUPT_STYLES.includes(reaction.on_interrupted)
      ? reaction.on_interrupted
      : 'unfazed';

    return {
      id,
      name,
      title: String(raw.title || '').trim(),
      portrait: raw.portrait || null,
      accent: /^#[0-9a-fA-F]{3,8}$/.test(raw.accent || '') ? raw.accent : '#8b8b96',
      model: raw.model || DEFAULT_MODEL,
      voice: {
        system_prompt: String(voice.system_prompt || '').trim(),
        brevity: String(voice.brevity || 'Under 130 words.').trim(),
      },
      reaction: {
        on_interrupted: style,
        interrupt_others: reaction.interrupt_others !== false,
        // How eagerly this person talks over someone who already has the
        // floor, 0..1. Distinct from interrupt_others, which is only whether
        // they ever would. Mirrored into tuning below; packs written before
        // the tuning block still declare it here.
        interruptiveness: clamp01(
          reaction.interruptiveness != null
            ? reaction.interruptiveness
            : reaction.interrupt_others === false ? 0 : 0.25
        ),
      },
      tuning: normalizeTuning(raw.tuning, reaction),
      domains: Array.isArray(raw.domains) ? raw.domains : [],
      builtin: !!builtin,
    };
  }

  let bundledIds = new Set();

  /** True when a persona id also exists as a shipped pack, so it can be reset. */
  function isBundledId(id) {
    return bundledIds.has(id);
  }

  async function loadBundled() {
    const index = await fetch('personas/index.json').then((r) => r.json());
    const files = await Promise.all(
      index.map((id) =>
        fetch(`personas/${id}.json`)
          .then((r) => r.json())
          .catch((e) => {
            console.warn(`persona ${id} failed to load`, e);
            return null;
          })
      )
    );
    const list = files.map((p) => normalize(p, true)).filter(Boolean);
    bundledIds = new Set(list.map((p) => p.id));
    return list;
  }

  function loadUser() {
    return readJSON(USER_KEY, [])
      .map((p) => normalize(p, false))
      .filter(Boolean);
  }

  function saveUser(list) {
    localStorage.setItem(USER_KEY, JSON.stringify(list));
  }

  /** User personas win on id collision, so a duplicate can shadow a bundled one. */
  async function loadAll() {
    const bundled = await loadBundled();
    const user = loadUser();
    const byId = new Map();
    bundled.forEach((p) => byId.set(p.id, p));
    user.forEach((p) => byId.set(p.id, p));
    return Array.from(byId.values());
  }

  // --- model overrides ----------------------------------------------------
  //
  // A persona file ships a sensible default model. The override map lets the
  // user retarget any persona — including bundled, read-only ones — without
  // editing the pack.

  function overrides() {
    return readJSON(OVERRIDE_KEY, {});
  }

  function modelOverride(persona, harness) {
    const o = overrides();
    return o[`${harness || 'claude-code'}:${persona.id}`] || null;
  }

  function effectiveModel(persona, harness, selectedDefault) {
    return modelOverride(persona, harness)
      || selectedDefault
      || DEFAULT_MODELS[harness]
      || DEFAULT_MODEL;
  }

  function setModel(personaId, model, harness) {
    const o = overrides();
    const key = `${harness || 'claude-code'}:${personaId}`;
    if (!model || model === 'default') delete o[key];
    else o[key] = model;
    localStorage.setItem(OVERRIDE_KEY, JSON.stringify(o));
  }

  // --- matching a council to a question -----------------------------------
  //
  // Each persona's `domains` are the vocabulary of the avenue they are good
  // at. Scoring a prompt against them picks a council whose reflexes actually
  // apply, instead of whoever happens to be ticked from last time.

  const GENERIC = ['api', 'data', 'test', 'user', 'design', 'scale', 'deploy', 'error', 'service'];

  const reCache = new Map();

  /**
   * Domain terms are matched at a word boundary, and short ones must match a
   * whole word. Plain substring matching is badly wrong here: a one-letter
   * domain like "C" matches almost any sentence, which quietly put its owner
   * on every council. Longer terms still match as prefixes, so "sanitiz"
   * catches sanitise and sanitization.
   */
  function termRegex(t) {
    let re = reCache.get(t);
    if (!re) {
      const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(t.length <= 2 ? `\\b${esc}\\b` : `\\b${esc}`, 'i');
      reCache.set(t, re);
    }
    return re;
  }

  function scoreAgainst(persona, text) {
    const hay = String(text || '').toLowerCase();
    let score = 0;
    const hits = [];
    (persona.domains || []).forEach((term) => {
      const t = String(term).toLowerCase();
      if (!t || !termRegex(t).test(hay)) return;
      // Longer, more specific vocabulary is stronger evidence than a word like
      // "data" that appears in almost every technical question.
      score += GENERIC.indexOf(t) >= 0 ? 0.35 : 1 + Math.min(t.length, 12) / 24;
      hits.push(t);
    });
    return { score, hits };
  }

  /**
   * Returns the members whose avenue the question actually touches, best first.
   * Falls back to a spread of dispositions when nothing matches, because a
   * council of nobody is worse than a council of generalists.
   */
  // Broadly useful reflexes, used to fill a council out when the question only
  // matches one or two specialists. Ordered so the padding still disagrees
  // with itself: cut scope, demand numbers, imagine the failure.
  const FALLBACK = ['ya-gnee', 'bea-nchmark', 'paige-fault', 'rhea-condition', 'kit-kernel'];

  function suggest(text, list, n) {
    const want = n || 4;
    const picked = list
      .map((p) => ({ persona: p, ...scoreAgainst(p, text) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.persona.name.localeCompare(b.persona.name))
      .slice(0, want);

    // A question that matches exactly one specialist must still keep that
    // specialist — pad around them rather than discarding them for generalists.
    const have = new Set(picked.map((r) => r.persona.id));
    const byId = new Map(list.map((p) => [p.id, p]));
    const pad = FALLBACK.map((id) => byId.get(id)).filter(Boolean).concat(list);
    for (const p of pad) {
      if (picked.length >= want) break;
      if (have.has(p.id)) continue;
      picked.push({ persona: p, score: 0, hits: [] });
      have.add(p.id);
    }
    return picked;
  }

  function upsertUser(persona) {
    const p = normalize(persona, false);
    if (!p) throw new Error('persona is missing an id or name');
    const list = loadUser().filter((x) => x.id !== p.id);
    list.push(p);
    saveUser(list);
    return p;
  }

  function removeUser(id) {
    saveUser(loadUser().filter((p) => p.id !== id));
  }

  /** Copies a bundled persona into user space so it becomes editable. */
  function duplicate(persona) {
    const base = JSON.parse(JSON.stringify(persona));
    let id = `${base.id}-copy`;
    const taken = new Set(loadUser().map((p) => p.id));
    let n = 2;
    while (taken.has(id)) id = `${base.id}-copy-${n++}`;
    base.id = id;
    base.name = `${base.name} (copy)`;
    base.builtin = false;
    return upsertUser(base);
  }

  return {
    MODELS: MODELS_BY_HARNESS['claude-code'],
    MODELS_BY_HARNESS,
    DEFAULT_MODELS,
    modelsFor,
    harnessOverride,
    effectiveHarness,
    setHarness,
    EFFORTS,
    TUNING,
    INTERRUPT_STYLES,
    DEFAULT_MODEL,
    isBundledId,
    suggest,
    scoreAgainst,
    loadAll,
    normalize,
    modelOverride,
    effectiveModel,
    setModel,
    upsertUser,
    removeUser,
    duplicate,
  };
})();
