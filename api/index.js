'use strict';
// Vercel entry point. vercel.json rewrites every /api/<path> request here as
// /api/index?__path=<path>; the original URL is rebuilt before the request reaches the
// server, so it routes exactly as it does locally. web/ is served as static files.
// Each server instance keeps its own in-memory database seeded with the demo data, so the
// hosted demo starts fresh whenever Vercel starts a new instance and changes do not last.
const { open, seed } = require('../server/db');
const { createApp } = require('../server/server');

let handle = null;

function originalUrl(url) {
  const u = new URL(url, 'http://localhost');
  const rest = u.searchParams.get('__path');
  if (rest === null) return url;
  u.searchParams.delete('__path');
  const qs = u.searchParams.toString();
  return `/api/${rest}${qs ? `?${qs}` : ''}`;
}

module.exports = (req, res) => {
  if (!handle) {
    const db = open(':memory:');
    seed(db);
    handle = createApp(db).handle;
  }
  req.url = originalUrl(req.url);
  return handle(req, res);
};
module.exports.originalUrl = originalUrl;
