# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A web app (prod: 42-hub.tech) for browsing students of the four Moroccan 42-network ("1337") campuses — Khouribga (16), Benguerir (21), Tétouan (55), Rabat (75) — centered on who holds the "Je voudrais un croissant" achievement (i.e. visited Paris), plus students who moved their primary campus to Paris. All data comes live from the 42 API v2; there is no database.

## Commands

```bash
npm install && npm run install:all   # root deps + server/ and client/ deps (three separate package.json files)
cp server/.env.example server/.env   # FT_CLIENT_ID, FT_CLIENT_SECRET, SESSION_SECRET, PORT
npm run dev                          # Express on :4000 + Vite on :5174 (proxies /api → :4000)
npm run build                        # vite build → client/dist
```

There are no tests or linter configured.

For local OAuth login, set `APP_ORIGIN=http://localhost:5174` in `server/.env` — Vite's proxy rewrites the Host header, so the redirect URI can't be derived from the request. The 42 OAuth app must list that callback (`/api/auth/callback`).

## Architecture

**One Express app, two runtimes.** `server/index.js` defines the entire backend as a single Express app (all routes in one file). It calls `app.listen()` only when `VERCEL !== '1'`; otherwise it's exported. On Vercel, each file under `api/` is a 3-line wrapper that forwards to that same app — one file per real route path, because a `[...path].js` catch-all 404'd on multi-segment paths. **Adding a new backend route requires both the `app.get(...)` in `server/index.js` and a matching wrapper file under `api/`.** `vercel.json` builds only the client and serves `client/dist`.

**Every 42 API call runs as the visitor.** Users log in via 42 OAuth (authorization_code). The session (access/refresh tokens, expiry, user) lives entirely in a signed, httpOnly cookie (`server/session.js`, HMAC with `SESSION_SECRET`) since serverless instances share no memory. `requireAuth` refreshes expiring tokens and runs the handler inside an `AsyncLocalStorage` context (`requestContext`) so `apiGet` picks up the visitor's token without threading it through every helper. An app-level client_credentials token (`appTokenCache`) still exists for specific cases.

**Rate limiting is the central constraint.** 42 allows ~2 req/s. All outgoing calls go through `throttle()` — a global dispatcher at `MIN_INTERVAL_MS = 550` with two lanes: `high` (user-facing page fetches) and `low` (background full scans like exact totals and Paris-adders roster scans). High always cuts ahead of queued low. `apiGet` retries once on transient errors but fails fast if `Retry-After` exceeds 10s. Any new 42 API call must go through `apiGet`/`throttle` with an appropriate priority.

**Caching is layered and TTLs are kept in sync.** Server-side in-memory `Map` caches (1-hour TTL): achievement holders per `achievementId:campus`, this-year achievers per achievement, Paris-adders per campus, Paris-switchers per achievement. Several caches hold *incremental scan progress* (upstream page reached, exhausted flag) so a deeper page request resumes instead of restarting. `?refresh=1` bypasses them. The client mirrors these in `localStorage` via `client/src/browserCache.js` with matching TTLs, and limits the Refresh button to 3 uses/hour per visitor. In local dev, Paris-adders for Tétouan is prewarmed at boot; on Vercel the first request pays the cost.

**Domain quirks encoded in the logic:**
- Tétouan and Rabat have no croissant-achievement holders (`NO_ACHIEVEMENT_CAMPUS_IDS`, duplicated in both `server/index.js` and `client/src/App.jsx` — keep in sync). For those campuses the substitute signal is "Paris-adders": students with Paris (campus 1) on their profile, found by scanning the campus roster. Rabat's list is hardcoded empty and never scanned.
- 42's holders endpoint filters by *current* primary campus, so students who switched to Paris disappear from their Moroccan campus list. "Paris-switchers" recovers them from this year's achievers (`PARIS_SWITCH_SINCE` = Aug 1 of the current year) and tags each with their original Moroccan `campusId`.
- When multiple `campus_users` rows are `is_primary`, the most recently updated one wins.
- Single-campus views are paginated server-side (only enough upstream pages fetched to cover the requested page); the "All Morocco" grouped view is unpaginated.
- Requests on old domains (`DEPRECATED_HOSTS`) get a 410 "domain moved" page.

**Client** is a Vite + React 18 SPA with almost all UI state and logic in `client/src/App.jsx`; `client/src/api.js` is the thin fetch layer documenting each endpoint's query params.
