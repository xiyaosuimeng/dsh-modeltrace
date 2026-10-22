import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import plugin from '../lib/index.js';

const root = new Context();
const routes = new Map();
let lookups = 0;
const agent = { id: 'session-known', session: { id: 'session-known' }, options: { model: 'gpt-5.4', provider: 'mock' } };
root.provide('webServer', { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } });
root.provide('agents', { get(id) { lookups++; return id === agent.id ? agent : undefined; } });
// Use the real host Host/Origin fence and admission contract. This fixture's
// auth owner grants a synthetic cookie; no deployed credentials are needed.
new HostConnectionService(root, [], { isAuthenticated: req => req.headers.cookie === 'fixture=ok' });
const mounted = root.plugin(plugin, {});
await mounted.await();
const route = routes.get('/api/modeltrace');
assert.equal(route.kind, 'exact');
async function request({ method = 'GET', host = '127.0.0.1:3080', cookie = 'fixture=ok', origin, sessionId = agent.id } = {}) {
  const req = { method, url: '/api/modeltrace?sessionId=' + encodeURIComponent(sessionId),
    headers: { host, cookie, ...(origin ? { origin } : {}) } };
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  await route.handler(req, res);
  return res;
}
const unauthorized = await request({ cookie: '' });
assert.equal(unauthorized.status, 401);
assert.equal((await request({ host: 'attacker.invalid' })).status, 403);
assert.equal((await request({ origin: 'https://attacker.invalid' })).status, 403);
assert.equal(lookups, 0, 'rejected requests never access session state');
assert.equal((await request({ method: 'POST' })).status, 405);
assert.equal(lookups, 0, 'read-only endpoint refuses mutation');
const missing = await request({ sessionId: 'missing' });
assert.equal(missing.status, 404);
assert.deepEqual(JSON.parse(missing.body), { error: 'session/not-found' });
const known = await request();
assert.equal(known.status, 200);
assert.equal(known.headers['Cache-Control'], 'no-store');
assert.equal(JSON.parse(known.body).status, 'idle');
assert.equal(JSON.parse(known.body).selection.model, 'gpt-5.4');
await mounted.dispose();
assert.equal(routes.size, 0, 'route is owned and removed when plugin is disposed');
await root.fiber.dispose();
console.log('PASS read-only status API: real Host/Origin admission, authentication, session isolation and disposal');
