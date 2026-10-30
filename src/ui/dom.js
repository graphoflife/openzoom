import { icon } from './icons.js';

/** Tiny hyperscript helper: h('div.cls#id', {attrs, on: {click}}, ...children). */
export function h(spec, attrs, ...children) {
  const [, tag = 'div', rest = ''] = spec.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(tag || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function iconEl(name, size) {
  const s = document.createElement('span');
  s.className = 'icon';
  s.innerHTML = icon(name, size);
  return s;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// --- floating menus --------------------------------------------------------------
let openMenu = null;

export function closeMenus() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
  document.querySelectorAll('.menubar .open').forEach((e) => e.classList.remove('open'));
}

/**
 * items: [{label, shortcut, icon, checked, disabled, run, submenu: items}] or '-' for a separator.
 */
export function showMenu(items, x, y, { minWidth } = {}) {
  closeMenus();
  const menu = buildMenu(items);
  if (minWidth) menu.style.minWidth = `${minWidth}px`;
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(2, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(2, Math.min(y, window.innerHeight - r.height - 4))}px`;
  openMenu = menu;
  return menu;
}

function buildMenu(items) {
  const menu = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { menu.appendChild(h('div.sep')); continue; }
    if (it.header) { menu.appendChild(h('div.menu-header', it.header)); continue; }
    const row = h('div.item', { role: 'menuitem', class: `item${it.disabled ? ' disabled' : ''}` },
      h('span.check', it.checked ? '✓' : ''),
      it.icon ? iconEl(it.icon, 16) : h('span.icon'),
      h('span.label', it.label),
      h('span.shortcut', it.shortcut || ''),
      it.submenu ? h('span.arrow', '▸') : null);
    if (it.color) row.querySelector('.icon').innerHTML = `<span class="swatch" style="background:${it.color}"></span>`;
    if (it.submenu) {
      let sub = null;
      row.addEventListener('mouseenter', () => {
        menu.querySelectorAll(':scope > .menu').forEach((m) => m.remove());
        sub = buildMenu(it.submenu);
        sub.classList.add('submenu');
        menu.appendChild(sub);
        const rr = row.getBoundingClientRect();
        const mr = menu.getBoundingClientRect();
        const sr = sub.getBoundingClientRect();
        let left = rr.right - mr.left - 2;
        if (rr.right + sr.width > window.innerWidth) left = -sr.width + 2;
        sub.style.left = `${left}px`;
        sub.style.top = `${Math.min(rr.top - mr.top - 4, window.innerHeight - mr.top - sr.height - 4)}px`;
      });
    } else {
      row.addEventListener('mouseenter', () => menu.querySelectorAll(':scope > .menu').forEach((m) => m.remove()));
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (it.disabled) return;
        closeMenus();
        it.run?.();
      });
    }
    menu.appendChild(row);
  }
  menu.addEventListener('pointerdown', (e) => e.stopPropagation());
  return menu;
}

document.addEventListener('pointerdown', () => closeMenus());
window.addEventListener('blur', () => closeMenus());

// --- dialogs -----------------------------------------------------------------------
export function dialog({ title, body, buttons = [], width, onClose, className }) {
  const back = h('div.modal-back');
  const box = h('div.modal', { class: `modal ${className || ''}`, style: width ? { width: `${width}px` } : null });
  const close = () => { back.remove(); onClose?.(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  const head = h('div.modal-head', h('span', title), h('button.icon-btn', { title: 'Schließen', on: { click: close }, html: icon('close', 16) }));
  const content = h('div.modal-body', body);
  const foot = h('div.modal-foot');
  for (const b of buttons) {
    foot.appendChild(h('button', { class: b.primary ? 'btn primary' : 'btn', on: { click: () => { if (b.run?.() !== false) close(); } } }, b.label));
  }
  box.append(head, content);
  if (buttons.length) box.append(foot);
  back.appendChild(box);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
  const first = box.querySelector('input,select,textarea');
  if (first) setTimeout(() => first.focus(), 0);
  return { close, box, body: content };
}

export function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    const input = h('input.input', { type: 'text', value });
    let result = null;
    const d = dialog({
      title, width: 380,
      body: h('div.form', h('label', label, input)),
      buttons: [{ label: 'OK', primary: true, run: () => { result = input.value; } }, { label: 'Abbrechen' }],
      onClose: () => resolve(result),
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { result = input.value; d.close(); } });
  });
}

export function confirmDialog(title, text, okLabel = 'OK') {
  return new Promise((resolve) => {
    let ok = false;
    dialog({ title, width: 400, body: h('p', text), buttons: [{ label: okLabel, primary: true, run: () => { ok = true; } }, { label: 'Abbrechen' }], onClose: () => resolve(ok) });
  });
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  let el = document.querySelector('.toast');
  if (!el) { el = h('div.toast'); document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// --- files --------------------------------------------------------------------------
export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple });
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });
}

export function rgbCss(c) {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function hexToRgb(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex(c) {
  return `#${c.map((x) => (x | 0).toString(16).padStart(2, '0')).join('')}`;
}
