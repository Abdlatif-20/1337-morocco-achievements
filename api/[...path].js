// Vercel serverless entry — catches every /api/* request and hands it to the exact same
// Express app used for local dev (server/index.js). Filename `[...path].js` is Vercel's
// catch-all convention: any request under /api/ routes here with req.url left untouched, so
// Express's own routes (defined as full paths like '/api/campuses') still match correctly.
import app from '../server/index.js';

export default (req, res) => app(req, res);
