import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createStore } from './store.mjs';

const derive = promisify(scrypt);
const SESSION_MS = 4 * 60 * 60 * 1000;
const LIMIT_WINDOW = 15 * 60 * 1000;
const COOKIE = 'mutaeva_session';
const publicFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/admin', ['admin/index.html', 'text/html']],
  ['/admin/', ['admin/index.html', 'text/html']],
  ['/admin/index.html', ['admin/index.html', 'text/html']],
  ['/assets/site.css', ['assets/site.css', 'text/css']],
  ['/assets/site.js', ['assets/site.js', 'text/javascript']],
  ['/assets/admin.css', ['assets/admin.css', 'text/css']],
  ['/assets/admin.js', ['assets/admin.js', 'text/javascript']],
  ['/assets/portrait.jpg', ['assets/portrait.jpg', 'image/jpeg']],
  ['/config.js', ['config.js', 'text/javascript']]
]);

export async function createApp(options) {
  const { root, directory, username, passwordHash, adminOrigin, publicOrigin, insecure = false } = options;
  if (!username || !/^[\w.@-]{3,80}$/.test(username)) throw new Error('ADMIN_USERNAME required');
  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash || '')) throw new Error('ADMIN_PASSWORD_HASH required');
  for (const origin of [adminOrigin, publicOrigin]) {
    const url = new URL(origin);
    if (url.origin !== origin || (!insecure && url.protocol !== 'https:')) throw new Error('Invalid origin');
  }
  const [salt, hash] = passwordHash.split(':');
  const expected = Buffer.from(hash, 'hex');
  const seed = JSON.parse(await readFile(join(root, 'data/seed.json'), 'utf8'));
  const store = await createStore(directory, seed);
  const sessions = new Map();
  const attempts = new Map();
  let activeLoginRequests = 0;

  function sessionFor(request) {
    const token = request.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const session = sessions.get(token);
    if (!session || session.expires <= Date.now()) { sessions.delete(token); return null; }
    return { ...session, token };
  }
  function cookie(token, clear = false) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${insecure ? '' : '; Secure'}`;
  }
  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }
  async function body(request) {
    if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('invalid_body');
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 65536) throw new Error('invalid_body');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('invalid_body'); }
  }

  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (!insecure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const path = new URL(request.url, adminOrigin).pathname;
    const origin = request.headers.origin;
    if (path === '/api/prices' && request.method === 'GET') {
      if (origin === publicOrigin) {
        response.setHeader('Access-Control-Allow-Origin', publicOrigin);
        response.setHeader('Vary', 'Origin');
      }
      return json(response, 200, store.read());
    }
    if (['POST', 'PUT', 'DELETE'].includes(request.method) && origin !== adminOrigin) {
      return json(response, 403, { error: 'origin_denied' });
    }
    try {
      if (path === '/api/login' && request.method === 'POST') {
        const now = Date.now();
        for (const [key, value] of attempts) if (value.reset <= now) attempts.delete(key);
        for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
        const address = request.socket.remoteAddress;
        const attempt = attempts.get(address) || { count: 0, reset: now + LIMIT_WINDOW };
        if (attempt.count >= 10 || attempts.size >= 10000 || activeLoginRequests >= 4) {
          response.setHeader('Retry-After', '900');
          return json(response, 429, { error: 'too_many_attempts' });
        }
        attempts.set(address, { ...attempt, count: attempt.count + 1 });
        const input = await body(request);
        if (typeof input.username !== 'string' || typeof input.password !== 'string' || input.password.length > 256) {
          return json(response, 400, { error: 'invalid_body' });
        }
        activeLoginRequests++;
        let actual;
        try { actual = await derive(input.password, salt, 64); }
        finally { activeLoginRequests--; }
        if (!timingSafeEqual(actual, expected) || input.username !== username) {
          return json(response, 401, { error: 'invalid_credentials' });
        }
        if (sessions.size >= 100) return json(response, 429, { error: 'too_many_attempts' });
        const token = randomBytes(32).toString('hex');
        const csrf = randomBytes(32).toString('hex');
        sessions.set(token, { csrf, expires: Date.now() + SESSION_MS });
        response.setHeader('Set-Cookie', cookie(token));
        return json(response, 200, { csrf });
      }
      if (path === '/api/session' && request.method === 'GET') {
        const session = sessionFor(request);
        return session ? json(response, 200, { csrf: session.csrf }) : json(response, 401, { error: 'login_required' });
      }
      if ((path === '/api/prices' && request.method === 'PUT') || (path === '/api/logout' && request.method === 'POST')) {
        const session = sessionFor(request);
        if (!session) return json(response, 401, { error: 'login_required' });
        if (request.headers['x-csrf-token'] !== session.csrf) return json(response, 403, { error: 'csrf_denied' });
        if (path === '/api/logout') {
          sessions.delete(session.token);
          response.setHeader('Set-Cookie', cookie('', true));
          return json(response, 200, { ok: true });
        }
        const input = await body(request);
        if (!Number.isInteger(input.revision)) return json(response, 400, { error: 'invalid_prices' });
        const saved = await store.save(input.revision, input.prices);
        return saved ? json(response, 200, saved) : json(response, 409, { error: 'conflict' });
      }
      if (request.method === 'GET' && publicFiles.has(path)) {
        const [file, type] = publicFiles.get(path);
        const content = await readFile(join(root, file));
        if (path.startsWith('/admin')) {
          response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        }
        response.writeHead(200, { 'Content-Type': `${type}${type.startsWith('text/') ? '; charset=utf-8' : ''}` });
        return response.end(content);
      }
      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      if (['invalid_body', 'invalid_prices'].includes(error.message)) return json(response, 400, { error: error.message });
      // Never log request bodies, passwords, cookies or environment values.
      console.error('Request failed:', error.code || 'internal_error');
      return json(response, 500, { error: 'server_error' });
    }
  });
}
