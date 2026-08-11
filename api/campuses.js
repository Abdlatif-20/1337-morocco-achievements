// Vercel serverless entry. Each real API path gets its own explicit function file (instead
// of one catch-all) — a `[...path].js` catch-all was deployed and DID handle single-segment
// paths (/api/x), but every multi-segment path (/api/achievements/holders) hit Vercel's own
// platform 404 before ever reaching this app, verified live. Explicit per-route files avoid
// that ambiguity entirely; every file just forwards to the same Express app, which still does
// its own routing internally based on the real req.url.
import app from '../server/index.js';

export default (req, res) => app(req, res);
