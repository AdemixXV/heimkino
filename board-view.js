import { h, announce } from './dom.js?v=5ad2108893';
import { canWriteBoard, login, sessionVersion } from './auth.js?v=5ad2108893';
import { board, BOARD_NAME, NOTIFY_KEY, setBoardNotifications } from './board.js?v=5ad2108893';

const btn = (text, onclick, quiet = false) => h('button', { type: 'button', class: `btn${quiet ? ' btn--quiet' : ''}`, text, onclick });
const sameId = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
const DRAFT = 'heimkino-handy:v1:board-draft';

export function mountBoard({ isDemo = false, isCurrent = () => true } = {}) {
  let disposed = false, busy = false, info = null, posts = [];
  const current = () => !disposed && isCurrent();
  const root = h('section', { class: 'page container board' }, h('h1', { class: 'page-title', text: 'Filmwünsche' }));
  const message = h('p', { role: 'status', class: 'help', 'aria-live': 'polite' });
  const body = h('div');
  root.append(message, body);
  const error = (err) => { if (current()) message.textContent = err.message || 'Das Brett konnte nicht geladen werden.'; };
  const act = async (event, work) => {
    if (busy) return;
    busy = true; event.currentTarget.disabled = true; message.textContent = '';
    try { await work(); } catch (err) { error(err); }
    finally { busy = false; if (current()) event.target.disabled = false; }
  };
  function draft() { try { return JSON.parse(window.sessionStorage.getItem(DRAFT)) ?? {}; } catch { return {}; } }
  function saveDraft(value) { try { window.sessionStorage.setItem(DRAFT, JSON.stringify(value)); } catch {} }
  async function writeAccess() {
    if (canWriteBoard()) return true;
    await login({ boardWrite: true }); return false;
  }
  function notifyConfig() {
    try { return JSON.parse(window.localStorage.getItem(NOTIFY_KEY)); } catch { return null; }
  }
  function updateBaseline() {
    const config = notifyConfig();
    if (config?.session === sessionVersion() && config.folderId === info?.folder.id) {
      setBoardNotifications({ ...config, known: posts.map((post) => post.id) });
    }
  }
  function draw() {
    if (!current()) return;
    if (!info.folder) {
      body.replaceChildren(h('p', { text: info.owner ? `Das Brett bekommt einen eigenen OneDrive-Ordner „${BOARD_NAME}“. Teile anschließend ausschließlich diesen Ordner zum Bearbeiten mit den gewünschten Konten.` : 'Das Brett wurde noch nicht eingerichtet oder dieses Konto kann es nicht öffnen. Der Besitzer muss den separaten Wünsche-Ordner freigeben.' }),
        info.owner ? btn(canWriteBoard() ? 'Brett einrichten' : 'Schreibrechte für das Brett erlauben', (event) => act(event, async () => { if (await writeAccess()) { await board.setup(); await load(); } })) : h('a', { class: 'btn btn--quiet', href: '#/profil', text: 'Zum Profil' }));
      return;
    }
    const values = draft();
    const title = h('input', { id: 'wish-title', type: 'text', required: true, maxlength: 160, value: values.title ?? '', autocomplete: 'off' });
    const text = h('textarea', { id: 'wish-text', maxlength: 1000, rows: 3, value: values.text ?? '' });
    const storeDraft = () => saveDraft({ title: title.value, text: text.value });
    title.addEventListener('input', storeDraft); text.addEventListener('input', storeDraft);
    const submit = h('button', { type: 'submit', class: 'btn', text: 'Film wünschen' });
    const form = h('form', { class: 'board__form', onsubmit: (event) => {
      event.preventDefault();
      act({ currentTarget: submit, target: submit }, async () => {
        storeDraft();
        if (!await writeAccess()) return;
        await board.add(info.folder.id, title.value, text.value);
        saveDraft({}); await load(); if (current()) announce('Dein Filmwunsch ist eingetragen.');
      });
    } }, h('h2', { text: 'Dein Filmwunsch' }), h('label', { for: 'wish-title', text: 'Filmtitel' }), title,
      h('label', { for: 'wish-text', text: 'Nachricht (optional)' }), text,
      !canWriteBoard() && h('p', { class: 'help', text: 'Beim ersten Beitrag fragt Microsoft nach Schreibrechten. Diese gelten technisch für deine OneDrive-Dateien einschließlich Ändern und Löschen. Heimkino bearbeitet ausschließlich den Wünsche-Ordner.' }), submit);
    const enabled = notifyConfig()?.session === sessionVersion();
    const native = window.heimkinoNotifications;
    const notifications = h('section', { class: 'panel' }, h('h2', { text: 'Benachrichtigungen' }),
      h('p', { text: native ? 'Prüft bei geschlossener App frühestens etwa alle 15 Minuten. Android kann länger warten. Bei abgelaufener Microsoft-Anmeldung pausieren Meldungen bis zur erneuten Anmeldung.' : 'Handy-Benachrichtigungen sind in der Heimkino-APK verfügbar. Hier siehst du neue Wünsche beim Aktualisieren.' }),
      native && btn(enabled ? 'Benachrichtigungen ausschalten' : 'Benachrichtigungen einschalten', (event) => act(event, async () => {
        if (enabled) { setBoardNotifications(null); native.disable(); }
        else {
          setBoardNotifications({ session: sessionVersion(), driveId: board.driveId, folderId: info.folder.id, known: posts.map((post) => post.id) });
          native.enable();
        }
        draw();
      }), true));
    body.replaceChildren(h('p', { text: 'Ein gemeinsames schwarzes Brett für eure Filmwünsche.' }),
      h('div', { class: 'actions' }, btn('Wünsche aktualisieren', (event) => act(event, load), true), h('a', { class: 'btn btn--quiet', href: '#/', text: 'Zur Startseite' })),
      notifications, form,
      h('h2', { text: `Wünsche (${posts.length})` }),
      posts.length ? h('ul', { class: 'board__posts' }, posts.map((post) => h('li', { class: 'panel' },
        h('h3', { text: post.title }), post.text && h('p', { class: 'board__text', text: post.text }),
        h('p', { class: 'help', text: `${post.author}${post.createdAt && Number.isFinite(Date.parse(post.createdAt)) ? ` · ${new Date(post.createdAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}` : ''}` }),
        (info.owner || sameId(post.authorId, info.me.id)) && btn('Wunsch entfernen', (event) => act(event, async () => {
          if (!window.confirm(`„${post.title}“ vom Brett entfernen?`)) return;
          if (!await writeAccess()) return;
          await board.remove(info.folder.id, post.id); await load();
        }), true)))) : h('p', { text: 'Noch keine Filmwünsche. Schreibe den ersten!' }),
      info.owner && h('p', { class: 'help', text: `Gemeinsamer Ordner: OneDrive → ${BOARD_NAME}. Weitere Konten benötigen dort Bearbeitungszugriff zum Schreiben. Die Filmfreigabe wird dadurch nicht geändert.` }));
  }
  async function load() {
    if (!current()) return;
    message.textContent = 'Filmwünsche werden geladen …';
    const next = await board.open();
    const nextPosts = next.folder ? await board.posts(next.folder.id) : [];
    if (!current()) return;
    info = next; posts = nextPosts;
    updateBaseline(); message.textContent = posts.skipped ? `${posts.skipped} beschädigte oder unbekannte Wunschdatei(en) wurden übersprungen.` : ''; draw();
  }
  const onNative = (event) => {
    if (!current()) return;
    if (event.detail?.enabled === false) {
      setBoardNotifications(null);
      message.textContent = 'Benachrichtigungen sind aus. Du kannst sie hier erneut einschalten und am Handy erlauben.';
    } else message.textContent = 'Benachrichtigungen sind eingeschaltet.';
    if (info) draw();
  };
  window.addEventListener('heimkino-notifications-status', onNative);
  const onReady = () => { if (info) draw(); };
  window.addEventListener('heimkino-notifications-ready', onReady);
  if (isDemo) body.append(h('p', { text: 'Filmwünsche werden in OneDrive gespeichert. Melde dich mit deinem Microsoft-Konto an, um das Brett zu öffnen.' }));
  else Promise.resolve().then(load).catch(error);
  return { element: root, dispose() { disposed = true; window.removeEventListener('heimkino-notifications-status', onNative); window.removeEventListener('heimkino-notifications-ready', onReady); } };
}
