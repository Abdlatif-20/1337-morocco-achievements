# 1337 Morocco Students

Web app to browse students across all 4 Moroccan 42-network campuses (branded "1337"):
Khouribga, Benguerir, Tétouan, and Rabat.

Uses the real 42 API v2 `GET /v2/campus/:id/users` endpoint (verified live — returns paginated
student lists with a real `x-total` count header). There is no full-text/substring search
across a campus's students via the API, so search is an exact-login lookup
(`filter[login]=...`), same limitation the official intra has.

## Structure

- `server/` — small Express API that holds the 42 OAuth client credentials (never sent to the
  browser) and proxies requests to the 42 API.
- `client/` — Vite + React frontend.

## Setup

```bash
npm install && npm run install:all   # root deps, then server/ and client/ deps
cp server/.env.example server/.env
# fill in FT_CLIENT_ID / FT_CLIENT_SECRET from https://profile.intra.42.fr/oauth/applications
npm run dev         # runs server (port 4000) + client (port 5174) together
```

Open http://localhost:5174.
