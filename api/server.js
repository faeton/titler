// titler api — phase 1
// Minimal, zero-dependency HTTP server.
// Runs behind Caddy on 127.0.0.1:7000.
//
// Endpoints:
//   GET  /health      → 200 (public)
//   GET  /version     → 200 (public)
//   POST /v1/transcribe → 501 stub, auth required
//   POST /v1/render     → 501 stub, auth required
//   GET  /v1/job/:id    → 501 stub, auth required
//   *                   → 404

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = parseInt(process.env.TITLER_PORT || '7000', 10);
const HOST = process.env.TITLER_HOST || '127.0.0.1';
const TOKEN = process.env.TITLER_BEARER_TOKEN || '';
const VERSION = '0.1.0';
const MAX_BODY = 100 * 1024 * 1024; // 100 MB

if (!TOKEN) {
  console.error('FATAL: TITLER_BEARER_TOKEN is not set');
  process.exit(1);
}

function jsonResponse(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function err(res, code, errCode, message) {
  jsonResponse(res, code, { error: { code: errCode, message } });
}

function constantTimeEq(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireAuth(req, res) {
  const h = req.headers['authorization'];
  if (!h || typeof h !== 'string' || !h.startsWith('Bearer ')) {
    err(res, 401, 'unauthorized', 'missing bearer token');
    return false;
  }
  const got = h.slice(7).trim();
  if (!constantTimeEq(got, TOKEN)) {
    err(res, 401, 'unauthorized', 'invalid bearer token');
    return false;
  }
  return true;
}

function logLine(req, res, code, startedAt) {
  const ms = Date.now() - startedAt;
  const ip =
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress ||
    '-';
  // single-line structured-ish log
  console.log(
    JSON.stringify({
      t: new Date().toISOString(),
      ip: String(ip).split(',')[0].trim(),
      method: req.method,
      path: req.url,
      status: code,
      ms,
      ua: req.headers['user-agent'] || '-',
    })
  );
}

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  // Wrap the default end so we log exactly once with the final status.
  const origWriteHead = res.writeHead.bind(res);
  let statusCode = 200;
  res.writeHead = function (code, ...rest) {
    statusCode = code;
    return origWriteHead(code, ...rest);
  };
  res.on('finish', () => logLine(req, res, statusCode, startedAt));

  // Parse URL safely
  let parsed;
  try {
    parsed = new URL(req.url, 'http://localhost');
  } catch {
    return err(res, 400, 'bad_request', 'malformed request URI');
  }
  const path = parsed.pathname;
  const method = req.method || 'GET';

  // Method-agnostic routes
  if (path === '/health') {
    if (method !== 'GET' && method !== 'HEAD') {
      return err(res, 405, 'method_not_allowed', 'use GET');
    }
    return jsonResponse(res, 200, { ok: true });
  }

  if (path === '/version') {
    if (method !== 'GET') return err(res, 405, 'method_not_allowed', 'use GET');
    return jsonResponse(res, 200, { name: 'titler-api', version: VERSION });
  }

  // Auth-gated routes
  if (path === '/v1/transcribe') {
    if (method !== 'POST') return err(res, 405, 'method_not_allowed', 'use POST');
    if (!requireAuth(req, res)) return;
    return err(res, 501, 'not_implemented', 'transcribe stub');
  }

  if (path === '/v1/render') {
    if (method !== 'POST') return err(res, 405, 'method_not_allowed', 'use POST');
    if (!requireAuth(req, res)) return;
    return err(res, 501, 'not_implemented', 'render stub');
  }

  if (path.startsWith('/v1/job/')) {
    if (method !== 'GET') return err(res, 405, 'method_not_allowed', 'use GET');
    if (!requireAuth(req, res)) return;
    return err(res, 501, 'not_implemented', 'job status stub');
  }

  // Everything else
  return err(res, 404, 'not_found', 'no such route');
});

// Limit header size and request timeout
server.headersTimeout = 10_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;

// Reject oversized bodies early at the socket level
server.on('connection', (socket) => {
  let received = 0;
  socket.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_BODY + 64 * 1024) {
      socket.destroy();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify({
      t: new Date().toISOString(),
      event: 'listening',
      host: HOST,
      port: PORT,
      version: VERSION,
    })
  );
});

// Graceful shutdown
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(JSON.stringify({ t: new Date().toISOString(), event: 'shutdown', sig }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
