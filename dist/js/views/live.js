// Live Tiles: a column per member, each a tall portrait with a single speech
// bubble attached to it.
//
// This view deliberately keeps NO history — a member's bubble is replaced each
// time they speak, so the screen always shows the room as it is right now.
// The full record lives in the transcript view.

window.ViewLive = (function () {
  'use strict';
  const { el, portrait } = UI;

  let root = null;
  let tiles = new Map(); // personaId -> { tile, stage, stateEl, bubble, textNode, entryId }
  let onInterrupt = null;
  let onCustomize = null;

  const STATE_LABEL = {
    idle: '',
    thinking: 'thinking',
    streaming: 'speaking',
    cut: 'cut off',
    done: '',
  };

  function mount(container, session, handlers) {
    // Leaving this view mid-reply must not leave a frame loop running.
    tiles.forEach((t) => {
      if (t.raf) cancelAnimationFrame(t.raf);
      clearTimeout(t.flushTimer);
    });
    root = container;
    onInterrupt = handlers && handlers.onInterrupt;
    onCustomize = handlers && handlers.onCustomize;
    root.textContent = '';
    tiles = new Map();

    const grid = el('div', 'tiles');
    session.members.forEach((p) => {
      const tile = el('div', 'tile');
      tile.style.setProperty('--persona-accent', p.accent);

      const figure = el('div', 'figure');
      const portraitEl = portrait(p, 'tall');
      figure.appendChild(portraitEl);

      const cap = el('div', 'cap');
      cap.appendChild(el('div', 'nm', p.name));
      const stateEl = el('span', 'state', '');
      cap.appendChild(stateEl);

      // Clicking a member opens them for editing. Interrupting is a separate,
      // explicit control that only appears while they hold the floor —
      // overloading the same click would make "who is this person" and "shut
      // them up" the same gesture.
      figure.title = `Click to customise ${p.name}`;
      figure.addEventListener('click', () => onCustomize && onCustomize(p.id));

      const cut = el('button', 'cut-btn', 'cut in');
      cut.title = `Cut ${p.name} off mid-sentence`;
      cut.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (onInterrupt) onInterrupt(p.id);
      });
      cap.appendChild(cut);
      figure.appendChild(cap);

      // Holds at most one bubble at a time.
      const stage = el('div', 'speech-slot');

      tile.appendChild(figure);
      tile.appendChild(stage);
      grid.appendChild(tile);
      tiles.set(p.id, {
        tile, stage, stateEl, portraitEl,
        bubble: null, textNode: null, body: null,
        entryId: null, pending: null,
        target: '', shownLen: 0, raf: null, flushTimer: null,
      });
    });
    root.appendChild(grid);

    // Re-entrant: switching back mid-session should show whatever each member
    // last said, not an empty room.
    const latest = new Map();
    session.entries.forEach((e) => latest.set(e.personaId, e));
    latest.forEach((e) => {
      onEntry(e);
      onDelta(e);
      if (e.done) onEntryEnd(e);
    });
  }

  /**
   * A turn has started, but the model will not produce its first token for
   * roughly two seconds. Clearing the bubble now would leave the column blank
   * for that whole time — very visible when someone is cut off, because their
   * words vanish and nothing replaces them. So the previous utterance stays up
   * (dimmed) and the swap happens the moment real content arrives.
   */
  function onEntry(entry) {
    const t = tiles.get(entry.personaId);
    if (!t) return;
    t.pending = entry;
    if (t.bubble) t.bubble.classList.add('stale');
  }

  /** Replaces the member's bubble outright — this view holds no history. */
  function swapIn(t, entry) {
    if (t.raf) { cancelAnimationFrame(t.raf); t.raf = null; }
    t.target = '';
    t.shownLen = 0;
    t.stage.textContent = '';
    const bubble = el('div', 'speech streaming');
    if (entry.isInterjection) bubble.classList.add('interjection');

    const tag = entry.isReaction
      ? 'interrupted'
      : entry.isInterjection
        ? 'cutting in'
        : '';
    if (tag) bubble.appendChild(el('span', 'tag', tag));

    const body = el('div', 'body');
    const textNode = document.createTextNode('');
    body.appendChild(textNode);
    bubble.appendChild(body);

    t.stage.appendChild(bubble);
    t.bubble = bubble;
    t.textNode = textNode;
    t.body = body;
    t.entryId = entry.id;
    t.pending = null;
  }

  /**
   * The CLI does not stream token by token — a ~1000 character reply arrives as
   * roughly ten ~100 character chunks about 600ms apart. Writing each chunk
   * straight into the DOM makes the reply appear in a few big leaps, which
   * reads as "it was already three quarters done". So received text is treated
   * as a target and the visible text catches up to it a few characters per
   * frame, turning coarse chunks into continuous typing.
   */
  function pump(t) {
    if (t.raf) return;
    const step = () => {
      t.raf = null;
      if (!t.textNode) return;
      const target = t.target || '';
      const shown = t.shownLen || 0;
      if (shown >= target.length) return;

      // Pace is proportional to how far behind we are, so the display stays
      // smooth on a steady stream and never falls behind a fast one.
      const backlog = target.length - shown;
      const chars = Math.max(1, Math.ceil(backlog / 20));
      t.shownLen = shown + chars;
      t.textNode.nodeValue = target.slice(0, t.shownLen);
      t.body.scrollTop = t.body.scrollHeight;
      t.raf = requestAnimationFrame(step);
    };
    t.raf = requestAnimationFrame(step);
  }

  /** Abandons the animation and shows everything received so far. */
  function flush(t) {
    if (t.raf) { cancelAnimationFrame(t.raf); t.raf = null; }
    if (t.textNode && t.target != null) {
      t.shownLen = t.target.length;
      t.textNode.nodeValue = t.target;
    }
  }

  function onDelta(entry) {
    const t = tiles.get(entry.personaId);
    if (!t) return;
    if (t.pending && t.pending.id === entry.id) swapIn(t, entry);
    if (t.entryId !== entry.id || !t.textNode) return;
    t.target = entry.text;
    pump(t);
  }

  function onTool(entry) {
    const t = tiles.get(entry.personaId);
    if (!t) return;
    // In codebase mode a tool call is the first thing that happens, well
    // before any text — worth showing rather than sitting on a stale bubble.
    if (t.pending && t.pending.id === entry.id) swapIn(t, entry);
    if (!t.bubble || t.entryId !== entry.id) return;
    const tool = entry.tools[entry.tools.length - 1];
    if (!tool) return;
    let chip = t.bubble.querySelector('.chip');
    if (!chip) {
      chip = el('div', 'chip');
      t.bubble.insertBefore(chip, t.bubble.firstChild);
    }
    chip.textContent = `${tool.name}${tool.detail ? ' · ' + tool.detail : ''}`;
  }

  function onEntryEnd(entry) {
    const t = tiles.get(entry.personaId);
    if (!t) return;

    if (t.pending && t.pending.id === entry.id) {
      // Ended without ever streaming. If it produced text anyway, show it; if
      // it produced nothing (cut off before the first token), keep the older
      // utterance rather than blanking the column.
      if (entry.text && entry.text.trim()) {
        swapIn(t, entry);
      } else {
        t.pending = null;
        if (t.bubble) t.bubble.classList.remove('stale');
        return;
      }
    }

    if (t.entryId !== entry.id || !t.bubble) return;
    t.bubble.classList.remove('streaming');
    t.target = entry.text;
    pump(t);
    // requestAnimationFrame does not run in a hidden window, which would leave
    // the reply permanently truncated. Guarantee the final text either way.
    clearTimeout(t.flushTimer);
    t.flushTimer = setTimeout(() => flush(t), 2500);
    if (entry.cutOff) {
      t.bubble.classList.add('cut');
      t.bubble.appendChild(el('span', 'cutnote', `cut off by ${entry.cutBy || 'someone'}`));
    }
  }

  function onState(personaId, state) {
    const t = tiles.get(personaId);
    if (!t) return;
    t.stateEl.textContent = STATE_LABEL[state] || '';
    t.stateEl.className = 'state' + (state === 'cut' ? ' cut' : '');
    t.tile.classList.toggle('speaking', state === 'streaming' || state === 'thinking');
    UI.setPortraitExpression(
      t.portraitEl,
      state === 'streaming' ? 'talking' : state === 'cut' ? 'angry' : 'stoic'
    );

    // While thinking, the caption carries the signal and the previous bubble
    // stays up dimmed — there is no empty bubble to pulse any more.
  }

  return { mount, onEntry, onDelta, onEntryEnd, onState, onTool, onVerdict() {} };
})();
