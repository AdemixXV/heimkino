import { accessToken, sessionSignal, sessionVersion } from './auth.js?v=b1e234ccc2';
import { CONFIG } from './config.js?v=b1e234ccc2';

const GRAPH = 'https://graph.microsoft.com/v1.0';
export const BOARD_NAME = 'Heimkino-Wuensche';
export const NOTIFY_KEY = 'heimkino-handy:v1:board-notify';
const encode = encodeURIComponent;

export function validateWish(title, text = '') {
  if (typeof title !== 'string' || typeof text !== 'string') throw new Error('Ungültiger Filmwunsch.');
  title = title.trim(); text = text.trim();
  if (!title || title.length > 160) throw new Error('Bitte einen Filmtitel mit höchstens 160 Zeichen eintragen.');
  if (text.length > 1000) throw new Error('Die Nachricht darf höchstens 1000 Zeichen haben.');
  return { version: 1, title, text };
}

export function createBoardClient({ driveId, itemId = null, token = accessToken, session = sessionVersion, signal = sessionSignal, fetcher = (...args) => fetch(...args) }) {
  const base = `/drives/${encode(driveId)}`;
  async function request(path, options = {}, expected = session()) {
    const check = () => { if (!expected || session() !== expected) throw new Error('Die Anmeldung wurde geändert. Bitte das Brett neu öffnen.'); };
    const url = new URL(path.startsWith('https://') ? path : GRAPH + path);
    if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/')) throw new Error('Ungültige Graph-Adresse.');
    for (let attempt = 0; attempt < 2; attempt++) {
      check();
      const access = await token({ forceRefresh: attempt > 0 });
      check();
      if (!access) throw new Error('Bitte erneut bei Microsoft anmelden.');
      const res = await fetcher(url.href, { ...options, headers: { Authorization: `Bearer ${access}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, redirect: 'error', signal: signal() });
      check();
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 404 && options.missing) return null;
      if (res.status === 403 && options.optionalAccess) return null;
      if (res.status === 403) throw new Error('Dieses Konto hat keinen passenden Zugriff auf den Wünsche-Ordner. Der Besitzer muss diesen separaten Ordner in OneDrive freigeben: zum Lesen oder zum Bearbeiten für Beiträge.');
      if (!res.ok) throw new Error(res.status === 401 ? 'Bitte erneut bei Microsoft anmelden.' : `OneDrive antwortet mit Fehler ${res.status}. Bitte später erneut versuchen.`);
      if (res.status === 204) return null;
      const data = await res.json(); check(); return data;
    }
  }
  async function files(folder, expected) {
    let next = `${base}/items/${encode(folder)}/children?$select=id,name,size,file,createdBy,createdDateTime,parentReference&$top=200`;
    const result = [], visited = new Set();
    while (next) {
      if (visited.has(next)) throw new Error('OneDrive liefert eine wiederholte Seite. Bitte erneut versuchen.');
      visited.add(next);
      const page = await request(next, {}, expected);
      if (!Array.isArray(page?.value)) throw new Error('Das Brett konnte nicht gelesen werden.');
      result.push(...page.value.filter((item) => item.file && /^wish-[a-z0-9-]+\.json$/i.test(item.name) && Number.isFinite(item.size) && item.size >= 0 && item.size <= 6000));
      if (result.length > 500 || visited.size > 10) throw new Error('Das Brett ist voll. Bitte alte Wünsche entfernen.');
      next = page['@odata.nextLink'];
    }
    return result;
  }
  return {
    driveId,
    async open() {
      const expected = session();
      const me = await request('/me?$select=id,displayName', {}, expected);
      const address = itemId ? `${base}/items/${encode(itemId)}` : `${base}/root:/${BOARD_NAME}`;
      const folder = await request(`${address}?$select=id,folder`, { missing: true }, expected);
      // Ein Empfänger braucht nur den geteilten Ordner, kein eigenes provisioniertes OneDrive.
      const ownDrive = await request('/me/drive?$select=id', { missing: true, optionalAccess: true }, expected);
      if (folder && !folder.folder) throw new Error('Am vorgesehenen Ort liegt eine Datei statt eines Ordners.');
      return { me, folder, owner: String(ownDrive?.id).toLowerCase() === String(driveId).toLowerCase() };
    },
    async setup() {
      const expected = session();
      const own = await request('/me/drive?$select=id', {}, expected);
      if (String(own.id).toLowerCase() !== String(driveId).toLowerCase()) throw new Error('Nur der Besitzer kann das Brett einrichten.');
      return request(`${base}/root/children`, { method: 'POST', body: JSON.stringify({ name: BOARD_NAME, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) }, expected);
    },
    async posts(folder) {
      const expected = session();
      const items = await files(folder, expected), posts = [];
      let skipped = 0;
      for (let at = 0; at < items.length; at += 4) {
        const group = await Promise.all(items.slice(at, at + 4).map(async (item) => {
          const metadata = await request(`${base}/items/${encode(item.id)}`, { missing: true }, expected);
          if (!metadata) return null;
          const download = new URL(metadata['@microsoft.graph.downloadUrl']);
          if (download.protocol !== 'https:' || download.username || download.password) throw new Error('Ungültige Download-Adresse.');
          // Graph /content leitet um. Die kurzlebige Download-Adresse erhält niemals den Graph-Bearer.
          const response = await fetcher(download.href, { redirect: 'error', signal: signal() });
          if (session() !== expected) throw new Error('Die Anmeldung wurde geändert.');
          if (!response.ok) throw new Error('Ein Wunsch konnte nicht geladen werden. Bitte aktualisieren.');
          let data;
          try { data = await response.json(); } catch { skipped++; return null; }
          if (session() !== expected) throw new Error('Die Anmeldung wurde geändert.');
          try {
            if (data.version !== 1) { skipped++; return null; }
            const valid = validateWish(data.title, data.text);
            return { ...valid, id: item.id, author: item.createdBy?.user?.displayName || 'Microsoft-Konto', authorId: item.createdBy?.user?.id || '', createdAt: item.createdDateTime || '' };
          } catch { skipped++; return null; }
        }));
        posts.push(...group.filter(Boolean));
      }
      posts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      posts.skipped = skipped;
      return posts;
    },
    add(folder, title, text) {
      const body = validateWish(title, text);
      return request(`${base}/items/${encode(folder)}:/wish-${crypto.randomUUID()}.json:/content`, { method: 'PUT', body: JSON.stringify(body) });
    },
    async remove(folder, id) {
      const expected = session();
      const file = await request(`${base}/items/${encode(id)}?$select=name,parentReference`, {}, expected);
      if (file?.parentReference?.id !== folder || !/^wish-[a-z0-9-]+\.json$/i.test(file.name)) throw new Error('Der Beitrag gehört nicht zu diesem Brett.');
      return request(`${base}/items/${encode(id)}`, { method: 'DELETE' }, expected);
    },
  };
}

export const board = createBoardClient(CONFIG.board);

export function setBoardNotifications(value) {
  try {
    if (value) window.localStorage.setItem(NOTIFY_KEY, JSON.stringify({ ...value, baselineAt: Date.now() }));
    else window.localStorage.removeItem(NOTIFY_KEY);
    window.dispatchEvent(new Event('heimkino-auth-changed'));
  } catch { throw new Error('Benachrichtigungen benötigen lokalen Speicher.'); }
}
