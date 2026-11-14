// Anmeldung bei Microsoft (persönliches Konto) direkt im Browser, ohne eigenen Server.
// Ablauf "Authorization Code mit PKCE": Die App schickt zu login.microsoftonline.com, bekommt einen Code zurück
// und tauscht ihn gegen Zugangsschlüssel. Kein Passwort berührt diese App.
// Gelesen wird nur (Files.Read). Microsoft lässt Browser-Apps höchstens etwa 24 Stunden angemeldet,
// danach genügt ein Tippen auf "Anmelden" (meist ohne Passwort, solange Microsoft dich im Browser kennt).
import { CONFIG } from './config.js?v=f63500235f';

const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPES = 'openid profile offline_access User.Read Files.Read';
const TOKENS = 'heimkino-handy:v1:tokens';
const PENDING = 'heimkino-handy:v1:pending-login';

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

function load() {
  try {
    const data = JSON.parse(window.localStorage.getItem(TOKENS) ?? 'null');
    return data && typeof data.access === 'string' ? data : null;
  } catch {
    return null;
  }
}

function save(tokens) {
  try {
    window.localStorage.setItem(TOKENS, JSON.stringify(tokens));
  } catch {
    // Speicher gesperrt: Dann gilt die Anmeldung nur, bis die Seite neu lädt.
  }
  memory = tokens;
}

let memory = null;

export function isConfigured() {
  return Boolean(CONFIG.clientId);
}

export function hasSession() {
  return Boolean(memory ?? load());
}

export function logout() {
  memory = null;
  try {
    window.localStorage.removeItem(TOKENS);
  } catch {
    // nichts zu tun
  }
}

export async function login() {
  const verifier = randomText(48);
  const state = randomText(16);
  try {
    window.sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state, hash: window.location.hash }));
  } catch {
    throw new AuthError('Dieser Browser erlaubt keinen Speicher (privates Fenster?). Die Anmeldung braucht ihn kurz.');
  }
  const params = new URLSearchParams({
    client_id: CONFIG.clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  window.location.assign(`${AUTHORITY}/authorize?${params}`);
}

async function tokenRequest(fields) {
  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CONFIG.clientId, scope: SCOPES, ...fields }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new AuthError(data.error_description?.split('\r\n')[0] || `Microsoft hat die Anmeldung abgelehnt (${res.status}).`, data.error);
  }
  return {
    access: data.access_token,
    refresh: data.refresh_token ?? null,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in ?? 3600) - 120) * 1000,
  };
}

// Nach der Rückkehr von Microsoft steht ?code=... in der Adresse. Gibt true zurück, wenn eine Anmeldung abgeschlossen wurde.
export async function completeLogin() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('code') && !params.has('error')) return false;
  let pending = null;
  try {
    pending = JSON.parse(window.sessionStorage.getItem(PENDING) ?? 'null');
    window.sessionStorage.removeItem(PENDING);
  } catch {
    pending = null;
  }
  window.history.replaceState(null, '', `${window.location.pathname}${pending?.hash ?? ''}`);
  if (params.has('error')) {
    const text = params.get('error_description') || params.get('error');
    throw new AuthError(params.get('error') === 'access_denied' ? 'Die Anmeldung wurde abgebrochen.' : text, params.get('error'));
  }
  if (!pending || pending.state !== params.get('state')) {
    throw new AuthError('Diese Anmeldung gehört nicht zu diesem Fenster. Bitte noch einmal anmelden.');
  }
  save(await tokenRequest({ grant_type: 'authorization_code', code: params.get('code'), code_verifier: pending.verifier, redirect_uri: redirectUri() }));
  return true;
}

// Gültiger Zugangsschlüssel oder null (dann muss neu angemeldet werden).
export async function accessToken({ forceRefresh = false } = {}) {
  const tokens = memory ?? load();
  if (!tokens) return null;
  if (!forceRefresh && tokens.expiresAt > Date.now()) return tokens.access;
  if (!tokens.refresh) return null;
  try {
    const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh });
    save({ ...fresh, refresh: fresh.refresh ?? tokens.refresh });
    return fresh.access;
  } catch (err) {
    if (err instanceof AuthError) {
      logout();
      return null;
    }
    throw err; // kein Netz: Anmeldung behalten
  }
}
