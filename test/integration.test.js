import test from 'node:test';
import assert from 'node:assert/strict';
import { registerDeepSeekRoutes } from '../examples/express-route.mjs';

test('the website example registers authenticated routes and forwards credentials only from the server', async t => {
  const routes = [], requireAdmin = () => {};
  const app = { get: (...args) => routes.push(['GET', ...args]), post: (...args) => routes.push(['POST', ...args]) };
  registerDeepSeekRoutes(app, requireAdmin);
  assert.equal(routes.length, 2);
  for (const route of routes) assert.equal(route[2], requireAdmin);
  const oldUrl = process.env.DEEPSEEK_WIDGET_URL, oldToken = process.env.DEEPSEEK_WIDGET_ADMIN_TOKEN;
  process.env.DEEPSEEK_WIDGET_URL = 'https://widget.test';
  process.env.DEEPSEEK_WIDGET_ADMIN_TOKEN = 'fixture-server-token';
  t.after(() => {
    if (oldUrl === undefined) delete process.env.DEEPSEEK_WIDGET_URL; else process.env.DEEPSEEK_WIDGET_URL = oldUrl;
    if (oldToken === undefined) delete process.env.DEEPSEEK_WIDGET_ADMIN_TOKEN; else process.env.DEEPSEEK_WIDGET_ADMIN_TOKEN = oldToken;
  });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({ usage: { total_tokens: 120 } });
  });
  for (const [method, path, , handler] of routes) {
    const reply = { headers: {}, status(value) { this.code = value; return this; }, set(key, value) { this.headers[key] = value; return this; }, send(body) { this.body = body; } };
    await handler({}, reply);
    assert.equal(reply.code, 200);
    assert.equal(reply.headers['Cache-Control'], 'no-store');
    assert.ok(!reply.body.includes('fixture-server-token'));
    assert.equal(calls.at(-1).options.method, method);
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer fixture-server-token');
    assert.equal(calls.at(-1).options.redirect, 'manual');
    assert.equal(calls.at(-1).url, `https://widget.test/api/${path.endsWith('sync') ? 'sync' : 'usage'}`);
  }
});
