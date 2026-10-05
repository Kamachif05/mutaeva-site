import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16).toString('hex');
const passwordHash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
const origin = 'http://127.0.0.1:31977';
const publicOrigin = 'https://mutaeva.ru';

async function fixture(t, directory) {
  directory ||= await mkdtemp(join(root, 'work/test-'));
  const app = await createApp({ root, directory, username: 'test-admin', passwordHash, adminOrigin: origin, publicOrigin, insecure: true });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const request = (path, options = {}) => fetch(`${address}${path}`, options);
  const authenticated = async () => {
    const response = await request('/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test-admin', password }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const { csrf } = await response.json();
    return { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
  };
  return { app, request, authenticated, directory };
}

test('public catalog preserves 35 services and prices, CORS allows only the public site', async t => {
  const { request } = await fixture(t);
  const response = await request('/api/prices', { headers: { Origin: publicOrigin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), publicOrigin);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  const seed = JSON.parse(await readFile(join(root, 'data/seed.json'), 'utf8'));
  assert.deepEqual(data.services, seed.services);
  assert.deepEqual(data.prices, seed.prices);
  assert.equal(data.services.length, 35);
  assert.equal((await request('/api/prices', { headers: { Origin: 'https://untrusted.example' } })).headers.get('access-control-allow-origin'), null);
});

test('unauthorised writes, forged origins and missing CSRF are rejected', async t => {
  const { request, authenticated } = await fixture(t);
  assert.equal((await request('/api/prices', { method: 'PUT', headers: { Origin: origin } })).status, 401);
  assert.equal((await request('/api/login', { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const headers = await authenticated();
  delete headers['X-CSRF-Token'];
  assert.equal((await request('/api/prices', { method: 'PUT', headers, body: '{}' })).status, 403);
});

test('authenticated save is public, persists, creates a backup and rejects old revisions', async t => {
  const { request, authenticated, directory } = await fixture(t);
  const headers = await authenticated();
  const data = await (await request('/api/prices')).json();
  const original = structuredClone(data);
  data.prices['service-001'].moscow = { amount: 4321, from: true };
  const response = await request('/api/prices', { method: 'PUT', headers, body: JSON.stringify(data) });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.revision, 2);
  assert.deepEqual((await (await request('/api/prices')).json()).prices, data.prices);
  assert.equal(JSON.parse(await readFile(join(directory, 'prices.json'), 'utf8')).prices['service-001'].moscow.amount, 4321);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'backups/prices-1.json'), 'utf8')).prices, original.prices);
  assert.equal((await request('/api/prices', { method: 'PUT', headers, body: JSON.stringify(original) })).status, 409);
  // Re-open the same durable store with a fresh server instance.
  const restarted = await createApp({ root, directory, username: 'test-admin', passwordHash, adminOrigin: origin, publicOrigin, insecure: true });
  await new Promise(resolve => restarted.listen(0, '127.0.0.1', resolve));
  try {
    const result = await fetch(`http://127.0.0.1:${restarted.address().port}/api/prices`);
    assert.equal((await result.json()).prices['service-001'].moscow.amount, 4321);
  } finally { await new Promise(resolve => restarted.close(resolve)); }
});

test('invalid, incomplete, fractional and injected prices cannot change the store', async t => {
  const { request, authenticated } = await fixture(t);
  const headers = await authenticated();
  const original = await (await request('/api/prices')).json();
  for (const bad of [-1, 1.5, 1000001, '<script>alert(1)</script>', null]) {
    const input = structuredClone(original);
    input.prices['service-001'].moscow.amount = bad;
    assert.equal((await request('/api/prices', { method: 'PUT', headers, body: JSON.stringify(input) })).status, 400);
  }
  const incomplete = structuredClone(original);
  delete incomplete.prices['service-001'];
  assert.equal((await request('/api/prices', { method: 'PUT', headers, body: JSON.stringify(incomplete) })).status, 400);
  assert.deepEqual((await (await request('/api/prices')).json()).prices, original.prices);
});

test('concurrent edits have one winner; logout revokes access', async t => {
  const { request, authenticated } = await fixture(t);
  const headers = await authenticated();
  const data = await (await request('/api/prices')).json();
  const results = await Promise.all([4321, 5432].map(amount => {
    const input = structuredClone(data);
    input.prices['service-001'].moscow.amount = amount;
    return request('/api/prices', { method: 'PUT', headers, body: JSON.stringify(input) });
  }));
  assert.deepEqual(results.map(x => x.status).sort(), [200, 409]);
  assert.equal((await request('/api/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await request('/api/session', { headers })).status, 401);
  assert.equal((await request('/api/prices', { method: 'PUT', headers, body: JSON.stringify(data) })).status, 401);
});

test('login throttling, cookies and private file isolation', async t => {
  const { request } = await fixture(t);
  for (let i = 0; i < 10; i++) {
    assert.equal((await request('/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test-admin', password: 'incorrect' }) })).status, 401);
  }
  assert.equal((await request('/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 429);
  for (const path of ['/runtime/admin.json', '/runtime/prices.json', '/data/seed.json', '/.env', '/.git/config', '/server/app.mjs']) assert.equal((await request(path)).status, 404);
  assert.equal((await request('/admin/')).headers.get('content-security-policy').includes("script-src 'self'"), true);
});

test('production cookie is Secure and invalid credentials configuration fails closed', async t => {
  const directory = await mkdtemp(join(root, 'work/test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(createApp({ root, directory, username: 'test-admin', passwordHash: '', adminOrigin: 'https://admin.mutaeva.ru', publicOrigin }), /ADMIN_PASSWORD_HASH/);
  const app = await createApp({ root, directory, username: 'test-admin', passwordHash, adminOrigin: 'https://admin.mutaeva.ru', publicOrigin });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${app.address().port}/api/login`, { method: 'POST', headers: { Origin: 'https://admin.mutaeva.ru', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test-admin', password }) });
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Secure/);
});

test('corrupt saved data never silently resets prices to the seed', async t => {
  const directory = await mkdtemp(join(root, 'work/test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'prices.json'), '{corrupt');
  await assert.rejects(createApp({ root, directory, username: 'test-admin', passwordHash, adminOrigin: origin, publicOrigin, insecure: true }));
  assert.equal(await readFile(join(directory, 'prices.json'), 'utf8'), '{corrupt');
});
