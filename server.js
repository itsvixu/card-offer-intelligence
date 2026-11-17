#!/usr/bin/env node
// The dashboard server: a small read-only HTTP server over the scan store.
//
//   node server.js                 # http://localhost:4173, reads data/snapshots.sqlite
//   node server.js --demo          # reads data/demo/ (simulated change history)
//   PORT=8080 node server.js
//
// No framework: three JSON routes, the captured screenshots, and the static
// dashboard. It never writes — the scan is the only writer.

import { createServer } from 'node:http';
import { existsSync, readFileSync, createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOverview } from './src/overview.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DEMO = args.includes('--demo');
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const PORT = Number(process.env.PORT || flag('--port', 4173));
const DATA_DIR = resolve(ROOT, flag('--data', DEMO ? 'data/demo' : 'data'));
const DB_PATH = join(DATA_DIR, 'snapshots.sqlite');
const CAPTURES_DIR = join(DATA_DIR, 'captures');
const SOURCES_PATH = resolve(ROOT, flag('--config', 'config/sources.json'));
const DASHBOARD_DIR = join(ROOT, 'dashboard');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function loadSources() {
  try {
    return JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Serve a file from inside `baseDir` only — never follow `..` out of it.
function sendFile(res, baseDir, relPath, cacheControl = 'no-cache') {
  const full = normalize(join(baseDir, relPath));
  if (full !== baseDir && !full.startsWith(baseDir + sep)) return sendJson(res, 403, { error: 'Forbidden' });
  if (!existsSync(full) || !statSync(full).isFile()) return sendJson(res, 404, { error: 'Not found' });
  res.writeHead(200, {
    'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': cacheControl,
  });
  createReadStream(full).pipe(res);
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Read-only' });
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendJson(res, 400, { error: 'Bad request' });
  }

  try {
    if (path === '/api/overview.json' || path === '/api/overview') {
      return sendJson(res, 200, buildOverview({ dbPath: DB_PATH, sources: loadSources(), demo: DEMO, links: { caseStudy: 'case-study.html' } }));
    }
    if (path.startsWith('/docs/')) return sendFile(res, join(ROOT, 'docs'), path.slice('/docs/'.length));
    if (path.startsWith('/captures/')) {
      // Capture files are immutable (timestamped names), so cache them hard.
      return sendFile(res, CAPTURES_DIR, path.slice('/captures/'.length), 'public, max-age=31536000, immutable');
    }
    if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    return sendFile(res, DASHBOARD_DIR, path === '/' ? 'index.html' : path.slice(1));
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Card Offer Intelligence — http://localhost:${PORT}${DEMO ? '  (demo data)' : ''}`);
  console.log(`  store: ${DB_PATH}${existsSync(DB_PATH) ? '' : '  (not found — run `npm run scan` first)'}`);
});
