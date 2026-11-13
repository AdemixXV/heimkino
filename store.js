// Merkt sich pro Gerät, wie weit man in einem Video war. Das passiert nur im Browser (localStorage), nicht auf dem Server.
const KEY = 'heimkino:v1:progress';
const KEEP = 300;

function read() {
  try {
    const data = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function write(data) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Speicher gesperrt (z. B. privates Fenster): dann geht es eben ohne Merken weiter
  }
}

export function allProgress() {
  return read();
}

export function getProgress(id) {
  return read()[id] ?? null;
}

export function saveProgress(id, position, duration) {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
  const data = read();
  data[id] = { t: Math.floor(position), d: Math.floor(duration), at: Date.now() };
  const newest = Object.entries(data).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP);
  write(Object.fromEntries(newest));
}

export function clearProgress(id) {
  const data = read();
  delete data[id];
  write(data);
}

// Fast am Ende gilt als gesehen.
export function isFinished(progress) {
  return Boolean(progress) && progress.d > 0 && progress.t >= progress.d - 15;
}

// Angefangen, aber nicht zu Ende gesehen.
export function isResumable(progress) {
  return Boolean(progress) && progress.t >= 10 && !isFinished(progress);
}
