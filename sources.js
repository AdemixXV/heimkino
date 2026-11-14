// Woher die Videos kommen: aus OneDrive (Microsoft Graph) oder, zum Ausprobieren, aus der Demo des Testservers.
// Beide liefern dasselbe: eine Liste mit Einträgen für buildLibrary() und eine Abspieladresse pro Video.
import { accessToken, AuthError } from './auth.js?v=0b72f32700';
import { CONFIG } from './config.js?v=0b72f32700';
import { buildLibrary } from './titles.js?v=0b72f32700';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const VIDEO_FILE = /\.(mp4|m4v|mov|webm)$/i;
const CATALOG_NAME = 'heimkino-katalog.json';

export class SignInNeeded extends Error {}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function graph(path, { allowMissing = false } = {}) {
  let refreshed = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = await accessToken({ forceRefresh: refreshed });
    if (!token) throw new SignInNeeded('Bitte neu anmelden.');
    const res = await fetch(path.startsWith('https://') ? path : `${GRAPH}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 && !refreshed) {
      refreshed = true; // Schlüssel abgelaufen: einmal erneuern
      continue;
    }
    if (res.status === 401) throw new SignInNeeded('Bitte neu anmelden.');
    if (res.status === 404 && allowMissing) return null;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await pause(1500 * (attempt + 1)); // OneDrive ist kurz überlastet: kurz warten, dann noch einmal
      continue;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error?.message || `OneDrive antwortet mit Fehler ${res.status}.`);
    }
    return res.json();
  }
  throw new Error('OneDrive antwortet gerade nicht.');
}

// Ein Ordner kann auch eine Verknüpfung auf einen geteilten Ordner sein ("Zu meinen Dateien hinzufügen").
// Dann liegt der Inhalt in einem anderen Laufwerk, erreichbar über remoteItem.
function targetOf(item, fallbackDriveId = null) {
  if (item.remoteItem) {
    return { driveId: item.remoteItem.parentReference?.driveId ?? fallbackDriveId, id: item.remoteItem.id, folder: Boolean(item.remoteItem.folder) };
  }
  return { driveId: item.parentReference?.driveId ?? fallbackDriveId, id: item.id, folder: Boolean(item.folder) };
}

// "Filme/Handy" Stück für Stück auflösen, dabei Verknüpfungen folgen. null, wenn es den Ordner nicht gibt.
async function resolveFolder(path) {
  let current = null;
  for (const segment of path.split('/').filter(Boolean)) {
    const url = current
      ? `/drives/${encodeURIComponent(current.driveId)}/items/${encodeURIComponent(current.id)}:/${encodeURIComponent(segment)}`
      : `/me/drive/root:/${encodeURIComponent(segment)}`;
    const item = await graph(url, { allowMissing: true });
    if (!item) return null;
    current = targetOf(item, current?.driveId);
    if (!current.folder || !current.driveId) return null;
  }
  return current;
}

const childrenUrl = (ref) => `/drives/${encodeURIComponent(ref.driveId)}/items/${encodeURIComponent(ref.id)}/children?$top=200&$expand=thumbnails`;

// Höchstens n Anfragen gleichzeitig
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || queue.length === 0) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    task().then(resolve, reject).finally(() => {
      active -= 1;
      next();
    });
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    next();
  });
}

export const oneDrive = {
  name: 'onedrive',

  async account() {
    const me = await graph('/me?$select=displayName,userPrincipalName');
    return me?.displayName || me?.userPrincipalName || '';
  },

  async library() {
    const limit = limiter(4);
    const entries = [];
    const missing = [];
    const catalogs = [];

    async function walk(rootIndex, root, ref, parts) {
      let next = childrenUrl(ref);
      while (next) {
        const page = await limit(() => graph(next));
        const folders = [];
        for (const item of page.value ?? []) {
          const target = targetOf(item, ref.driveId);
          if (parts.length === 0 && item.file && item.name === CATALOG_NAME && item['@microsoft.graph.downloadUrl']) {
            catalogs.push({ rootIndex, url: item['@microsoft.graph.downloadUrl'] });
          }
          if (target.folder) folders.push({ name: item.name, ref: target });
          else if (item.file && VIDEO_FILE.test(item.name) && item.size > 0) { // 0 Byte: lädt gerade noch hoch
            const thumb = item.thumbnails?.[0];
            entries.push({
              id: item.id,
              driveId: target.driveId,
              rootIndex,
              rootLabel: root.label,
              parts: [...parts, item.name],
              size: item.size,
              duration: item.video?.duration ? item.video.duration / 1000 : null,
              width: item.video?.width ?? null,
              height: item.video?.height ?? null,
              thumb: thumb?.large?.url ?? thumb?.medium?.url ?? null,
              modified: item.lastModifiedDateTime ?? null,
            });
          }
        }
        await Promise.all(folders.map((f) => walk(rootIndex, root, f.ref, [...parts, f.name])));
        next = page['@odata.nextLink'] ?? null;
      }
    }

    await Promise.all(
      CONFIG.folders.map(async (root, rootIndex) => {
        const ref = await limit(() => resolveFolder(root.path));
        if (!ref) missing.push(root.path);
        else await walk(rootIndex, root, ref, []);
      }),
    );

    // Filmdaten (Poster, Beschreibung, Trailer ...), die das Laptop-Skript "film-infos" in den Ordner legt
    const meta = {};
    await Promise.all(
      catalogs.map(async ({ rootIndex, url }) => {
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const data = await res.json();
          for (const [key, value] of Object.entries(data.titles ?? {})) meta[`${rootIndex}|${key}`] = value;
        } catch {
          // ohne Filmdaten geht es auch, dann mit Vorschaubildern
        }
      }),
    );
    return { items: buildLibrary(entries), missing, meta };
  },

  // Kurzlebige, vorab freigegebene Adresse der Datei (gilt etwa eine Stunde). Nicht speichern, bei Bedarf neu holen.
  async playUrl(video) {
    const base = video.driveId ? `/drives/${encodeURIComponent(video.driveId)}/items` : '/me/drive/items';
    // Ohne $select: Mit $select lässt OneDrive die Abspieladresse bei Dateien aus geteilten Ordnern weg.
    const item = await graph(`${base}/${encodeURIComponent(video.id)}`);
    const url = item?.['@microsoft.graph.downloadUrl'];
    if (!url) throw new Error('OneDrive liefert für dieses Video keine Abspieladresse.');
    return url;
  },
};

// Demo: Der Testserver (npm run handy-app) liefert Beispielvideos mit echten Namensmustern.
export const demo = {
  name: 'demo',
  async account() {
    return 'Demo';
  },
  async library() {
    const res = await fetch('/demo/library.json');
    if (!res.ok) throw new Error('Die Demo gibt es nur mit dem Testserver (npm run handy-app).');
    const data = await res.json();
    return { items: buildLibrary(data.entries), missing: [], meta: data.meta ?? {} };
  },
  async playUrl(video) {
    return `/demo/media/${encodeURIComponent(video.id)}`;
  },
};

export { AuthError };
