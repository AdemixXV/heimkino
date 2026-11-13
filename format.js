// Zahlen und Zeiten für die Anzeige (deutsch, mit geschütztem Leerzeichen vor Einheiten).

export const NBSP = String.fromCharCode(0xa0);

const pad = (n) => String(n).padStart(2, '0');

// 3725 -> "1:02:05", 75 -> "1:15"
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0${NBSP}MB`;
  const units = ['Byte', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit >= 3 ? 1 : 0;
  return `${value.toLocaleString('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: digits })}${NBSP}${units[unit]}`;
}

// "weniger als eine Minute", "etwa 3 Minuten"
export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds === null) return '';
  if (seconds < 45) return 'weniger als eine Minute';
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'etwa eine Minute' : `etwa ${minutes}${NBSP}Minuten`;
}

export function countVideos(n) {
  return n === 1 ? `1${NBSP}Video` : `${n}${NBSP}Videos`;
}

export function resolutionLabel(width, height) {
  return width && height ? `${width}${NBSP}×${NBSP}${height}` : '';
}

export function initialOf(title) {
  const m = /[\p{L}\p{N}]/u.exec(title ?? '');
  return m ? m[0].toUpperCase() : '?';
}
