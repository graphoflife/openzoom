/**
 * Small XML toolkit shared by BCF and .bcsv: an element-tree writer that always
 * produces well-formed XML 1.0, and namespace/prefix agnostic reading helpers
 * (lookup by localName) over any DOMParser document.
 */

// Characters not allowed in XML 1.0 (control chars, lone surrogates, U+FFFE/FFFF)
const INVALID_XML_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const ESC = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  '\r': '&#13;', '\n': '&#10;', '\t': '&#9;',
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';

export const escText = (s) => String(s).replace(INVALID_XML_CHARS, '').replace(/[&<>"'\r]/g, (c) => ESC[c]);
export const escAttr = (s) => String(s).replace(INVALID_XML_CHARS, '').replace(/[&<>"'\r\n\t]/g, (c) => ESC[c]);

/** Element node; children may be nodes, text, nested arrays or null (skipped). */
export const E = (name, attrs, ...kids) => ({
  name,
  attrs: attrs || {},
  kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false),
});

/** Indented XML text of an element tree; attributes with blank values are omitted. */
export function render(node, ind = '', nl = '\n') {
  const a = Object.entries(node.attrs)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
    .join('');
  const { name, kids } = node;
  if (!kids.length) return `${ind}<${name}${a}/>`;
  if (kids.every((k) => typeof k !== 'object')) return `${ind}<${name}${a}>${escText(kids.join(''))}</${name}>`;
  const inner = kids
    .map((k) => (typeof k === 'object' ? render(k, `${ind}  `, nl) : `${ind}  ${escText(k)}`))
    .join(nl);
  return `${ind}<${name}${a}>${nl}${inner}${nl}${ind}</${name}>`;
}

/** UTF-8 bytes of a standalone document with declaration. */
export const xmlDoc = (root) => new TextEncoder().encode(`${XML_DECL}${render(root)}\n`);

// ---------------------------------------------------------------------------
// Reading (namespace/prefix agnostic, lookup by localName)
// ---------------------------------------------------------------------------

/** Root element of parsed XML text, or null when it is not well-formed. */
export function parseXml(text, DP = globalThis.DOMParser) {
  const doc = new DP().parseFromString(text, 'application/xml');
  const root = doc && doc.documentElement;
  if (!root || lname(root) === 'parsererror' || doc.getElementsByTagName('parsererror').length) return null;
  return root;
}

export const lname = (n) => String(n.localName || n.nodeName || '').replace(/^.*:/, '');

/** Child elements. */
export function elems(el) {
  const out = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n);
  return out;
}

/** Direct children by name: exact match first, case-insensitive fallback. */
export function children(el, name) {
  const all = elems(el);
  const exact = all.filter((c) => lname(c) === name);
  if (exact.length) return exact;
  const lower = name.toLowerCase();
  return all.filter((c) => lname(c).toLowerCase() === lower);
}

export const child = (el, name) => children(el, name)[0] || null;
export const textOf = (el) => (el ? String(el.textContent ?? '').trim() : '');
export const text = (el, name) => textOf(child(el, name));

/** All descendant elements with a name (case-insensitive), in document order. */
export function descendants(el, name, out = []) {
  const lower = name.toLowerCase();
  for (const c of elems(el)) {
    if (lname(c).toLowerCase() === lower) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

/** Attribute value by local name (exact, then case-insensitive), trimmed; '' when missing. */
export function attr(el, name) {
  const list = el && el.attributes;
  if (!list) return '';
  const lower = name.toLowerCase();
  let ci = '';
  for (let i = 0; i < list.length; i++) {
    const a = list.item(i);
    const n = lname(a);
    const v = String(a.value ?? a.nodeValue ?? '').trim();
    if (n === name) return v;
    if (!ci && n.toLowerCase() === lower) ci = v;
  }
  return ci;
}
