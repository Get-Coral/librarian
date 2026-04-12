import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env files
for (const file of ['.env', '.env.local']) {
  const filePath = path.join(__dirname, file);
  if (!fs.existsSync(filePath)) continue;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sep = trimmed.indexOf('=');
    if (sep === -1) continue;
    const key = trimmed.slice(0, sep).trim();
    let val = trimmed.slice(sep + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    )
      val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

// Import built server entry — exports { default: { fetch } }
const { default: serverEntry } = await import('./dist/server/server.js');

const host = process.env.HOST ?? '0.0.0.0';
const port = Number.parseInt(process.env.PORT ?? '3000', 10);

const CLIENT_DIR = path.join(__dirname, 'dist', 'client');
const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

const sockets = new Set();

function serveStatic(url, res) {
  const filePath = path.join(CLIENT_DIR, url.pathname);
  if (!filePath.startsWith(CLIENT_DIR)) return false;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  const isHashed = /\.[a-f0-9]{8,}\.\w+$/.test(url.pathname);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': isHashed
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600',
    'content-length': stat.size,
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

const nodeServer = http.createServer(async (req, res) => {
  try {
    const origin = `http://${req.headers.host ?? `${host}:${port}`}`;
    const url = new URL(req.url ?? '/', origin);

    if (url.pathname === '/healthz') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (serveStatic(url, res)) return;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      Array.isArray(v)
        ? v.forEach((val) => headers.append(k, val))
        : headers.set(k, v);
    }

    const webReq = new Request(url, {
      method: req.method,
      headers,
      body:
        req.method && !['GET', 'HEAD'].includes(req.method.toUpperCase())
          ? Readable.toWeb(req)
          : undefined,
      duplex: 'half',
    });

    const webRes = await serverEntry.fetch(webReq);

    res.statusCode = webRes.status;
    res.statusMessage = webRes.statusText;
    webRes.headers.forEach((v, k) => res.setHeader(k, v));

    if (!webRes.body) {
      res.end();
      return;
    }
    Readable.fromWeb(webRes.body).pipe(res);
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain');
    res.end('Server error.');
  }
});

nodeServer.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => {
    sockets.delete(socket);
  });
});

nodeServer.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}. Shutting down Coral module server...`);
  nodeServer.close((error) => {
    if (error) {
      console.error(error);
      process.exit(1);
    }
    process.exit(0);
  });
  setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, 5000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => shutdown(signal));
}

nodeServer.listen(port, host, () => {
  console.log(`🪸 Coral module listening on http://${host}:${port}`);
});
