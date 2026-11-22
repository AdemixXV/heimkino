// Anmeldung bei Microsoft (persönliches Konto) direkt im Browser, ohne eigenen Server.
// Ablauf "Authorization Code mit PKCE": Die App schickt zu login.microsoftonline.com, bekommt einen Code zurück
// und tauscht ihn gegen Zugangsschlüssel. Kein Passwort berührt diese App.
// Gelesen wird nur (Files.Read). Microsoft lässt Browser-Apps höchstens etwa 24 Stunden angemeldet.
// Danach erneuert die App die Anmeldung still (prompt=none): Kennt Microsoft dich im Browser noch, kommt sie ohne
// Tippen zurück. Nur wenn nicht, erscheint der "Anmelden"-Knopf. Wer sich selbst abmeldet, wird nicht still angemeldet.
import { CONFIG } from './config.js?v=1c4067d8b2';

const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPES = 'offline_access User.Read Files.Read';
const WRITE_SCOPES = `${SCOPES} Files.ReadWrite`;
const TOKENS = 'heimkino-handy:v1:tokens';
const PENDING = 'heimkino-handy:v1:pending-login';
const SIGNED_IN = 'heimkino-handy:v1:signed-in'; // "1": war angemeldet und hat sich nicht selbst abgemeldet
const SILENT_AT = 'heimkino-handy:v1:silent-at'; // wann zuletzt still versucht wurde, damit es nie eine Schleife gibt
const SILENT_PAUSE_MS = 10 * 60 * 1000;

export class AuthError extends Error {
  constructor(message, code = '') {
    super(message);
    this.code = code;
  }
}

// Muss genau einer Umleitungs-URI in der App-Registrierung entsprechen: "…/index.html" zählt wie "…/".
const redirectUri = () => `${window.location.origin}${window.location.pathname.replace(/index\.html$/, '')}`;

function randomText(bytes) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(data);
}

function base64url(bytes) {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function readKey(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    // Speicher gesperrt: dann gilt die Anmeldung nur, bis die Seite neu lädt
    return false;
  }
}

function markSignedIn() {
  if (readKey(SIGNED_IN) !== '1') writeKey(SIGNED_IN, '1');
}

function load() {
  try {
    const data = JSON.parse(window.localStorage.getItem(TOKENS) ?? 'null');
    if (data && typeof data.access === 'string') {
      markSignedIn(); // auch wer schon vor dieser Funktion angemeldet war, wird künftig still erneuert
      return data;
    }
  } catch {
    // kaputter Eintrag: wie nicht angemeldet
  }
  return null;
}

function save(tokens) {
  tokens = { ...tokens, session: tokens.session ?? randomText(16) };
  memoryOnly = !writeKey(TOKENS, JSON.stringify(tokens));
  markSignedIn();
  memory = tokens;
  notifyNative();
}

function notifyNative() {
  if (typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event('heimkino-auth-changed'));
}

export function canWriteBoard() {
  return /(^|\s)(https:\/\/graph\.microsoft\.com\/)?Files\.ReadWrite(\s|$)/i.test(currentTokens()?.scope ?? '');
}

let memory = null;
let memoryOnly = false;
let requestController = null;
let requestSession = null;

function currentTokens() {
  return memoryOnly ? memory : load();
}

function identity(tokens) {
  return tokens?.session ?? tokens?.refresh ?? tokens?.access ?? null;
}

export function sessionVersion() {
  return identity(currentTokens());
}

export function sessionSignal() {
  const session = sessionVersion();
  if (!requestController || requestSession !== session) {
    requestController?.abort();
    requestController = new AbortController();
    requestSession = session;
  }
  return requestController.signal;
}

// storage wird nur in den anderen Fenstern ausgelöst, nicht im auslösenden Tab.
export function onSessionChange(listener) {
  const parse = (value) => { try { return JSON.parse(value); } catch { return null; } };
  const changed = (event) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== TOKENS && event.key !== null) return;
    const previous = event.key === null ? requestSession ?? identity(memory) : identity(parse(event.oldValue));
    memory = null;
    memoryOnly = false;
    const next = sessionVersion();
    if (previous === next) return; // normale Token-Erneuerung gehört weiter zum selben Konto
    requestController?.abort();
    requestController = null;
    notifyNative();
    listener();
  };
  window.addEventListener('storage', changed);
  return () => window.removeEventListener('storage', changed);
}

export function isConfigured() {
  return Boolean(CONFIG.clientId);
}

export function hasSession() {
  return Boolean(currentTokens());
}

// Schlüssel vergessen, aber merken, dass jemand angemeldet war (für die stille Erneuerung)
function forget() {
  requestController?.abort();
  requestController = null;
  memory = null;
  memoryOnly = false;
  writeKey(TOKENS, null);
  notifyNative();
}

// Der Nutzer meldet sich selbst ab: Dann wird nicht mehr still angemeldet.
export function logout() {
  forget();
  writeKey(SIGNED_IN, null);
  writeKey(SILENT_AT, null);
}

// Darf jetzt still erneuert werden? Nur wenn jemand angemeldet war und der letzte stille Versuch lange genug her ist.
export function silentAllowed({ signedIn, lastTry, now = Date.now() }) {
  if (!signedIn) return false;
  const age = now - Number(lastTry || 0);
  return !(age >= 0 && age < SILENT_PAUSE_MS);
}

export function canSilentLogin(now = Date.now()) {
  return isConfigured() && silentAllowed({ signedIn: readKey(SIGNED_IN) === '1', lastTry: readKey(SILENT_AT), now });
}

// silent: Microsoft darf nichts anzeigen (prompt=none). Es kommt entweder die Anmeldung zurück oder ein Fehler,
// den completeLogin() als "silent-failed" meldet.
export async function login({ silent = false, boardWrite = false } = {}) {
  const scope = boardWrite ? WRITE_SCOPES : SCOPES;
  const verifier = randomText(48);
  const state = randomText(16);
  try {
    window.sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state, hash: window.location.hash, silent, boardWrite }));
  } catch {
    throw new AuthError('Dieser Browser erlaubt keinen Speicher (privates Fenster?). Die Anmeldung braucht ihn kurz.');
  }
  const params = new URLSearchParams({
    client_id: CONFIG.clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: redirectUri(),
    scope,
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
    prompt: silent ? 'none' : 'select_account',
  });
  if (silent) writeKey(SILENT_AT, String(Date.now()));
  window.location.assign(`${AUTHORITY}/authorize?${params}`);
}

async function tokenRequest(fields, signal, scope = SCOPES) {
  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CONFIG.clientId, scope, ...fields }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new AuthError(data.error_description?.split('\r\n')[0] || `Microsoft hat die Anmeldung abgelehnt (${res.status}).`, data.error);
  }
  return {
    access: data.access_token,
    refresh: data.refresh_token ?? null,
    scope: typeof data.scope === 'string' ? data.scope : scope,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in ?? 3600) - 120) * 1000,
  };
}

// Nach der Rückkehr von Microsoft steht ?code=... (oder ?error=...) in der Adresse. Ergebnis:
// 'signed-in' (Anmeldung abgeschlossen), 'silent-failed' (stille Erneuerung ging nicht, kein Fehler für den Nutzer)
// oder 'none' (keine Rückkehr von Microsoft).
export async function completeLogin() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('code') && !params.has('error')) return 'none';
  let pending = null;
  try {
    pending = JSON.parse(window.sessionStorage.getItem(PENDING) ?? 'null');
    window.sessionStorage.removeItem(PENDING);
  } catch {
    pending = null;
  }
  window.history.replaceState(null, '', `${window.location.pathname}${pending?.hash ?? ''}`);
  if (params.has('error')) {
    if (pending?.silent) return 'silent-failed'; // Microsoft kennt dich hier gerade nicht: normaler "Anmelden"-Knopf
    const text = params.get('error_description') || params.get('error');
    throw new AuthError(params.get('error') === 'access_denied' ? 'Die Anmeldung wurde abgebrochen.' : text, params.get('error'));
  }
  if (!pending || pending.state !== params.get('state')) {
    throw new AuthError('Diese Anmeldung gehört nicht zu diesem Fenster. Bitte noch einmal anmelden.');
  }
  const session = sessionVersion();
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code: params.get('code'), code_verifier: pending.verifier, redirect_uri: redirectUri() }, sessionSignal(), pending.boardWrite ? WRITE_SCOPES : SCOPES);
  if (sessionVersion() !== session) throw new AuthError('Die Anmeldung wurde in einem anderen Fenster geändert. Bitte erneut anmelden.');
  save(tokens);
  return 'signed-in';
}

// Gültiger Zugangsschlüssel oder null (dann muss neu angemeldet werden).
export async function accessToken({ forceRefresh = false } = {}) {
  const tokens = currentTokens();
  if (!tokens) return null;
  if (!forceRefresh && tokens.expiresAt > Date.now()) return tokens.access;
  if (!tokens.refresh) return null;
  const session = identity(tokens);
  try {
    const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh }, sessionSignal(), /(^|\s)(https:\/\/graph\.microsoft\.com\/)?Files\.ReadWrite(\s|$)/i.test(tokens.scope ?? '') ? WRITE_SCOPES : SCOPES);
    if (sessionVersion() !== session) return null;
    save({ ...fresh, refresh: fresh.refresh ?? tokens.refresh, session });
    return fresh.access;
  } catch (err) {
    if (sessionVersion() !== session || err.name === 'AbortError') return null;
    if (err instanceof AuthError) {
      forget(); // abgelaufen: Schlüssel weg, aber "war angemeldet" bleibt, damit still erneuert werden kann
      return null;
    }
    throw err; // kein Netz: Anmeldung behalten
  }
}
