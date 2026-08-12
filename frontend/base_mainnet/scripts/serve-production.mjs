import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distRoot = resolve(serviceRoot, 'dist');
const port = Number(process.env.PORT || 10_000);

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

const commonHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(self)',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
};

const safePath = (pathname) => {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const target = resolve(distRoot, `.${decoded}`);
  return target === distRoot || target.startsWith(`${distRoot}${sep}`)
    ? target
    : null;
};

const existingFile = async (path) => {
  try {
    const details = await stat(path);
    return details.isFile() ? details : null;
  } catch {
    return null;
  }
};

const server = createServer(async (request, response) => {
  const method = request.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, {
      ...commonHeaders,
      Allow: 'GET, HEAD',
      'Cache-Control': 'no-store',
    });
    response.end();
    return;
  }

  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    const body = JSON.stringify({ success: true, service: 'kletia-frontend' });
    response.writeHead(200, {
      ...commonHeaders,
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(method === 'HEAD' ? undefined : body);
    return;
  }

  const requestedPath = safePath(url.pathname === '/' ? '/index.html' : url.pathname);
  if (!requestedPath) {
    response.writeHead(400, { ...commonHeaders, 'Cache-Control': 'no-store' });
    response.end('Bad request');
    return;
  }

  let path = requestedPath;
  let details = await existingFile(path);
  if (!details) {
    const acceptsHtml = (request.headers.accept || '').includes('text/html');
    if (!acceptsHtml && extname(url.pathname)) {
      response.writeHead(404, { ...commonHeaders, 'Cache-Control': 'no-store' });
      response.end('Not found');
      return;
    }
    path = resolve(distRoot, 'index.html');
    details = await existingFile(path);
  }

  if (!details) {
    response.writeHead(503, { ...commonHeaders, 'Cache-Control': 'no-store' });
    response.end('Frontend build is unavailable');
    return;
  }

  const extension = extname(path).toLowerCase();
  const immutableAsset = path.startsWith(`${resolve(distRoot, 'assets')}${sep}`);
  response.writeHead(200, {
    ...commonHeaders,
    'Cache-Control': immutableAsset
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    'Content-Length': details.size,
    'Content-Type': contentTypes.get(extension) || 'application/octet-stream',
  });
  if (method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(path).on('error', () => response.destroy()).pipe(response);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Kletia unified frontend listening on 0.0.0.0:${port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
