'use strict';

const zlib = require('zlib');

function readBody(req, limit = 1e5) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (res.gzipOK && body.length > 1024) {
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
    res.writeHead(status, headers);
    return res.end(zlib.gzipSync(body));
  }
  res.writeHead(status, headers);
  return res.end(body);
}

function sendMarketJSON(res, entry, spec, marketMeta) {
  return sendJSON(res, 200, { data: entry.data, meta: marketMeta(entry, spec) });
}

function sseSend(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

module.exports = { readBody, sendJSON, sendMarketJSON, sseSend };
