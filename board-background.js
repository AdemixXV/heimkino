import { accessToken, sessionVersion } from './auth.js?v=5ad2108893';

// Executed in a real first-party WebView, so SPA refresh uses the supported browser/CORS flow.
// Native code receives only the short-lived access token; refresh tokens stay in web storage.
window.heimkinoBackgroundRefresh = async (expectedSession) => {
  if (sessionVersion() !== expectedSession) return null;
  const access = await accessToken({ forceRefresh: true });
  if (!access || sessionVersion() !== expectedSession) return null;
  const tokens = JSON.parse(window.localStorage.getItem('heimkino-handy:v1:tokens') ?? 'null');
  if (!tokens || tokens.session !== expectedSession || tokens.access !== access) return null;
  return { session: expectedSession, access, expiresAt: tokens.expiresAt };
};
