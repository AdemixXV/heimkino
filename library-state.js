// Persönliche Listen bleiben wie der Sehfortschritt auf diesem Gerät.
const KEY = 'heimkino-handy:v1:lists';
const empty = () => ({ saved: [], hidden: [], seen: {} });
let memory = empty();
let memoryOnly = false;
const itemKey = (item) => item.base?.id ?? item.id;

function read() {
  if (memoryOnly) return memory;
  try {
    const data = JSON.parse(window.localStorage.getItem(KEY) ?? 'null');
    if (!data || typeof data !== 'object') return empty();
    return {
      saved: Array.isArray(data.saved) ? data.saved.filter((key) => typeof key === 'string') : [],
      hidden: Array.isArray(data.hidden) ? data.hidden.filter((key) => typeof key === 'string') : [],
      seen: data.seen && typeof data.seen === 'object' ? Object.fromEntries(Object.entries(data.seen).filter(([, value]) => typeof value === 'boolean')) : {},
    };
  } catch { return memory; }
}

function write(data) {
  memory = data;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(data));
    memoryOnly = false;
  } catch { memoryOnly = true; }
}

export const savedKeys = () => read().saved;
export const isSaved = (key) => savedKeys().includes(key);
export function toggleSaved(key) {
  const data = read();
  const saved = !data.saved.includes(key);
  data.saved = saved ? [key, ...data.saved] : data.saved.filter((value) => value !== key);
  write(data);
  return saved;
}

export const isHidden = (item) => read().hidden.includes(itemKey(item));
export function hideContinue(item) {
  const data = read();
  if (!data.hidden.includes(itemKey(item))) data.hidden.push(itemKey(item));
  write(data);
}
export function restoreContinue(item) {
  const data = read();
  data.hidden = data.hidden.filter((key) => key !== itemKey(item));
  write(data);
}

export function seenOverride(item) {
  const value = read().seen[itemKey(item)];
  return typeof value === 'boolean' ? value : null;
}
export function setSeen(item, value) {
  const data = read();
  if (value === null) delete data.seen[itemKey(item)];
  else data.seen[itemKey(item)] = Boolean(value);
  write(data);
}
