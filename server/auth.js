// Client-credentials OAuth against 42's API. Token is cached in memory and refreshed
// automatically before it expires — this is server-side, so the secret never reaches the
// browser (unlike a client-only web app, where it would be visible in the bundle/network tab).
const AUTH_URL = 'https://api.intra.42.fr/oauth/token';
const EXPIRY_BUFFER_MS = 60 * 1000;

let cachedToken = null;
let cachedExpiryAt = 0;
let refreshPromise = null;

const fetchNewToken = async () => {
  const clientId = process.env.FT_CLIENT_ID;
  const clientSecret = process.env.FT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('MISSING_CREDENTIALS: set FT_CLIENT_ID / FT_CLIENT_SECRET in server/.env');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`AUTH_FAILED:${response.status}:${text}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  cachedExpiryAt = Date.now() + (data.expires_in || 7200) * 1000;
  return cachedToken;
};

export const getValidToken = async () => {
  if (cachedToken && Date.now() < cachedExpiryAt - EXPIRY_BUFFER_MS) {
    return cachedToken;
  }
  if (!refreshPromise) {
    refreshPromise = fetchNewToken().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
};
