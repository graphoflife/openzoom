/** Keyboard: a key runs the command bound to it (rules in registerCommands). */
export function bindKeys(app) {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
    if (document.querySelector('.modal-back')) return;
    if (app.tool?.keyDown?.(e)) { e.preventDefault(); return; }
    const c = commandForKey(app.commands, comboOf(e));
    if (c) {
      e.preventDefault();
      e.stopPropagation();
      app.run(c.id);
      return;
    }
    if (app.controls.keyDown(e)) e.preventDefault();
  });
}

/** Of the commands bound to a combo, an enabled conditional one wins over the unconditional one. */
function commandForKey(commands, combo) {
  let fallback = null;
  for (const c of commands.values()) {
    if (!c.keys.includes(combo)) continue;
    if (!c.enabled) fallback ??= c;
    else if (c.enabled()) return c;
  }
  return fallback;
}

/**
 * Shortcut name of a key event. Letters and = + - * follow the keyboard layout
 * (e.key, so Ctrl+Z is Z on QWERTZ and AZERTY); digits use the physical key;
 * when Option/Alt turned e.key into another character (macOS) e.code is used.
 */
function comboOf(e) {
  let key;
  const c = e.code || '';
  const k = e.key || '';
  if (/^[a-z]$/i.test(k)) key = k.toUpperCase();
  else if (['=', '+', '-', '*'].includes(k)) key = k;
  else if (c === 'Space') key = 'Space';
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^Numpad\d$/.test(c)) key = c.slice(6);
  else if (c === 'NumpadAdd') key = '+';
  else if (c === 'NumpadSubtract') key = '-';
  else if (c === 'NumpadMultiply') key = '*';
  else if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (c === 'Equal') key = '=';
  else if (c === 'Minus') key = '-';
  else key = k.length === 1 ? k.toUpperCase() : k;
  const symbol = ['=', '+', '-', '*'].includes(key);
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && !symbol) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}
