// Heimkino als Handy-App: Startseite mit großer Titelfläche und Poster-Reihen, Detailseite mit Beschreibung,
// IMDb-Bewertung, FSK, Trailer und Folgen, Abspielen mit Weiterschauen. Alles kommt direkt aus OneDrive,
// die Filmdaten aus "heimkino-katalog.json" (erzeugt auf dem Laptop von scripts/film-infos.js).
import { AuthError, completeLogin, hasSession, isConfigured, login, logout } from './auth.js';
import { announce, h } from './dom.js';
import { NBSP, formatBytes, formatDuration, initialOf, resolutionLabel } from './format.js';
import { SignInNeeded, demo, oneDrive } from './sources.js';
import { allProgress, clearProgress, getProgress, isFinished, isResumable, saveProgress } from './store.js';

const view = document.getElementById('view');
const foot = document.getElementById('foot');
const searchInput = document.getElementById('search');
const searchForm = document.getElementById('search-form');
const refreshButton = document.getElementById('rescan');

const MODE_KEY = 'heimkino-handy:v1:mode';
const CACHE_KEY = 'heimkino-handy:v2:library';
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

const state = {
  source: null,
  library: null, // { items, missing, meta, at }
  titles: [],
  account: '',
  error: null,
  loading: false,
  route: { name: 'library', q: '' },
  teardown: null,
  renderId: 0,
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

const PLAY_ICON = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M7 4.5v15l13-7.5z');
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
};

function button(label, onclick, kind = '') {
  return h('button', { class: `btn ${kind}`.trim(), type: 'button', onclick, text: label });
}

function linkButton(label, href, kind = '', icon = null) {
  return h('a', { class: `btn ${kind}`.trim(), href }, icon, h('span', { text: label }));
}

function stateBlock({ title, text, actions = [] }) {
  return h('div', { class: 'page' }, h('div', { class: 'container' }, h('div', { class: 'state' }, h('h1', { text: title }), h('p', { text }), actions.length > 0 && h('div', { class: 'actions' }, actions))));
}

function panel({ title, text, actions = [], tone }) {
  return h('div', { class: 'panel', dataset: tone ? { tone } : {} }, h('h2', { text: title }), h('p', { text }), actions.length > 0 && h('div', { class: 'panel__actions' }, actions));
}

// Bildfläche mit Anfangsbuchstaben als Ersatz, falls das Bild fehlt oder nicht lädt
function art(src, label, { className = 'art', alt = '', eager = false } = {}, ...extra) {
  return h(
    'div',
    { class: className },
    h('span', { class: 'art__initial', 'aria-hidden': 'true', text: label }),
    src && h('img', { src, alt, loading: eager ? 'eager' : 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onerror: (event) => event.target.remove() }),
    ...extra,
  );
}

function meter(progress) {
  if (!isResumable(progress)) return null;
  const bar = h('span');
  bar.style.setProperty('--p', String(Math.min(1, progress.t / progress.d)));
  return h('div', { class: 'meter', 'aria-hidden': 'true' }, bar);
}

const number = (value, digits = 1) => value.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function runtimeLabel(minutes) {
  if (!minutes) return '';
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return hours > 0 ? `${hours}${NBSP}Std.${rest ? ` ${rest}${NBSP}Min.` : ''}` : `${rest}${NBSP}Min.`;
}

function votesLabel(votes) {
  if (!votes) return '';
  return votes >= 1000 ? `${Math.round(votes / 1000).toLocaleString('de-DE')}${NBSP}Tsd. Stimmen` : `${votes} Stimmen`;
}

function ratingItem(meta, { long = false } = {}) {
  if (meta?.imdbRating) {
    return h('li', { class: 'rating' }, `IMDb ${number(meta.imdbRating)}`, long && meta.imdbVotes ? h('span', { text: ` (${votesLabel(meta.imdbVotes)})` }) : null);
  }
  if (meta?.tmdbRating) return h('li', { class: 'rating' }, `TMDB ${number(meta.tmdbRating)}`);
  return null;
}

// ---------- Titel (Film oder Serie) ----------

function buildTitles(library) {
  const map = new Map();
  for (const item of library.items) {
    let title = map.get(item.metaKey);
    if (!title) {
      const meta = library.meta?.[item.metaKey] ?? null;
      const kind = meta?.kind ?? (item.query?.kind === 'tv' ? 'tv' : 'movie');
      // Ohne Filmdaten: Name aus dem Ordner, das Jahr steht getrennt daneben
      const fallbackName = kind === 'tv' ? (item.query?.name ?? item.collection) : (item.query?.name || item.title);
      title = { key: item.metaKey, meta, kind, items: [], fallbackName, fallbackYear: item.query?.year ?? null, added: 0 };
      map.set(item.metaKey, title);
    }
    title.items.push(item);
    title.added = Math.max(title.added, Date.parse(item.modified ?? '') || 0);
  }
  const titles = [...map.values()];
  for (const t of titles) {
    t.name = t.meta?.title ?? t.fallbackName;
    t.year = t.meta?.year ?? t.fallbackYear;
    t.items.sort((a, b) => (a.query?.season ?? 0) - (b.query?.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || collator.compare(a.title, b.title));
  }
  return titles.sort((a, b) => collator.compare(a.name, b.name));
}

const titleByKey = (key) => state.titles.find((t) => t.key === key);
const titleOfItem = (item) => state.titles.find((t) => t.key === item.metaKey);
const posterOf = (t) => t.meta?.poster ?? t.items[0]?.thumb ?? null;
const backdropOf = (t) => t.meta?.backdrop ?? t.items[0]?.thumb ?? null;

function episodeMeta(t, item) {
  if (t.kind !== 'tv' || item.episode === null) return null;
  return t.meta?.seasons?.[item.query?.season ?? 1]?.episodes?.[item.episode] ?? null;
}

function playLabel(t, item, progress) {
  if (isResumable(progress)) return `Weiter ab ${formatDuration(progress.t)}`;
  if (t.kind === 'tv' && item.episode !== null) return `Folge ${item.episode} abspielen`;
  return 'Abspielen';
}

function episodeLabel(t, item) {
  const em = episodeMeta(t, item);
  if (item.episode === null) return item.title;
  return em?.title ? `${item.episode}. ${em.title}` : `Folge ${item.episode}`;
}

// Was "Abspielen" startet: angefangenes Video, sonst die erste nicht gesehene Folge, sonst das erste.
function nextItemOf(t) {
  const progress = allProgress();
  const started = t.items.filter((i) => isResumable(progress[i.id])).sort((a, b) => progress[b.id].at - progress[a.id].at)[0];
  if (started) return started;
  return t.items.find((i) => !isFinished(progress[i.id])) ?? t.items[0];
}

// ---------- Adresse ----------

function parseRoute() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  const watch = /^\/watch\/(.+)$/.exec(path);
  if (watch) return { name: 'watch', id: decodeURIComponent(watch[1]) };
  const title = /^\/title\/(.+)$/.exec(path);
  if (title) return { name: 'title', key: decodeURIComponent(title[1]) };
  return { name: 'library', q: new URLSearchParams(query).get('q') ?? '' };
}

const libraryHash = (q) => (q ? `#/?q=${encodeURIComponent(q)}` : '#/');
const titleHash = (key) => `#/title/${encodeURIComponent(key)}`;
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

function setLibrary(library) {
  state.library = library;
  state.titles = library ? buildTitles(library) : [];
}

async function loadLibrary() {
  state.loading = true;
  refreshButton.setAttribute('aria-busy', 'true');
  try {
    const result = await state.source.library();
    setLibrary({ ...result, at: Date.now() });
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

// ---------- Startseite ----------

function posterCard(t) {
  const progress = allProgress();
  const started = t.items.find((i) => isResumable(progress[i.id]));
  const facts = [t.year && h('li', { text: String(t.year) }), ratingItem(t.meta)].filter(Boolean);
  return h(
    'li',
    {},
    h(
      'a',
      { class: 'poster', href: titleHash(t.key) },
      art(posterOf(t), initialOf(t.name), {}, started && meter(progress[started.id])),
      h('h3', { class: 'poster__title', text: t.name }),
      facts.length > 0 && h('ul', { class: 'facts' }, facts),
    ),
  );
}

function continueCard(item) {
  const t = titleOfItem(item);
  const progress = getProgress(item.id);
  const em = t ? episodeMeta(t, item) : null;
  const left = progress ? Math.max(0, progress.d - progress.t) : 0;
  const image = em?.still ?? (t ? backdropOf(t) : item.thumb);
  return h(
    'li',
    {},
    h(
      'a',
      { class: 'still', href: watchHash(item.id) },
      art(image, initialOf(t?.name ?? item.title), {}, meter(progress)),
      h('h3', { class: 'still__title', text: t?.kind === 'tv' ? `${t.name}: ${episodeLabel(t, item)}` : (t?.name ?? item.title) }),
      left > 0 && h('ul', { class: 'facts' }, h('li', { text: `noch ${runtimeLabel(left / 60)}` })),
    ),
  );
}

function row(title, cards, { wide = false } = {}) {
  const id = `row-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return h(
    'section',
    { class: 'row container', 'aria-labelledby': id },
    h('div', { class: 'row__head' }, h('h2', { id, text: title })),
    h('ul', { class: `rail${wide ? ' rail--wide' : ''}` }, cards),
  );
}

function pickHero() {
  const progress = allProgress();
  const resumeItem = state.library.items.filter((i) => isResumable(progress[i.id])).sort((a, b) => progress[b.id].at - progress[a.id].at)[0];
  const resumeTitle = resumeItem && titleOfItem(resumeItem);
  if (resumeTitle?.meta?.backdrop) return resumeTitle;
  const withArt = state.titles.filter((t) => t.meta?.backdrop).sort((a, b) => b.added - a.added);
  return withArt[0] ?? [...state.titles].sort((a, b) => b.added - a.added)[0];
}

function hero(t) {
  const next = nextItemOf(t);
  const progress = getProgress(next.id);
  const resumable = isResumable(progress);
  const facts = [ratingItem(t.meta), t.year && h('li', { text: String(t.year) }), t.meta?.fsk && h('li', {}, h('span', { class: 'badge', text: `FSK ${t.meta.fsk}` })), t.meta?.runtime && t.kind === 'movie' && h('li', { text: runtimeLabel(t.meta.runtime) })].filter(Boolean);
  return h(
    'section',
    { class: 'hero', 'aria-labelledby': 'hero-title' },
    h('div', { class: 'hero__art' }, backdropOf(t) && h('img', { src: backdropOf(t), alt: '', decoding: 'async', fetchpriority: 'high', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() })),
    h(
      'div',
      { class: 'container hero__body' },
      h('h2', { class: 'hero__title', id: 'hero-title', text: t.name }),
      facts.length > 0 && h('ul', { class: 'facts' }, facts),
      t.meta?.overview && h('p', { class: 'hero__text', text: t.meta.overview }),
      h(
        'div',
        { class: 'actions' },
        linkButton(playLabel(t, next, progress), watchHash(next.id), 'btn--play', PLAY_ICON()),
        linkButton('Mehr Infos', titleHash(t.key), 'btn--quiet'),
      ),
    ),
  );
}

function renderLibrary() {
  document.title = 'Heimkino';
  const lib = state.library;
  if (!lib) {
    view.replaceChildren(state.error ? errorState() : skeleton());
    return;
  }
  const notices = (lib.missing ?? []).map((p) => h('p', { class: 'notice container', text: `Den Ordner „${p}“ gibt es in OneDrive noch nicht. Er entsteht, sobald dort die erste Handy-Fassung liegt.` }));
  if (state.error) notices.unshift(h('p', { class: 'notice container', role: 'status', text: 'Gerade keine Verbindung zu OneDrive. Du siehst den letzten Stand.' }));

  if (state.titles.length === 0) {
    view.replaceChildren(...notices, stateBlock({ title: 'Noch keine Filme', text: 'In OneDrive liegen noch keine Handy-Fassungen. Sie erscheinen hier, sobald die Umwandlung auf dem Laptop die ersten fertig hat.', actions: [button('Neu laden', refresh)] }));
    return;
  }

  const q = state.route.q?.trim().toLowerCase();
  if (q) {
    const found = state.titles.filter((t) => [t.name, t.meta?.originalTitle, t.fallbackName, ...(t.meta?.genres ?? [])].filter(Boolean).join(' ').toLowerCase().includes(q));
    if (found.length === 0) {
      view.replaceChildren(stateBlock({ title: 'Nichts gefunden', text: `Zu „${state.route.q}“ gibt es keinen Titel. Prüfe die Schreibweise oder lösche die Suche.`, actions: [button('Suche löschen', () => { searchInput.value = ''; window.location.hash = '#/'; })] }));
      return;
    }
    view.replaceChildren(h('div', { class: 'page' }, h('section', { class: 'container', 'aria-labelledby': 'results' }, h('div', { class: 'row__head' }, h('h1', { id: 'results', class: 'visually-hidden', text: 'Suchergebnisse' }), h('h2', { text: `${found.length} ${found.length === 1 ? 'Treffer' : 'Treffer'} für „${state.route.q}“` })), h('ul', { class: 'grid' }, found.map(posterCard)))));
    return;
  }

  const progress = allProgress();
  const resumable = state.library.items.filter((i) => isResumable(progress[i.id])).sort((a, b) => progress[b.id].at - progress[a.id].at).slice(0, 12);
  const recent = [...state.titles].sort((a, b) => b.added - a.added).slice(0, 12);
  const series = state.titles.filter((t) => t.kind === 'tv');
  const movies = state.titles.filter((t) => t.kind !== 'tv');

  const parts = [
    h('h1', { class: 'visually-hidden', text: 'Heimkino' }),
    hero(pickHero()),
    ...notices,
    resumable.length > 0 && row('Weiter ansehen', resumable.map(continueCard), { wide: true }),
    state.titles.length > 6 && row('Neu hinzugefügt', recent.map(posterCard)),
    series.length > 0 && row('Serien', series.map(posterCard)),
    movies.length > 0 && h(
      'section',
      { class: 'row container', 'aria-labelledby': 'row-all' },
      h('div', { class: 'row__head' }, h('h2', { id: 'row-all', text: 'Alle Filme' }), h('span', { class: 'count', text: `${movies.length}` })),
      h('ul', { class: 'grid' }, movies.map(posterCard)),
    ),
  ];
  view.replaceChildren(...parts.filter(Boolean));
}

function skeleton() {
  return h('div', { class: 'page', 'aria-hidden': 'true' }, h('div', { class: 'container' }, h('ul', { class: 'grid' }, Array.from({ length: 9 }, () => h('li', { class: 'skeleton' }, h('div', { class: 'skeleton__frame', style: { 'aspect-ratio': '2 / 3' } }), h('div', { class: 'skeleton__line' }))))));
}

function errorState() {
  const offline = navigator.onLine === false;
  return stateBlock({
    title: offline ? 'Kein Internet' : 'OneDrive antwortet nicht',
    text: offline ? 'Ohne Verbindung lässt sich die Bibliothek nicht laden. Versuch es, sobald du wieder Netz hast.' : `${state.error?.message ?? 'Unbekannter Fehler.'} Versuch es gleich noch einmal.`,
    actions: [button('Erneut versuchen', refresh)],
  });
}

// ---------- Detailseite ----------

async function ensureLibrary(token) {
  if (state.library) return true;
  view.replaceChildren(skeleton());
  await loadLibrary();
  return token === state.renderId && Boolean(state.library);
}

async function renderTitle(key, token) {
  if (!(await ensureLibrary(token))) return;
  const t = titleByKey(key);
  if (!t) {
    view.replaceChildren(stateBlock({ title: 'Diesen Titel gibt es nicht mehr', text: 'Er wurde in OneDrive verschoben oder gelöscht.', actions: [linkButton('Zur Startseite', '#/')] }));
    return;
  }
  document.title = `${t.name} | Heimkino`;
  const meta = t.meta ?? {};
  const next = nextItemOf(t);
  const progress = getProgress(next.id);
  const resumable = isResumable(progress);

  const facts = [
    ratingItem(meta, { long: true }),
    t.year && h('li', { text: String(t.year) }),
    meta.fsk && h('li', {}, h('span', { class: 'badge', text: `FSK ${meta.fsk}` })),
    t.kind === 'movie' && (meta.runtime || next.duration) > 0 && h('li', { text: runtimeLabel(meta.runtime || next.duration / 60) }),
    t.kind === 'tv' && h('li', { text: `${t.items.length} ${t.items.length === 1 ? 'Folge' : 'Folgen'}` }),
    meta.genres?.length > 0 && h('li', { text: meta.genres.slice(0, 3).join(', ') }),
  ].filter(Boolean);

  const actions = [linkButton(playLabel(t, next, progress), watchHash(next.id), 'btn--play', PLAY_ICON())];
  if (resumable) actions.push(button('Von vorn', () => { clearProgress(next.id); window.location.hash = watchHash(next.id); }, 'btn--quiet'));
  if (meta.trailer) actions.push(button('Trailer', () => openTrailer(t), 'btn--quiet'));

  const sections = [];
  if (t.kind === 'tv') {
    const all = allProgress();
    sections.push(
      h(
        'section',
        { class: 'detail__section container', 'aria-labelledby': 'episodes' },
        h('h2', { id: 'episodes', text: 'Folgen' }),
        h(
          'ol',
          { class: 'episodes' },
          t.items.map((item) => {
            const em = episodeMeta(t, item);
            const image = em?.still ?? item.thumb;
            const minutes = em?.runtime || (item.duration ? Math.round(item.duration / 60) : null);
            return h(
              'li',
              {},
              h(
                'a',
                { class: 'episode', href: watchHash(item.id) },
                art(image, String(item.episode ?? ''), {}, meter(all[item.id])),
                h('div', { class: 'episode__body' }, h('h3', { class: 'episode__title', text: episodeLabel(t, item) }), minutes > 0 && h('ul', { class: 'facts' }, h('li', { text: runtimeLabel(minutes) })), em?.overview && h('p', { class: 'episode__text', text: em.overview })),
              ),
            );
          }),
        ),
      ),
    );
  }
  const file = t.items[0];
  sections.push(
    h(
      'section',
      { class: 'detail__section container', 'aria-labelledby': 'filedata' },
      h('h2', { id: 'filedata', text: 'Datei' }),
      h('dl', { class: 'filedata' }, [
        ['Auflösung', resolutionLabel(file.width, file.height)],
        ['Größe', formatBytes(t.items.reduce((sum, i) => sum + (i.size ?? 0), 0))],
        ['Format', 'MP4, H.264 und AAC'],
      ].filter(([, v]) => v).map(([label, value]) => h('div', {}, h('dt', { text: label }), h('dd', { text: value })))),
    ),
  );

  view.replaceChildren(
    h(
      'article',
      { class: 'detail' },
      h('div', { class: 'detail__art' }, backdropOf(t) && h('img', { src: backdropOf(t), alt: '', decoding: 'async', fetchpriority: 'high', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() })),
      h('div', { class: 'container detail__top' }, h('a', { class: 'btn btn--text back', href: libraryHash(''), text: 'Zur Startseite' })),
      h(
        'div',
        { class: 'container detail__layout' },
        art(meta.poster, initialOf(t.name), { className: 'art detail__poster', alt: `Poster: ${t.name}`, eager: true }),
        h(
          'div',
          { class: 'detail__info' },
          h('h1', { text: t.name }),
          meta.originalTitle && meta.originalTitle !== t.name && h('p', { class: 'detail__original', text: `Originaltitel: ${meta.originalTitle}` }),
          facts.length > 0 && h('ul', { class: 'facts' }, facts),
          h('div', { class: 'actions' }, actions),
          meta.tagline && h('p', { class: 'detail__tagline', text: meta.tagline }),
          meta.overview && h('p', { class: 'detail__overview', text: meta.overview }),
          !t.meta && h('p', { class: 'hint', text: 'Für diesen Titel gibt es noch keine Filmdaten. Sie kommen dazu, sobald auf dem Laptop „film-infos“ gelaufen ist.' }),
        ),
      ),
      ...sections,
    ),
  );
}

// Trailer von YouTube, erst beim Klick geladen (ohne Cookies: youtube-nocookie.com)
function openTrailer(t) {
  const frame = h('div', { class: 'trailer__frame' });
  const dialog = h(
    'dialog',
    { class: 'trailer', 'aria-label': `Trailer: ${t.name}` },
    h('div', { class: 'trailer__bar' }, h('h2', { text: `Trailer: ${t.name}` }), button('Schließen', () => dialog.close(), 'btn--quiet')),
    frame,
  );
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  const iframe = h('iframe', {
    src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(t.meta.trailer)}?autoplay=1&rel=0&hl=de`,
    title: `Trailer: ${t.name}`,
    allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
    allowfullscreen: true,
    referrerpolicy: 'strict-origin-when-cross-origin',
  });
  frame.append(iframe);
  document.body.append(dialog);
  dialog.showModal();
}

// ---------- Abspielen ----------

async function renderWatch(id, token) {
  if (!(await ensureLibrary(token))) return;
  const item = state.library.items.find((i) => i.id === id);
  if (!item) {
    view.replaceChildren(stateBlock({ title: 'Dieses Video gibt es nicht mehr', text: 'Es wurde in OneDrive verschoben oder gelöscht.', actions: [linkButton('Zur Startseite', '#/')] }));
    return;
  }
  const t = titleOfItem(item);
  const name = t?.name ?? item.title;
  document.title = `${name} | Heimkino`;
  const ctx = { item, t, video: null, media: h('div'), notice: h('p', { class: 'notice', 'aria-live': 'polite' }), resumed: false, retried: false, lastSave: 0, token };

  view.replaceChildren(
    h(
      'div',
      { class: 'page' },
      h(
        'div',
        { class: 'container player' },
        h('a', { class: 'btn btn--text back', href: t ? titleHash(t.key) : '#/', text: t?.kind === 'tv' ? `Zurück zu ${name}` : 'Zurück' }),
        ctx.media,
        h('div', {}, h('h1', { class: 'player__title', text: name }), t?.kind === 'tv' && h('p', { class: 'player__sub', text: episodeLabel(t, item) })),
        ctx.notice,
      ),
    ),
  );
  ctx.onKey = (event) => onKey(ctx, event);
  document.addEventListener('keydown', ctx.onKey, true);
  state.teardown = () => {
    document.removeEventListener('keydown', ctx.onKey, true);
    persist(ctx);
  };
  await mountVideo(ctx, { autoplay: true });
}

async function mountVideo(ctx, { resumeAt = null, autoplay = false } = {}) {
  const { item, t } = ctx;
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

  const poster = (t && episodeMeta(t, item)?.still) ?? (t ? backdropOf(t) : item.thumb);
  const video = h('video', { controls: true, playsinline: true, preload: 'metadata', poster: poster ?? null, 'aria-label': t?.name ?? item.title });
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
  if (autoplay) video.play().catch(() => {}); // verweigert der Browser den Start, genügt ein Tippen auf Wiedergabe
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
  const list = ctx.t?.items ?? [];
  const at = list.findIndex((i) => i.id === ctx.item.id);
  const next = at >= 0 ? list[at + 1] : null;
  if (!next) return;
  ctx.notice.replaceChildren(`Als Nächstes: ${episodeLabel(ctx.t, next)} `, button('Abspielen', () => { window.location.hash = watchHash(next.id); }));
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
  const signIn = button('Bei Microsoft anmelden', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await login();
    } catch (err) {
      showSignIn(err.message);
    }
  });
  view.replaceChildren(
    h(
      'div',
      { class: 'page' },
      h(
        'div',
        { class: 'container' },
        h(
          'div',
          { class: 'state' },
          h('h1', { text: 'Mit OneDrive verbinden' }),
          h('p', { text: 'Heimkino zeigt die Handy-Fassungen aus deinem OneDrive. Du meldest dich direkt bei Microsoft an, die App sieht dein Passwort nie und darf nur lesen.' }),
          message && h('p', { class: 'help', dataset: { tone: 'error' }, role: 'alert', text: message }),
          h('div', { class: 'actions' }, signIn),
        ),
      ),
    ),
  );
}

function startDemo() {
  storageSet(window.sessionStorage, MODE_KEY, 'demo');
  state.source = demo;
  setLibrary(null);
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
  const left = `${state.titles.length} ${state.titles.length === 1 ? 'Titel' : 'Titel'}${when ? `, Stand ${when}` : ''}.`;
  const right =
    state.source === demo
      ? h('div', { class: 'foot__actions' }, h('span', { text: 'Demo' }), button('Demo beenden', endDemo, 'btn--text'))
      : h('div', { class: 'foot__actions' }, state.account && h('span', { text: state.account }), button('Abmelden', () => { logout(); storageSet(window.localStorage, CACHE_KEY, null); window.location.replace(window.location.pathname); }, 'btn--text'));
  const hasMeta = Object.keys(state.library.meta ?? {}).length > 0;
  foot.replaceChildren(
    h('p', { text: left }),
    right,
    hasMeta && h('p', { class: 'credit', text: 'Filmdaten und Bilder von TMDB. Diese App nutzt die TMDB-API, ist aber nicht von TMDB unterstützt oder zertifiziert. Bewertungen von IMDb.' }),
  );
}

// ---------- Ablauf ----------

function render() {
  state.teardown?.();
  state.teardown = null;
  state.renderId += 1;
  if (state.route.name === 'watch') renderWatch(state.route.id, state.renderId).then(renderFoot);
  else if (state.route.name === 'title') renderTitle(state.route.key, state.renderId).then(renderFoot);
  else renderLibrary();
  renderFoot();
}

async function refresh() {
  if (!state.source || state.loading) return;
  const ok = await loadLibrary();
  if (document.body.hasAttribute('data-locked')) return;
  render();
  if (ok) announce('Die Bibliothek ist aktuell.');
}

async function boot() {
  state.route = parseRoute();
  if (document.activeElement !== searchInput) searchInput.value = state.route.name === 'library' ? state.route.q : '';
  view.replaceChildren(skeleton());

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
    if (!state.library) setLibrary(readCache()); // sofort den letzten Stand zeigen, dann auffrischen
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
