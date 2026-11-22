// Gemeinsame Sehposition für die Handy-Fassungen eines Films/einer Folge.
import * as store from './store.js?v=4dc25edf96';

export const { isFinished, isResumable } = store;
const QUALITY = 'heimkino-handy:v1:quality';
let groups = new Map();

export function configureProgress(items) {
  groups = new Map();
  for (const item of items) {
    const ids = item.hd ? [item.id, item.hd.id] : [item.id];
    for (const id of ids) groups.set(id, ids);
  }
}

function latest(records, ids) {
  return ids.map((id) => records[id]).filter(Boolean).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0] ?? null;
}

function qualities() {
  try {
    const data = JSON.parse(window.localStorage.getItem(QUALITY) ?? '{}');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

export function getProgress(id) {
  return latest(store.allProgress(), groups.get(id) ?? [id]);
}

export function allProgress() {
  const records = store.allProgress();
  const result = { ...records };
  for (const [id, ids] of groups) {
    const progress = latest(records, ids);
    if (progress) result[id] = progress;
  }
  return result;
}

export function saveProgress(id, position, duration) {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
  const ids = groups.get(id) ?? [id];
  store.saveProgress(ids[0], position, duration);
  for (const alias of ids.slice(1)) store.clearProgress(alias);
  rememberQuality(id);
}

export function rememberQuality(id) {
  const ids = groups.get(id) ?? [id];
  const quality = qualities();
  quality[ids[0]] = id === ids[1] ? 'hd' : '720p';
  try { window.localStorage.setItem(QUALITY, JSON.stringify(quality)); } catch { /* auch ohne Qualitätspräferenz abspielbar */ }
}

export function clearProgress(id) {
  for (const alias of groups.get(id) ?? [id]) store.clearProgress(alias);
}

export function preferredVersion(item) {
  if (!item.hd) return item;
  const quality = qualities()[item.id];
  const records = store.allProgress();
  const hd = quality ? quality === 'hd' : (records[item.hd.id]?.at ?? 0) > (records[item.id]?.at ?? 0);
  return hd ? { ...item, ...item.hd, hd: null, isHd: true, base: item } : item;
}

export function watchedItems(items) {
  const progress = allProgress();
  return items.map(preferredVersion).filter((item) => progress[item.id])
    .sort((a, b) => progress[b.id].at - progress[a.id].at);
}
