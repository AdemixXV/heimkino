// Aus Datei- und Ordnernamen werden lesbare Titel und Regale.
// "Till.Death.Bis.dass.dein.Tod.uns.scheidet.2021.German.720p.BluRay.x264-iMPERiUM" -> "Till Death Bis dass dein Tod uns scheidet (2021)"
// Reine Logik ohne Browser-Zugriffe, damit sie sich auch in Node testen lässt.

// Ab diesen Wörtern beginnen bei Film-Dateinamen nur noch technische Angaben.
const RELEASE_WORD = new RegExp(
  '^(' +
    [
      'german', 'deutsch', 'english', 'dl', 'ml', 'dubbed', 'ld', 'md', 'ac3', 'ac3d', 'eac3', 'dts', 'dtshd', 'truehd', 'atmos', 'aac',
      '480p', '576p', '720p', '1080p', '1080i', '2160p', '4k', 'uhd', 'hdr', 'hdr10', 'hdr10plus', 'dv', 'sdr',
      'bluray', 'bdrip', 'brrip', 'web', 'webrip', 'web-dl', 'webdl', 'hdtv', 'hddvd', 'dvdrip', 'dvdr', 'hdrip', 'cam', 'ts', 'telesync',
      'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'remux', 'proper', 'repack', 'internal',
      'extended', 'unrated', 'uncut', 'theatrical', 'dc', 'complete', 'pal', 'ntsc', 'subbed', 'imax',
    ].join('|') +
    ')$',
  'i',
);
const VIDEO_EXT = /\.(mp4|m4v|mkv|mov|avi|webm|ts|mts|m2ts|wmv|flv|mpg|mpeg|vob|3gp)$/i;
const SEASON_EPISODE = /^s(\d{1,2})(?:e(\d{1,3}))?$/i;
const YEAR = /^(19|20)\d\d$/;

function tidyCase(text) {
  // Nur Kleinbuchstaben (z. B. "berlin", "abla tanzt"): ersten Buchstaben groß schreiben.
  return /\p{Lu}/u.test(text) ? text : text.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

// Einzelne Buchstaben hintereinander sind Abkürzungen: "S.H.I.T" -> "S.H.I.T.", "L.A" -> "L.A."
function joinInitials(words) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) out.push(`${run.join('.')}.`);
    else out.push(...run);
    run = [];
  };
  for (const word of words) {
    if (/^\p{L}$/u.test(word)) run.push(word);
    else {
      flush();
      out.push(word);
    }
  }
  flush();
  return out;
}

export function parseName(raw) {
  const base = String(raw ?? '').replace(VIDEO_EXT, '').trim();
  const tokens = base.split(/[._\s]+/).filter(Boolean);
  const words = [];
  let year = null;
  let season = null;
  let episode = null;
  let stoppedAt = -1; // Index des ersten technischen Worts
  for (const [index, token] of tokens.entries()) {
    const se = SEASON_EPISODE.exec(token);
    if (se) {
      season = Number(se[1]);
      episode = se[2] ? Number(se[2]) : null;
      break;
    }
    if (year !== null) break; // nach dem Jahr zählt nur noch eine Staffel- oder Folgenangabe
    if (YEAR.test(token) && words.length > 0) {
      year = Number(token);
      continue;
    }
    if (stoppedAt >= 0) {
      if (index - stoppedAt > 2) break; // "UNRATED.2015": das Jahr darf kurz nach Zusatzwörtern stehen
      continue;
    }
    if (words.length > 0 && RELEASE_WORD.test(token)) {
      stoppedAt = index;
      continue;
    }
    words.push(token);
  }
  const name = tidyCase(joinInitials(words).join(' ').trim()) || tidyCase(base);
  return { name, year, season, episode, title: year ? `${name} (${year})` : name };
}

// entries: [{ id, rootIndex, rootLabel, parts: ['Ordner', ..., 'datei.mp4'], size, duration (Sekunden), width, height, thumb, modified }]
// Ergebnis: Videos mit Titel und Regal. Ein Ordner mit mehreren Videos wird ein eigenes Regal (Serie, Urlaub),
// ein Ordner mit nur einem Video ist ein Film: Dann ist der Ordnername meist der bessere Titel.
export function buildLibrary(entries) {
  const counts = new Map(); // "Wurzel|Ordner/Unterordner" -> Zahl der Videos darunter
  for (const entry of entries) {
    const dirs = entry.parts.slice(0, -1);
    for (let i = 1; i <= dirs.length; i += 1) {
      const key = `${entry.rootIndex}|${dirs.slice(0, i).join('/')}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const countOf = (entry, depth) => counts.get(`${entry.rootIndex}|${entry.parts.slice(0, depth).join('/')}`) ?? 0;

  const items = entries.map((entry) => {
    const dirs = entry.parts.slice(0, -1);
    const file = parseName(entry.parts.at(-1));

    // Regal: der innerste Ordner, unter dem mehr als ein Video liegt
    let collection = entry.rootLabel;
    let collectionDepth = 0;
    for (let depth = dirs.length; depth >= 1; depth -= 1) {
      if (countOf(entry, depth) >= 2) {
        const folder = parseName(dirs[depth - 1]);
        collection = folder.season && !folder.episode ? `${folder.title}, Staffel ${folder.season}` : folder.title;
        collectionDepth = depth;
        break;
      }
    }

    // Titel: Folge einer Serie, sonst Datei- oder Ordnername. Filmordner sind meist sauber geschrieben
    // ("Till.Death...2021"), die Datei darin oft klein oder ein Kürzel ("elc-spitgrave3"). Es gewinnt der Name
    // mit Jahreszahl und mehreren Wörtern, bei Gleichstand der Ordner.
    let title = file.title;
    let episode = file.episode;
    if (file.episode === null && dirs.length > collectionDepth) {
      const folder = parseName(dirs.at(-1));
      const score = (p) => (p.year ? 2 : 0) + (/\s/.test(p.name) ? 1 : 0);
      if (folder.episode !== null) episode = folder.episode;
      else if (score(folder) >= score(file)) title = folder.title;
    }
    if (episode !== null) title = `Folge ${episode}`;

    return {
      id: entry.id,
      driveId: entry.driveId ?? null,
      title,
      collection,
      episode,
      rootIndex: entry.rootIndex,
      size: entry.size ?? 0,
      duration: entry.duration ?? null,
      width: entry.width ?? null,
      height: entry.height ?? null,
      thumb: entry.thumb ?? null,
      modified: entry.modified ?? null,
      ext: 'MP4',
    };
  });

  // Reihenfolge: je Wurzel zuerst das Hauptregal ("Filme"), dann die Unterregale alphabetisch, Folgen nach Nummer.
  const rootLabels = new Map(entries.map((e) => [e.rootIndex, e.rootLabel]));
  const isRootShelf = (item) => item.collection === rootLabels.get(item.rootIndex);
  const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
  items.sort(
    (a, b) =>
      a.rootIndex - b.rootIndex ||
      Number(isRootShelf(b)) - Number(isRootShelf(a)) ||
      collator.compare(a.collection, b.collection) ||
      (a.episode ?? 0) - (b.episode ?? 0) ||
      collator.compare(a.title, b.title),
  );
  return items;
}
