// Transcript: the same session as plain text, no portraits, no columns.
// Round dividers and cut-off markers are preserved so the shape of the debate
// survives the loss of the live layout.

window.ViewTranscript = (function () {
  'use strict';
  const { el } = UI;

  let root = null;
  let stream = null;
  let entries = new Map(); // entryId -> { node, textNode }
  let lastRound = 0;

  function mount(container, session) {
    root = container;
    entries = new Map();
    lastRound = 0;
    root.textContent = '';

    stream = el('div', 'transcript');
    const chair = el('div', 't-chair');
    chair.appendChild(el('span', 'spk', 'THE CHAIR: '));
    chair.appendChild(document.createTextNode(session.chairPrompt));
    stream.appendChild(chair);
    root.appendChild(stream);

    // Re-entrant: switching views mid-session replays what already happened.
    session.entries.forEach((e) => {
      onEntry(e);
      onDelta(e);
      if (e.done) onEntryEnd(e);
    });
    if (session.verdict) onVerdict(session.verdict);
  }

  function onEntry(entry) {
    if (entries.has(entry.id)) return;
    if (entry.round !== lastRound) {
      lastRound = entry.round;
      stream.appendChild(el('div', 't-round', `Round ${entry.round}`));
    }
    const node = el('div', 't-entry');
    node.style.setProperty('--persona-accent', entry.accent);
    node.appendChild(el('span', 'spk', `${entry.name.toUpperCase()}: `));
    const txt = el('span', 'txt');
    const textNode = document.createTextNode('');
    txt.appendChild(textNode);
    node.appendChild(txt);
    stream.appendChild(node);
    entries.set(entry.id, { node, textNode });
    root.scrollTop = root.scrollHeight;
  }

  function onDelta(entry) {
    const e = entries.get(entry.id);
    if (!e) return;
    e.textNode.nodeValue = entry.text;
    root.scrollTop = root.scrollHeight;
  }

  function onEntryEnd(entry) {
    const e = entries.get(entry.id);
    if (!e) return;
    e.textNode.nodeValue = entry.text;
    if (entry.cutOff) {
      e.node.classList.add('cut');
      e.node.appendChild(
        el('span', 'cutnote', ` [cut off by ${entry.cutBy || 'someone'}]`)
      );
    }
  }

  function onVerdict(text) {
    const box = el('div', 'verdict');
    box.appendChild(el('h3', null, 'ConclAIve verdict'));
    box.appendChild(el('div', 'body', text));
    root.appendChild(box);
  }

  return { mount, onEntry, onDelta, onEntryEnd, onVerdict, onState() {}, onTool() {} };
})();
