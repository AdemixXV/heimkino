// Heimkino als Handy-App: Bibliothek mit Covern aus OneDrive, Abspielen, Weiterschauen, Suche.
// Läuft ganz im Browser. Der Laptop muss dafür nicht an sein.
import { AuthError, completeLogin, hasSession, isConfigured, login, logout } from './auth.js';
import { announce, h } from './dom.js';
import { countVideos, formatBytes, formatDuration, initialOf, resolutionLabel } from './format.js';
import { SignInNeeded, demo, oneDrive } from './sources.js';
import { allProgress, clearProgress, getProgress, isResumable, saveProgress } from './store.js';

const view = document.getElementById('view');
const foot = document.getElementById('foot');
const searchInput = document.getElementById('search');
const searchForm = document.getElementById('search-form');
const refreshButton = document.getElementById('rescan');

const MODE_KEY = 'heimkino-handy:v1:mode';
const CACHE_KEY = 'heimkino-handy:v1:library';

const state = {
  source: null,
  library: null, // { items, missing, at }
  account: '',
  error: null,
  loading: false,
  route: { name: 'library', q: '' },
  teardown: null,
  renderId: 0,
  headingCounter: 0,
};

// ---------- Kleine Helfer ----------

function storageGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(storage, key, value) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Speicher gesperrt: geht auch ohne
  }
}

function button(label, onclick, kind = '') {
  return h('button', { class: `btn ${kind}`.trim(), type: 'button', onclick, text: label });
}

function stateBlock({ title, text, actions = [], level = 'h1' }) {
  return h('div', { class: 'state' }, h(level, { text: title }), h('p', { text }), actions.length > 0 && h('div', { class: 'panel__actions' }, actions));
}

function panel({ title, text, actions = [], tone }) {
  return h('div', { class: 'panel', dataset: tone ? { tone } : {} }, h('h2', { text: title }), h('p', { text }), actions.length > 0 && h('div', { class: 'panel__actions' }, actions));
}

// ---------- Adresse ----------

function parseRoute() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  const watch = /^\/watch\/(.+)$/.exec(path);
  if (watch) return { name: 'watch', id: decodeURIComponent(watch[1]) };
  return { name: 'library', q: new URLSearchParams(query).get('q') ?? '' };
}

const libraryHash = (q) => (q ? `#/?q=${encodeURIComponent(q)}` : '#/');
const watchHash = (id) => `#/watch/${encodeURIComponent(id)}`;

// ---------- Daten ----------

function readCache() {
  try {
    const data = JSON.parse(storageGet(window.localStorage, CACHE_KEY) ?? 'null');
    return data && Array.isArray(data.items) ? data : null;
  } catch {
    return null;
  }
}

async function loadLibrary() {
  state.loading = true;
  refreshButton.setAttribute('aria-busy', 'true');
  try {
    const result = await state.source.library();
    state.library = { ...result, at: Date.now() };
    state.error = null;
    if (state.source === oneDrive) storageSet(window.localStorage, CACHE_KEY, JSON.stringify(state.library));
    return true;
  } catch (err) {
    if (err instanceof SignInNeeded) {
      showSignIn('Die Anmeldung ist abgelaufen. Microsoft lässt Browser-Apps etwa einen Tag angemeldet, danach genügt ein Tippen.');
      return false;
    }
    state.error = err;
    return false;
  } finally {
    state.loading = false;
    refreshButton.removeAttribute('aria-busy');
  }
}

function visibleItems() {
  const items = state.library?.items ?? [];
  const q = state.route.q?.trim().toLowerCase();
  return q ? items.filter((i) => `${i.title} ${i.collection}`.toLowerCase().includes(q)) : items;
}

// ---------- Bibliothek ----------

function renderLibrary() {
  document.title = 'Heimkino';
  const lib = state.library;
  if (!lib) {
    view.replaceChildren(state.error ? errorState() : skeletonShelf());
    return;
  }
  const notices = (lib.missing ?? []).map((p) => h('p', { class: 'notice', text: `Den Ordner „${p}“ gibt es in OneDrive noch nicht. Er entsteht, sobald dort die erste Handy-Fassung liegt.` }));
  if (state.error) notices.unshift(h('p', { class: 'notice', role: 'status', text: 'Gerade keine Verbindung zu OneDrive. Du siehst den letzten Stand.' }));

  if (lib.items.length === 0) {
    view.replaceChildren(...notices, stateBlock({ title: 'Noch keine Videos', text: 'In den OneDrive-Ordnern liegen noch keine Handy-Fassungen. Sie erscheinen hier, sobald die Umwandlung auf dem Laptop die ersten fertig hat.', actions: [button('Neu laden', refresh)] }));
    return;
  }
  const items = visibleItems();
  if (items.length === 0) {
    view.replaceChildren(stateBlock({
      title: 'Nichts gefunden',
      text: `Zu „${state.route.q}“ gibt es kein Video. Prüfe die Schreibweise oder lösche die Suche.`,
      actions: [button('Suche löschen', () => { searchInput.value = ''; window.location.hash = '#/'; })],
    }));
    return;
  }

  const progress = allProgress();
  const sections = [h('h1', { class: 'visually-hidden', text: 'Bibliothek' }), ...notices];
  if (!state.route.q) {
    const resumable = items.filter((i) => isResumable(progress[i.id])).sort((a, b) => progress[b.id].at - progress[a.id].at).slice(0, 12);
    if (resumable.length > 0) sections.push(shelfSection('Weiter ansehen', resumable, false));
  }
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.collection)) groups.set(item.collection, []);
    groups.get(item.collection).push(item);
  }
  for (const [name, list] of groups) sections.push(shelfSection(name, list, true));
  view.replaceChildren(...sections);
}

function shelfSection(title, items, withCount) {
  state.headingCounter += 1;
  const id = `shelf-${state.headingCounter}`;
  return h(
    'section',
    { class: 'section', 'aria-labelledby': id },
    h('div', { class: 'section__head' }, h('h2', { id, text: title }), withCount && h('span', { class: 'count', text: countVideos(items.length) })),
    h('ul', { class: 'shelf' }, items.map(makeCard)),
  );
}

function makeCard(item) {
  const progress = getProgress(item.id);
  const resumable = isResumable(progress);
  const time = formatDuration(item.duration);
  const meter = h('div', { class: 'meter', hidden: !resumable, 'aria-hidden': 'true' }, h('span'));
  if (resumable) meter.firstElementChild.style.setProperty('--p', String(Math.min(1, progress.t / progress.d)));
  const image = item.thumb
    ? h('img', { src: item.thumb, alt: '', width: 640, height: 360, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onerror: (event) => event.target.remove() })
    : null;
  const bits = [resolutionLabel(item.width, item.height), formatBytes(item.size)].filter(Boolean);
  return h(
    'li',
    {},
    h(
      'a',
      { class: 'card', href: watchHash(item.id) },
      h(
        'div',
        { class: 'card__frame' },
        h('span', { class: 'card__initial', 'aria-hidden': 'true', text: initialOf(item.title) }),
        image,
        time && h('span', { class: 'card__time', text: time, dataset: { lifted: resumable ? 'true' : 'false' } }),
        meter,
      ),
      h('div', { class: 'card__body' }, h('h3', { class: 'card__title', text: item.title }), h('ul', { class: 'meta' }, bits.map((text) => h('li', { text })))),
    ),
  );
}

function skeletonShelf() {
  return h('div', { 'aria-hidden': 'true' }, h('ul', { class: 'shelf' }, Array.from({ length: 8 }, () => h('li', { class: 'skeleton' }, h('div', { class: 'skeleton__frame' }), h('div', { class: 'skeleton__line' })))));
}

function errorState() {
  const offline = navigator.onLine === false;
  return stateBlock({
    title: offline ? 'Kein Internet' : 'OneDrive antwortet nicht',
    text: offline ? 'Ohne Verbindung lässt sich die Bibliothek nicht laden. Versuch es, sobald du wieder Netz hast.' : `${state.error?.message ?? 'Unbekannter Fehler.'} Versuch es gleich noch einmal.`,
    actions: [button('Erneut versuchen', refresh)],
  });
}

// ---------- Abspielen ----------

async function renderWatch(id, token) {
  if (!state.library) {
    view.replaceChildren(skeletonShelf());
    await loadLibrary();
    if (token !== state.renderId) return;
  }
  const item = state.library?.items.find((i) => i.id === id);
  if (!item) {
    view.replaceChildren(stateBlock({ title: 'Dieses Video gibt es nicht mehr', text: 'Es wurde in OneDrive verschoben oder gelöscht.', actions: [button('Zur Bibliothek', () => (window.location.hash = '#/'))] }));
    return;
  }
  document.title = `${item.title} | Heimkino`;
  const ctx = { item, video: null, media: h('div'), notice: h('p', { class: 'notice', 'aria-live': 'polite' }), resumed: false, retried: false, lastSave: 0, token };
  const details = [
    ['Dauer', formatDuration(item.duration)],
    ['Auflösung', resolutionLabel(item.width, item.height)],
    ['Größe', formatBytes(item.size)],
  ].filter(([, value]) => value);

  view.replaceChildren(
    h(
      'div',
      { class: 'watch' },
      h(
        'div',
        { class: 'watch__main' },
        h('a', { class: 'btn btn--text back', href: libraryHash(''), text: 'Zur Bibliothek' }),
        h('h1', { text: item.title }),
        ctx.media,
        ctx.notice,
        h('dl', { class: 'details' }, details.map(([label, value]) => h('div', {}, h('dt', { text: label }), h('dd', { text: value })))),
        h('p', { class: 'hint', text: item.collection }),
      ),
    ),
  );
  ctx.onKey = (event) => onKey(ctx, event);
  document.addEventListener('keydown', ctx.onKey, true);
  state.teardown = () => {
    document.removeEventListener('keydown', ctx.onKey, true);
    persist(ctx);
  };
  await mountVideo(ctx);
}

async function mountVideo(ctx, { resumeAt = null, autoplay = false } = {}) {
  const { item } = ctx;
  let url;
  try {
    url = await state.source.playUrl(item);
  } catch (err) {
    if (ctx.token !== state.renderId) return;
    if (err instanceof SignInNeeded) {
      showSignIn('Die Anmeldung ist abgelaufen. Danach geht es mit diesem Video weiter.');
      return;
    }
    ctx.media.replaceChildren(panel({ title: 'Das Video lässt sich nicht laden', text: err.message, tone: 'error', actions: [button('Erneut versuchen', () => mountVideo(ctx))] }));
    return;
  }
  if (ctx.token !== state.renderId) return;

  const video = h('video', { controls: true, playsinline: true, preload: 'metadata', poster: item.thumb ?? null, 'aria-label': item.title });
  ctx.video = video;
  ctx.media.replaceChildren(h('div', { class: 'stage' }, video));

  video.addEventListener('loadedmetadata', () => {
    if (resumeAt !== null) {
      video.currentTime = resumeAt;
      return;
    }
    const saved = getProgress(item.id);
    if (!ctx.resumed && isResumable(saved) && saved.t < video.duration - 15) {
      ctx.resumed = true;
      video.currentTime = saved.t;
      ctx.notice.replaceChildren(`Weiter bei ${formatDuration(saved.t)}. `, button('Von vorn', () => { video.currentTime = 0; clearProgress(item.id); ctx.notice.replaceChildren(); }, 'btn--text'));
    }
  });
  video.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - ctx.lastSave > 5000) {
      ctx.lastSave = now;
      persist(ctx);
    }
  });
  video.addEventListener('pause', () => persist(ctx));
  video.addEventListener('ended', () => {
    saveProgress(item.id, video.duration, video.duration);
    showNext(ctx);
  });
  video.addEventListener('error', () => onVideoError(ctx));
  video.src = url;
  if (autoplay) video.play().catch(() => {});
}

function persist(ctx) {
  const v = ctx.video;
  if (v && Number.isFinite(v.duration) && v.currentTime > 0) saveProgress(ctx.item.id, v.currentTime, v.duration);
}

// Die Abspieladresse von OneDrive gilt nur etwa eine Stunde. Läuft sie während einer langen Pause ab,
// wird einmal eine neue geholt und an derselben Stelle weitergemacht.
function onVideoError(ctx) {
  const error = ctx.video?.error;
  if (!error || error.code === 1) return;
  const position = ctx.video.currentTime || getProgress(ctx.item.id)?.t || 0;
  if (!ctx.retried) {
    ctx.retried = true;
    mountVideo(ctx, { resumeAt: position > 0 ? position : null, autoplay: position > 0 });
    return;
  }
  ctx.video = null;
  ctx.media.replaceChildren(
    panel({
      title: 'Das Video lässt sich nicht abspielen',
      text: error.code === 4 ? 'Dieses Format kennt der Browser nicht. Die Handy-Fassungen sind MP4 mit H.264, die laufen überall.' : 'Die Verbindung ist abgebrochen. Prüfe das Netz und versuch es noch einmal.',
      tone: 'error',
      actions: [button('Noch einmal versuchen', () => { ctx.retried = false; mountVideo(ctx, { resumeAt: position > 0 ? position : null, autoplay: true }); })],
    }),
  );
}

function showNext(ctx) {
  const list = (state.library?.items ?? []).filter((i) => i.collection === ctx.item.collection);
  const at = list.findIndex((i) => i.id === ctx.item.id);
  const next = at >= 0 ? list[at + 1] : null;
  if (!next) return;
  ctx.notice.replaceChildren(`Als Nächstes: ${next.title} `, button('Abspielen', () => { window.location.hash = watchHash(next.id); }));
}

function onKey(ctx, event) {
  const video = ctx.video;
  if (!video || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input, textarea, select')) return;
  const key = event.key.toLowerCase();
  if (key === ' ' && target?.closest('button, a')) return;
  const seek = (delta) => {
    video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + delta));
  };
  if (key === ' ' || key === 'k') {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  } else if (key === 'j') seek(-10);
  else if (key === 'l') seek(10);
  else if (key === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else video.requestFullscreen?.();
  } else if (key === 'm') video.muted = !video.muted;
  else return;
  event.preventDefault();
  event.stopPropagation();
}

// ---------- Anmelden ----------

function showSignIn(message = '') {
  state.teardown?.();
  state.teardown = null;
  document.body.dataset.locked = '';
  document.title = 'Anmelden | Heimkino';
  foot.replaceChildren();
  if (!isConfigured()) {
    view.replaceChildren(stateBlock({
      title: 'Noch nicht mit OneDrive verbunden',
      text: 'Für die Verbindung fehlt noch die Anwendungs-ID von Microsoft (in handy-app/config.js). Bis dahin zeigt die Demo, wie die App aussieht.',
      actions: [button('Demo ansehen', startDemo)],
    }));
    return;
  }
  const actions = [button('Bei Microsoft anmelden', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await login();
    } catch (err) {
      showSignIn(err.message);
    }
  })];
  view.replaceChildren(
    h(
      'div',
      { class: 'state' },
      h('h1', { text: 'Mit OneDrive verbinden' }),
      h('p', { text: 'Heimkino zeigt die Handy-Fassungen aus deinem OneDrive. Du meldest dich direkt bei Microsoft an, die App sieht dein Passwort nie und darf nur lesen.' }),
      message && h('p', { class: 'help', dataset: { tone: 'error' }, role: 'alert', text: message }),
      h('div', { class: 'panel__actions' }, actions),
    ),
  );
}

function startDemo() {
  storageSet(window.sessionStorage, MODE_KEY, 'demo');
  state.source = demo;
  state.library = null;
  document.body.removeAttribute('data-locked');
  boot();
}

function endDemo() {
  storageSet(window.sessionStorage, MODE_KEY, null);
  window.location.replace(window.location.pathname);
}

// ---------- Fuß ----------

function renderFoot() {
  if (!state.library || document.body.hasAttribute('data-locked')) {
    foot.replaceChildren();
    return;
  }
  const when = state.library.at ? new Date(state.library.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
  const left = `${countVideos(state.library.items.length)}${when ? `, Stand ${when}` : ''}.`;
  const right =
    state.source === demo
      ? h('div', { class: 'foot__actions' }, h('span', { text: 'Demo' }), button('Demo beenden', endDemo, 'btn--text'))
      : h('div', { class: 'foot__actions' }, state.account && h('span', { text: state.account }), button('Abmelden', () => { logout(); storageSet(window.localStorage, CACHE_KEY, null); window.location.replace(window.location.pathname); }, 'btn--text'));
  foot.replaceChildren(h('p', { text: left }), right);
}

// ---------- Ablauf ----------

function render() {
  state.teardown?.();
  state.teardown = null;
  state.renderId += 1;
  if (state.route.name === 'watch') renderWatch(state.route.id, state.renderId);
  else renderLibrary();
  renderFoot();
}

async function refresh() {
  if (!state.source || state.loading) return;
  const ok = await loadLibrary();
  if (document.body.hasAttribute('data-locked')) return;
  if (state.route.name === 'library') renderLibrary();
  renderFoot();
  if (ok) announce('Die Bibliothek ist aktuell.');
}

async function boot() {
  state.route = parseRoute();
  if (document.activeElement !== searchInput) searchInput.value = state.route.name === 'library' ? state.route.q : '';
  view.replaceChildren(skeletonShelf());

  const wantsDemo = new URLSearchParams(window.location.search).has('demo') || storageGet(window.sessionStorage, MODE_KEY) === 'demo';
  if (wantsDemo) {
    storageSet(window.sessionStorage, MODE_KEY, 'demo');
    state.source = demo;
  } else {
    try {
      await completeLogin();
    } catch (err) {
      showSignIn(err instanceof AuthError ? err.message : 'Die Anmeldung hat nicht geklappt. Versuch es noch einmal.');
      return;
    }
    if (!isConfigured() || !hasSession()) {
      showSignIn();
      return;
    }
    state.source = oneDrive;
    state.library = state.library ?? readCache(); // sofort den letzten Stand zeigen, dann auffrischen
  }

  document.body.removeAttribute('data-locked');
  if (state.library) render();
  const ok = await loadLibrary();
  if (document.body.hasAttribute('data-locked')) return;
  if (ok) state.account = await state.source.account().catch(() => '');
  render();
}

window.addEventListener('hashchange', () => {
  if (document.body.hasAttribute('data-locked')) return;
  state.route = parseRoute();
  if (document.activeElement !== searchInput) searchInput.value = state.route.name === 'library' ? state.route.q : '';
  render();
  window.scrollTo({ top: 0 });
});
window.addEventListener('pagehide', () => state.teardown?.());

let searchTimer = null;
searchForm.addEventListener('submit', (event) => event.preventDefault());
searchInput.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    const q = searchInput.value;
    if (state.route.name !== 'library') {
      window.location.hash = libraryHash(q);
      return;
    }
    window.history.replaceState(null, '', libraryHash(q));
    state.route = { name: 'library', q };
    renderLibrary();
  }, 120);
});
refreshButton.addEventListener('click', refresh);

boot();
