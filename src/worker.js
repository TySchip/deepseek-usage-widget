import { readUsage, syncUsage } from './usage.js';

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function authorized(request, env) {
  const token = String(env.ADMIN_TOKEN || '').trim();
  const header = request.headers.get('Authorization') || '';
  return Boolean(token && header.startsWith('Bearer ')
    && await digest(header.slice(7).trim()) === await digest(token));
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/health') return json({ ok: true });
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!await authorized(request, env)) return json({ error: 'unauthorized' }, 401);
    try {
      if (path === '/api/usage' && request.method === 'GET') return json(await readUsage(env));
      if (path === '/api/sync' && request.method === 'POST') return json(await syncUsage(env));
      return json({ error: 'not_found' }, 404);
    } catch {
      return json({ error: '快照读取或保存失败，请检查 D1 绑定及数据库初始化' }, 500);
    }
  },
  scheduled(_event, env, context) {
    context.waitUntil(syncUsage(env));
  },
};
