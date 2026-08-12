// Signed, stateless session cookie — necessary because Vercel serverless functions don't
// share in-memory state across invocations/instances, so a visitor's OAuth tokens can't be
// cached server-side like the app-level client_credentials token was. The whole session
// (access token, refresh token, expiry, and the visitor's own profile bits for the avatar)
// lives in one httpOnly cookie, signed with SESSION_SECRET so it can't be forged or edited.
import crypto from 'node:crypto';
import { serialize, parse } from 'cookie';

const COOKIE_NAME = 'sc_session';
const STATE_COOKIE_NAME = 'sc_oauth_state';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days — bounded by the refresh token's own life

const getSecret = () => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) { throw new Error('MISSING_SESSION_SECRET: set SESSION_SECRET in the environment'); }
  return secret;
};

const sign = (value) => crypto.createHmac('sha256', getSecret()).update(value).digest('hex');

const encodeSession = (payload) => {
  const json = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${json}.${sign(json)}`;
};

const decodeSession = (raw) => {
  if (!raw) { return null; }
  const [json, signature] = raw.split('.');
  if (!json || !signature) { return null; }
  const expected = sign(json);
  // Constant-time compare to avoid a timing side-channel on the signature check.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { return null; }
  try {
    return JSON.parse(Buffer.from(json, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

export const getSession = (req) => {
  const cookies = parse(req.headers.cookie || '');
  return decodeSession(cookies[COOKIE_NAME]);
};

export const setSessionCookie = (res, session) => {
  const cookie = serialize(COOKIE_NAME, encodeSession(session), {
    httpOnly: true,
    secure: process.env.VERCEL === '1',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  // res.append (not setHeader) — a single response may need to set more than one cookie
  // (e.g. clear the OAuth state cookie AND set the session cookie on callback); setHeader
  // would silently overwrite the first with the second.
  res.append('Set-Cookie', cookie);
};

export const clearSessionCookie = (res) => {
  const cookie = serialize(COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.VERCEL === '1',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  // res.append (not setHeader) — a single response may need to set more than one cookie
  // (e.g. clear the OAuth state cookie AND set the session cookie on callback); setHeader
  // would silently overwrite the first with the second.
  res.append('Set-Cookie', cookie);
};

// A short-lived, separate cookie holding the OAuth `state` value, checked on callback to
// guard against CSRF on the login flow. Not signed (nothing sensitive in it), just needs to
// round-trip unmodified.
export const setOAuthStateCookie = (res, state) => {
  const cookie = serialize(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: process.env.VERCEL === '1',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
  // res.append (not setHeader) — a single response may need to set more than one cookie
  // (e.g. clear the OAuth state cookie AND set the session cookie on callback); setHeader
  // would silently overwrite the first with the second.
  res.append('Set-Cookie', cookie);
};

export const getOAuthStateCookie = (req) => parse(req.headers.cookie || '')[STATE_COOKIE_NAME] || null;

export const clearOAuthStateCookie = (res) => {
  const cookie = serialize(STATE_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.VERCEL === '1',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  // res.append (not setHeader) — a single response may need to set more than one cookie
  // (e.g. clear the OAuth state cookie AND set the session cookie on callback); setHeader
  // would silently overwrite the first with the second.
  res.append('Set-Cookie', cookie);
};
