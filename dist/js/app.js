// Bootstrap: themes, roster, settings, and wiring council events into the
// active view.

(function () {
  'use strict';
  const { el, portrait } = UI;
  const $ = (id) => document.getElementById(id);

  const SETTINGS_KEY = 'council_settings_v1';
  const ENABLED_KEY = 'council_enabled_v1';

  const DEFAULTS = {
    theme: 'system',
    mode: 'debate',
    view: 'live',
    rounds: 3,
    bargeIn: true,
    codebaseDir: '',
    verdict: true,
    harness: 'codex',
    harnessModels: {
      codex: 'gpt-5.6-terra',
      opencode: 'openai/gpt-5.6-terra',
      'claude-code': 'sonnet',
    },
  };

  let settings = load(SETTINGS_KEY, DEFAULTS);
  settings.harnessModels = Object.assign(
    {},
    DEFAULTS.harnessModels,
    settings.harnessModels || {}
  );
  if (!Personas.MODELS_BY_HARNESS[settings.harness]) settings.harness = 'codex';
  let personas = [];
  let enabled = new Set(loadArray(ENABLED_KEY) || []);
  let view = null;
  let running = false;

  /** Objects only — merges over defaults so a new setting picks up its default. */
  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? Object.assign({}, fallback, JSON.parse(raw)) : fallback;
    } catch (e) { return fallback; }
  }

  /** Arrays need their own reader: Object.assign would turn one into {0:…,1:…}. */
  function loadArray(key) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return Array.isArray(v) ? v : null;
    } catch (e) { return null; }
  }
  function save() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    localStorage.setItem(ENABLED_KEY, JSON.stringify(Array.from(enabled)));
  }

  function defaultModel(harness) {
    const id = harness || settings.harness;
    return settings.harnessModels[id] || Personas.DEFAULT_MODELS[id];
  }

  function fillModelChoices(host, harness) {
    host.textContent = '';
    Personas.modelsFor(harness).forEach((m) => {
      const option = document.createElement('option');
      option.value = m.id;
      option.label = m.label;
      host.appendChild(option);
    });
  }

  function fillPersonaModelSelect(select, persona, selectedHarness) {
    const harness = selectedHarness || Personas.effectiveHarness(persona, settings.harness);
    const fallback = defaultModel(harness);
    select.textContent = '';
    select.appendChild(new Option(`Default — ${fallback}`, 'default'));
    Personas.modelsFor(harness).forEach((m) => select.appendChild(new Option(m.label, m.id)));
    const override = persona && Personas.modelOverride(persona, harness);
    if (override && !Array.from(select.options).some((o) => o.value === override)) {
      select.appendChild(new Option(override, override));
    }
    select.value = override || 'default';
  }

  // --- themes -------------------------------------------------------------
  //
  // Themes are discovered from css/themes/index.json and injected as
  // stylesheets, so dropping in a new file and adding one manifest entry is the
  // entire process for adding a theme.

  async function initThemes() {
    let manifest = [];
    try {
      manifest = await fetch('css/themes/index.json').then((r) => r.json());
    } catch (e) {
      console.warn('theme manifest missing', e);
    }
    manifest.forEach((t) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `css/themes/${t.file}`;
      document.head.appendChild(link);
    });
    const sel = $('theme');
    manifest.forEach((t) => sel.appendChild(new Option(t.label, t.id)));
    sel.value = settings.theme;
    applyTheme();
    sel.onchange = () => { settings.theme = sel.value; applyTheme(); save(); };
  }

  function applyTheme() {
    // "system" means: set no attribute, and let prefers-color-scheme decide.
    if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', settings.theme);
  }

  // --- roster -------------------------------------------------------------

  function renderRoster() {
    const list = $('roster-list');
    list.textContent = '';

    personas.forEach((p) => {
      const row = el('div', 'p-row' + (enabled.has(p.id) ? ' on' : ''));
      row.style.setProperty('--persona-accent', p.accent);
      row.style.setProperty('--persona-ink', UI.inkOn(p.accent));

      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = enabled.has(p.id);
      cb.disabled = running;
      cb.onchange = () => {
        if (cb.checked) enabled.add(p.id); else enabled.delete(p.id);
        row.classList.toggle('on', cb.checked);
        save();
        updateCount();
      };

      // Wrapping in a label makes the portrait and name part of the hit target
      // rather than leaving a 22px box as the only way to pick someone.
      const pick = el('label', 'pick');
      pick.appendChild(cb);
      pick.appendChild(portrait(p, 'sm'));

      const who = el('div', 'who');
      who.appendChild(el('div', 'nm', p.name));
      if (p.title) who.appendChild(el('div', 'ti', p.title));
      pick.appendChild(who);
      row.appendChild(pick);

      // Every persona's model is switchable, bundled ones included — the pack
      // ships a default, this overrides it without editing the pack.
      const mrow = el('div', 'model-row');
      const sel = el('select');
      const harness = Personas.effectiveHarness(p, settings.harness);
      sel.title = `Model this member uses through ${harness}`;
      fillPersonaModelSelect(sel, p, harness);
      sel.disabled = running;
      sel.onchange = () => Personas.setModel(p.id, sel.value, harness);
      mrow.appendChild(sel);

      const edit = el('button', 'edit', 'Edit');
      edit.onclick = () => openPersona(p);
      mrow.appendChild(edit);
      row.appendChild(mrow);

      list.appendChild(row);
    });
    updateCount();
  }

  function updateCount() {
    const n = personas.filter((p) => enabled.has(p.id)).length;
    const el2 = $('roster-count');
    if (el2) el2.textContent = `${n}/${personas.length}`;
  }

  async function duplicateAndEdit(p) {
    const copy = Personas.duplicate(p);
    personas = await Personas.loadAll();
    enabled.add(copy.id);
    save();
    renderRoster();
    openPersona(copy);
  }

  // --- portraits ----------------------------------------------------------
  //
  // An imported image is scaled to 256x256 and embedded in the persona as a
  // data URI rather than referenced by path. A path would break the moment the
  // user moved the file, would not survive exporting a persona to someone
  // else, and could not be loaded from outside the app directory anyway.

  // Portraits are shown as tall standing figures in the tiles view, so imports
  // are cropped to 3:4 rather than square. The roster's small round avatar
  // centre-crops the same image, which reads fine.
  const PORTRAIT_W = 384;
  const PORTRAIT_H = 512;
  let pendingPortrait = null;

  async function fileToPortrait(file) {
    if (!file.type.startsWith('image/')) throw new Error('That file is not an image.');
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('Could not decode that image.'));
        i.src = url;
      });
      const c = document.createElement('canvas');
      c.width = PORTRAIT_W;
      c.height = PORTRAIT_H;
      const ctx = c.getContext('2d');
      // Cover-crop to 3:4, biased toward the top of the source image so a head
      // is not cropped out of a full-length picture.
      const scale = Math.max(PORTRAIT_W / img.width, PORTRAIT_H / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (PORTRAIT_W - w) / 2, Math.min(0, (PORTRAIT_H - h) * 0.25), w, h);
      return c.toDataURL('image/png');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function refreshPortraitPreview() {
    const box = $('pe-portrait-preview');
    box.textContent = '';
    box.appendChild(
      portrait(
        {
          name: $('pe-name').value || '?',
          accent: $('pe-accent').value || '#8b8b96',
          portrait: pendingPortrait,
        },
        'tall'
      )
    );
  }

  // --- persona editor -----------------------------------------------------

  let editing = null;

  /**
   * Sliders are generated from Personas.TUNING rather than written into the
   * HTML, so adding a dial later is a one-line schema change.
   */
  function buildTuningSliders() {
    const host = $('pe-sliders');
    host.textContent = '';
    Object.keys(Personas.TUNING).forEach((key) => {
      const spec = Personas.TUNING[key];
      const field = el('div', 'field slider-field');

      const head = el('div', 'slider-head');
      head.appendChild(el('label', null, spec.label));
      const out = el('output', 'slider-val');
      out.id = `pe-out-${key}`;
      head.appendChild(out);
      field.appendChild(head);

      const input = el('input');
      input.type = 'range';
      input.id = `pe-tune-${key}`;
      input.min = spec.min;
      input.max = spec.max;
      input.step = spec.step;
      input.oninput = () => { out.textContent = formatTune(key, input.value); };
      field.appendChild(input);
      field.appendChild(el('span', 'note', spec.hint));
      host.appendChild(field);
    });

    const eff = $('pe-effort');
    eff.textContent = '';
    Personas.EFFORTS.forEach((e) => eff.appendChild(new Option(e.label, e.id)));
  }

  function formatTune(key, value) {
    // Word budget is a count; the rest are 0-1 dials shown as percentages.
    return Personas.TUNING[key].max > 1 ? `${Math.round(value)} words` : `${Math.round(value * 100)}%`;
  }

  function loadTuning(t) {
    Object.keys(Personas.TUNING).forEach((key) => {
      const spec = Personas.TUNING[key];
      const v = t && t[key] != null ? t[key] : spec.def;
      $(`pe-tune-${key}`).value = v;
      $(`pe-out-${key}`).textContent = formatTune(key, v);
    });
    $('pe-effort').value = (t && t.effort) || 'medium';
    $('pe-examples').value = (t && t.examples) || '';
    $('pe-note').value = (t && t.note) || '';
  }

  function readTuning() {
    const out = {};
    Object.keys(Personas.TUNING).forEach((key) => {
      out[key] = Number($(`pe-tune-${key}`).value);
    });
    out.effort = $('pe-effort').value;
    out.examples = $('pe-examples').value.trim();
    out.note = $('pe-note').value.trim();
    return out;
  }

  function openPersona(p) {
    editing = p || null;
    $('pe-title').textContent = p ? `Edit ${p.name}` : 'New council member';
    $('pe-name').value = p ? p.name : '';
    $('pe-id').value = p ? p.id : '';
    $('pe-id').disabled = !!p;
    $('pe-title-in').value = p ? p.title : '';
    $('pe-accent').value = p ? p.accent : '#8b8b96';
    pendingPortrait = p && p.portrait ? p.portrait : null;
    $('pe-portrait').value = typeof pendingPortrait === 'string' ? pendingPortrait : '';
    $('pe-prompt').value = p ? p.voice.system_prompt : '';
    $('pe-interrupts').value = p && !p.reaction.interrupt_others ? 'no' : 'yes';

    const style = $('pe-style');
    style.textContent = '';
    Personas.INTERRUPT_STYLES.forEach((s) => style.appendChild(new Option(s.replace('_', ' '), s)));
    style.value = p ? p.reaction.on_interrupted : 'unfazed';

    const harness = $('pe-harness');
    harness.textContent = '';
    Object.keys(Personas.MODELS_BY_HARNESS).forEach((id) => {
      const label = id === 'claude-code'
        ? 'Claude Code'
        : id.charAt(0).toUpperCase() + id.slice(1);
      harness.appendChild(new Option(label, id));
    });
    harness.value = p ? Personas.effectiveHarness(p, settings.harness) : settings.harness;
    fillPersonaModelSelect($('pe-model'), p, harness.value);

    // Bundled packs are editable: saving writes a local persona under the same
    // id, which shadows the shipped one. That is friendlier than refusing the
    // edit and demanding the user duplicate first, and it stays reversible.
    const shadowsBundled = !!p && !p.builtin && Personas.isBundledId(p.id);
    loadTuning(p ? p.tuning : null);
    $('pe-advanced').open = false;
    $('pe-delete').hidden = !p || p.builtin;
    $('pe-delete').textContent = shadowsBundled ? 'Reset to default' : 'Delete';
    $('pe-duplicate').hidden = !p;
    const note = $('pe-bundled-note');
    if (p && p.builtin) {
      note.textContent =
        'This member ships with the app. Saving keeps the original intact and stores your version locally — you can reset it later.';
      note.hidden = false;
    } else if (shadowsBundled) {
      note.textContent = 'Your edited version of a bundled member. "Reset to default" restores the shipped one.';
      note.hidden = false;
    } else {
      note.hidden = true;
    }
    $('pe-err').textContent = '';
    refreshPortraitPreview();
    $('modal-persona').hidden = false;
  }

  async function savePersona() {
    const name = $('pe-name').value.trim();
    const id = ($('pe-id').value.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-|-$/g, '');
    const prompt = $('pe-prompt').value.trim();
    const harness = $('pe-harness').value;

    if (!name) return ($('pe-err').textContent = 'A name is required.');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return ($('pe-err').textContent = 'Id must be letters, numbers, dashes or underscores.');
    if (!prompt) return ($('pe-err').textContent = 'Describe the person in the voice field — that is what makes them them.');

    try {
      Personas.upsertUser({
        id, name,
        title: $('pe-title-in').value.trim(),
        portrait: pendingPortrait || null,
        accent: $('pe-accent').value.trim() || '#8b8b96',
        model: defaultModel(harness),
        voice: { system_prompt: prompt, brevity: 'Under 130 words.' },
        reaction: {
          on_interrupted: $('pe-style').value,
          interrupt_others: $('pe-interrupts').value === 'yes',
        },
        tuning: readTuning(),
        // Preserve the matching vocabulary when editing an existing member;
        // dropping it would quietly break Suggest for that persona.
        domains: editing && editing.domains ? editing.domains : [],
      });
      Personas.setHarness(id, harness);
      Personas.setModel(id, $('pe-model').value, harness);
      personas = await Personas.loadAll();
      enabled.add(id);
      save();
      renderRoster();
      $('modal-persona').hidden = true;
      if (running) {
        // Members already have their persona baked into a running process, so
        // an edit cannot apply until the next session. Say so rather than
        // letting the user think it took effect.
        const note = el('div', 'notice');
        note.appendChild(el('strong', null, 'Saved. '));
        note.appendChild(document.createTextNode(
          'ConclAIve members are already running with their previous instructions — this takes effect next time you convene.'
        ));
        $('stage').appendChild(note);
      }
    } catch (e) {
      $('pe-err').textContent = String(e.message || e);
    }
  }

  async function deletePersona() {
    if (!editing) return;
    Personas.removeUser(editing.id);
    enabled.delete(editing.id);
    personas = await Personas.loadAll();
    save();
    renderRoster();
    $('modal-persona').hidden = true;
  }

  // --- import / export ----------------------------------------------------
  //
  // Text-based rather than download-based on purpose: a sandboxed webview
  // cannot reliably hand the user a file, but copy/paste and a file picker
  // work identically in the browser and inside Tauri.

  let shareMode = 'export';

  function openExport() {
    shareMode = 'export';
    const mine = personas.filter((p) => !p.builtin);
    $('share-title').textContent = 'Export personas';
    $('share-label').textContent = `${mine.length} custom persona${mine.length === 1 ? '' : 's'}`;
    $('share-note').textContent = mine.length
      ? 'Copy this and send it to someone; they can paste it into Import. Portraits travel with it.'
      : 'You have no custom personas yet. Copy a bundled member first, then export.';
    $('share-text').value = JSON.stringify(mine, null, 2);
    $('share-text').readOnly = true;
    $('share-apply').hidden = true;
    $('share-copy').hidden = false;
    $('share-file-btn').hidden = true;
    $('share-err').textContent = '';
    $('modal-share').hidden = false;
    $('share-text').select();
  }

  function openImport() {
    shareMode = 'import';
    $('share-title').textContent = 'Import personas';
    $('share-label').textContent = 'Paste persona JSON';
    $('share-note').textContent = 'Accepts a single persona object or an array of them. Existing personas with the same id are replaced.';
    $('share-text').value = '';
    $('share-text').readOnly = false;
    $('share-apply').hidden = false;
    $('share-copy').hidden = true;
    $('share-file-btn').hidden = false;
    $('share-err').textContent = '';
    $('modal-share').hidden = false;
    $('share-text').focus();
  }

  async function applyImport() {
    let parsed;
    try {
      parsed = JSON.parse($('share-text').value);
    } catch (e) {
      return ($('share-err').textContent = 'That is not valid JSON.');
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    let added = 0;
    const rejected = [];
    list.forEach((raw) => {
      try {
        const p = Personas.upsertUser(raw);
        enabled.add(p.id);
        added++;
      } catch (e) {
        rejected.push((raw && raw.name) || (raw && raw.id) || 'unnamed entry');
      }
    });
    if (!added) {
      return ($('share-err').textContent =
        'Nothing imported — each persona needs at least an id and a name.');
    }
    personas = await Personas.loadAll();
    save();
    renderRoster();
    $('modal-share').hidden = true;
    if (rejected.length) {
      console.warn('skipped personas:', rejected);
    }
  }

  // --- views --------------------------------------------------------------

  function activeView() {
    return settings.view === 'transcript' ? ViewTranscript : ViewLive;
  }

  function mountView(session) {
    view = activeView();
    view.mount($('stage'), session, {
      onInterrupt: chairInterrupt,
      onCustomize: (personaId) => {
        const p = personas.find((x) => x.id === personaId);
        if (p) openPersona(p);
      },
    });
  }

  function chairInterrupt(personaId) {
    if (!running) return;
    Council.chairInterrupt(personaId);
  }

  function setView(v) {
    settings.view = v;
    save();
    syncSegs();
    const s = Council.getSession();
    if (s) {
      mountView(s);
      // Replay everything into the freshly mounted view.
      s.entries.forEach((e) => {
        view.onEntry(e);
        view.onDelta(e);
        if (e.done) view.onEntryEnd(e);
      });
      if (s.verdict) renderVerdict(s.verdict);
    }
  }

  function syncSegs() {
    document.querySelectorAll('#view-seg button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.view === settings.view))
    );
    document.querySelectorAll('#mode-seg button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.mode === settings.mode))
    );
  }

  function renderVerdict(text) {
    if (view === ViewTranscript) return ViewTranscript.onVerdict(text);
    let box = document.getElementById('verdict-box');
    if (!box) {
      box = el('div', 'verdict');
      box.id = 'verdict-box';
      box.appendChild(el('h3', null, 'ConclAIve verdict'));
      box.appendChild(el('div', 'body'));
      $('stage').appendChild(box);
    }
    box.querySelector('.body').textContent = text;
  }

  // --- session ------------------------------------------------------------

  async function convene() {
    const prompt = $('prompt').value.trim();
    if (!prompt) return;
    const members = personas.filter((p) => enabled.has(p.id));
    if (!members.length) {
      $('stage').textContent = '';
      const e = el('div', 'empty');
      e.appendChild(el('h3', null, 'No members selected'));
      e.appendChild(el('p', null, 'Tick at least one council member on the left.'));
      $('stage').appendChild(e);
      return;
    }

    running = true;
    $('btn-convene').disabled = true;
    $('btn-stop').disabled = false;
    renderRoster();

    const session = {
      chairPrompt: prompt,
      mode: settings.mode,
      members,
      entries: [],
      verdict: null,
    };
    mountView(session);

    try {
      await Council.convene({
        prompt,
        members,
        mode: settings.mode,
        rounds: Number(settings.rounds) || 3,
        bargeIn: !!settings.bargeIn,
        codebaseDir: settings.codebaseDir || null,
        verdict: settings.verdict !== false,
        harness: settings.harness,
        defaultModel: defaultModel(),
        harnessModels: settings.harnessModels,
      });
    } catch (e) {
      console.error(e);
      const note = el('div', 'notice');
      note.appendChild(el('strong', null, 'Could not start the council. '));
      note.appendChild(document.createTextNode(
        `${String(e && (e.message || e))} Open Settings to choose an installed, signed-in harness.`
      ));
      $('stage').appendChild(note);
    } finally {
      running = false;
      $('btn-convene').disabled = false;
      $('btn-stop').disabled = true;
      renderRoster();
    }
  }

  async function stop() {
    await Council.adjourn();
    running = false;
    $('btn-convene').disabled = false;
    $('btn-stop').disabled = true;
    renderRoster();
  }

  // --- wiring -------------------------------------------------------------

  function wireCouncil() {
    Council.on('start', ({ session }) => mountView(session));
    Council.on('entry', ({ entry }) => view && view.onEntry(entry));
    Council.on('delta', ({ entry }) => view && view.onDelta(entry));
    Council.on('tool', ({ entry }) => view && view.onTool(entry));
    Council.on('entryEnd', ({ entry }) => view && view.onEntryEnd(entry));
    Council.on('state', ({ personaId, state }) => view && view.onState(personaId, state));
    Council.on('cost', ({ total, inputTokens, cachedInputTokens, outputTokens }) => {
      const tokens = (inputTokens || 0) + (outputTokens || 0);
      $('meter').innerHTML = '';
      $('meter').appendChild(document.createTextNode(`session ${tokens.toLocaleString()} tokens · `));
      $('meter').appendChild(el('b', null, 'reported $' + total.toFixed(4)));
      $('meter').title =
        `${(inputTokens || 0).toLocaleString()} input tokens` +
        ` (${(cachedInputTokens || 0).toLocaleString()} cached), ` +
        `${(outputTokens || 0).toLocaleString()} output tokens. ` +
        'Dollar cost appears only when the selected CLI reports one.';
    });
    Council.on('stalled', ({ reason }) => {
      const note = el('div', 'notice');
      note.appendChild(el('strong', null, 'ConclAIve stopped early. '));
      note.appendChild(document.createTextNode(reason));
      $('stage').appendChild(note);
    });
    Council.on('error', ({ message }) => {
      const note = el('div', 'notice');
      note.appendChild(el('strong', null, 'Harness error. '));
      note.appendChild(document.createTextNode(message));
      $('stage').appendChild(note);
    });
    Council.on('verdictDelta', ({ text }) => renderVerdict(text));
    Council.on('verdict', ({ text }) => renderVerdict(text));
  }

  function wireUI() {
    document.querySelectorAll('#mode-seg button').forEach((b) => {
      b.onclick = () => { settings.mode = b.dataset.mode; save(); syncSegs(); };
    });
    document.querySelectorAll('#view-seg button').forEach((b) => {
      b.onclick = () => setView(b.dataset.view);
    });

    $('btn-convene').onclick = convene;
    $('btn-stop').onclick = stop;
    $('prompt').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); convene(); }
    });

    const roster = $('roster');
    const narrow = () => window.matchMedia('(max-width: 880px)').matches;
    if (narrow()) roster.hidden = true;
    $('btn-roster').onclick = () => { roster.hidden = !roster.hidden; };
    // Leaving the sidebar hidden when the window grows back would strand it.
    window.addEventListener('resize', () => { if (!narrow()) roster.hidden = false; });

    $('btn-suggest').onclick = () => {
      const text = $('prompt').value.trim();
      if (!text) return;
      const picks = Personas.suggest(text, personas, 4);
      enabled.clear();
      picks.forEach((r) => enabled.add(r.persona.id));
      save();
      renderRoster();
      const note = el('div', 'notice');
      note.appendChild(el('strong', null, 'ConclAIve selected. '));
      note.appendChild(document.createTextNode(
        picks.map((r) => r.persona.name + (r.hits.length ? ` (${r.hits.slice(0, 3).join(', ')})` : '')).join(' · ')
      ));
      $('stage').textContent = '';
      $('stage').appendChild(note);
    };

    $('btn-all').onclick = () => {
      if (running) return;
      personas.forEach((p) => enabled.add(p.id));
      save();
      renderRoster();
    };
    $('btn-none').onclick = () => {
      if (running) return;
      enabled.clear();
      save();
      renderRoster();
    };
    $('btn-new-persona').onclick = () => openPersona(null);

    $('btn-export').onclick = openExport;
    $('btn-import').onclick = openImport;
    $('share-cancel').onclick = () => ($('modal-share').hidden = true);
    $('share-apply').onclick = applyImport;
    $('share-copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText($('share-text').value);
        $('share-copy').textContent = 'Copied';
        setTimeout(() => ($('share-copy').textContent = 'Copy'), 1500);
      } catch (e) {
        $('share-text').select();
        $('share-err').textContent = 'Clipboard unavailable — the text is selected, copy it manually.';
      }
    };
    $('share-file-btn').onclick = () => $('share-file').click();
    $('share-file').onchange = async () => {
      const f = $('share-file').files[0];
      if (!f) return;
      $('share-text').value = await f.text();
      $('share-file').value = '';
    };

    $('pe-portrait-browse').onclick = () => $('pe-portrait-file').click();
    $('pe-portrait-clear').onclick = () => { pendingPortrait = null; refreshPortraitPreview(); };
    $('pe-portrait-file').onchange = async () => {
      const f = $('pe-portrait-file').files[0];
      if (!f) return;
      try {
        pendingPortrait = await fileToPortrait(f);
        $('pe-err').textContent = '';
        refreshPortraitPreview();
      } catch (e) {
        $('pe-err').textContent = String(e.message || e);
      }
      $('pe-portrait-file').value = '';
    };
    $('pe-accent').addEventListener('input', refreshPortraitPreview);
    $('pe-name').addEventListener('input', refreshPortraitPreview);
    $('pe-harness').onchange = () => {
      fillPersonaModelSelect($('pe-model'), editing, $('pe-harness').value);
    };

    $('pe-cancel').onclick = () => ($('modal-persona').hidden = true);
    $('pe-save').onclick = savePersona;
    $('pe-delete').onclick = deletePersona;
    $('pe-duplicate').onclick = () => { if (editing) duplicateAndEdit(editing); };

    let draftModels = null;
    $('btn-settings').onclick = () => {
      draftModels = Object.assign({}, settings.harnessModels);
      $('set-harness').value = settings.harness;
      $('set-harness').dataset.previous = settings.harness;
      $('set-default-model').value = defaultModel();
      fillModelChoices($('set-model-options'), settings.harness);
      $('set-rounds').value = String(settings.rounds);
      $('set-bargein').value = settings.bargeIn ? 'on' : 'off';
      $('set-codebase').value = settings.codebaseDir || '';
      $('set-verdict').value = settings.verdict === false ? 'off' : 'on';
      $('modal-settings').hidden = false;
    };
    $('set-harness').onchange = () => {
      const previous = $('set-harness').dataset.previous;
      if (previous) draftModels[previous] = $('set-default-model').value.trim();
      const harness = $('set-harness').value;
      $('set-harness').dataset.previous = harness;
      fillModelChoices($('set-model-options'), harness);
      $('set-default-model').value =
        (draftModels && draftModels[harness]) || Personas.DEFAULT_MODELS[harness];
    };
    $('set-close').onclick = () => {
      const harness = $('set-harness').value;
      const model = $('set-default-model').value.trim();
      settings.harness = harness;
      settings.harnessModels = Object.assign({}, draftModels || settings.harnessModels);
      settings.harnessModels[harness] = model || Personas.DEFAULT_MODELS[harness];
      settings.rounds = Number($('set-rounds').value);
      settings.bargeIn = $('set-bargein').value === 'on';
      settings.codebaseDir = $('set-codebase').value.trim();
      settings.verdict = $('set-verdict').value === 'on';
      save();
      renderRoster();
      $('modal-settings').hidden = true;
    };

    // Click the backdrop to dismiss.
    ['modal-settings', 'modal-persona', 'modal-share'].forEach((id) => {
      $(id).addEventListener('click', (e) => { if (e.target.id === id) $(id).hidden = true; });
    });

    window.addEventListener('beforeunload', () => Bridge.killAll());
  }

  async function init() {
    $('mock-badge').hidden = !Bridge.isMock;
    await initThemes();
    personas = await Personas.loadAll();
    if (!localStorage.getItem(ENABLED_KEY)) {
      // First run: convene everyone, so the app has something to show.
      personas.forEach((p) => enabled.add(p.id));
      save();
    }
    syncSegs();
    buildTuningSliders();
    renderRoster();
    wireCouncil();
    wireUI();
  }

  init().catch((e) => console.error('init failed', e));
})();
