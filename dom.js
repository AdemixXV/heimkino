// Kleine Helfer zum Bauen von Seitenteilen.
// Es wird nie innerHTML mit Dateinamen oder anderen fremden Texten benutzt: Titel sind immer reiner Text.

const PROPERTY_KEYS = new Set(['value', 'disabled', 'checked', 'hidden', 'controls', 'loop', 'muted', 'playsInline', 'src', 'title']);

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') for (const [name, v] of Object.entries(value)) el.style.setProperty(name, String(v));
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (PROPERTY_KEYS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Für die Bildschirmleser: kurze Meldungen, die nicht im Bild stehen müssen.
export function announce(text) {
  const live = document.getElementById('live');
  if (!live) return;
  live.textContent = '';
  window.setTimeout(() => {
    live.textContent = text;
  }, 50);
}
