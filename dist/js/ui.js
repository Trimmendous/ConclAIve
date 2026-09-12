// Small shared DOM helpers.
//
// Model output is always inserted with textContent, never innerHTML — a
// persona's reply is untrusted text, and in codebase mode it can even quote
// file contents back at us.

window.UI = (function () {
  'use strict';

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * Picks black or white to sit on top of an arbitrary accent colour. Persona
   * accents span pale yellow to deep purple, so a fixed tick colour is
   * unreadable on roughly half of them.
   */
  function inkOn(hex) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return '#ffffff';
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    // Relative luminance, WCAG definition.
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.45 ? '#0b0b0d' : '#ffffff';
  }

  function initials(name) {
    return String(name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('');
  }

  /**
   * Bundled portraits are three-panel expression sheets (stoic, talking,
   * angry). Imported/custom portraits remain ordinary image strings.
   */
  function portrait(persona, size) {
    const box = el('div', `portrait ${size || 'sm'}`);
    box.style.setProperty('--persona-accent', persona.accent);
    box.dataset.expression = 'stoic';
    if (persona.portrait) {
      const img = el('img');
      const sheet = typeof persona.portrait === 'object' && persona.portrait.sheet;
      img.src = sheet || persona.portrait;
      img.alt = persona.name;
      if (sheet) img.className = 'portrait-sheet';
      img.onerror = () => {
        box.textContent = '';
        box.appendChild(el('span', 'initials', initials(persona.name)));
      };
      box.appendChild(img);
    } else {
      box.appendChild(el('span', 'initials', initials(persona.name)));
    }
    return box;
  }

  function setPortraitExpression(box, expression) {
    if (!box) return;
    box.dataset.expression = ['stoic', 'talking', 'angry'].includes(expression)
      ? expression
      : 'stoic';
  }

  return { el, initials, portrait, setPortraitExpression, inkOn };
})();
