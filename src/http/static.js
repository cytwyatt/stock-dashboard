'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createStaticServer({ publicDir, fsImpl = fs, pathImpl = path, zlibImpl = zlib }) {
  const staticCache = new Map();

  function resolvePath(pathname) {
    let file = pathname === '/' ? '/index.html' : pathname;
    file = pathImpl.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = pathImpl.join(publicDir, file);
    if (!full.startsWith(publicDir) || !fsImpl.existsSync(full) || !fsImpl.statSync(full).isFile()) {
      return null;
    }
    return full;
  }

  function serve(req, res, full) {
    const stat = fsImpl.statSync(full);
    let entry = staticCache.get(full);
    if (!entry || entry.mtime !== stat.mtimeMs) {
      const raw = fsImpl.readFileSync(full);
      entry = { mtime: stat.mtimeMs, raw, gz: zlibImpl.gzipSync(raw) };
      staticCache.set(full, entry);
    }
    const etag = `"${stat.size}-${Math.round(stat.mtimeMs)}"`;
    const headers = {
      'Content-Type': MIME[pathImpl.extname(full)] || 'application/octet-stream',
      'Cache-Control': full.includes(`${pathImpl.sep}vendor${pathImpl.sep}`)
        ? 'public, max-age=604800, immutable'
        : 'no-cache',
      ETag: etag,
      Vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    if (res.gzipOK) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      return res.end(entry.gz);
    }
    res.writeHead(200, headers);
    return res.end(entry.raw);
  }

  return { resolvePath, serve, cache: staticCache };
}

module.exports = { MIME, createStaticServer };
