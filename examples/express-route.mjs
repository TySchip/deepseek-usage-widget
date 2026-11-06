// Mount these routes AFTER your own administrator authentication middleware.
export function registerDeepSeekRoutes(app, requireAdmin) {
  async function forward(response, path, method) {
    try {
      const base = process.env.DEEPSEEK_WIDGET_URL;
      const token = process.env.DEEPSEEK_WIDGET_ADMIN_TOKEN;
      if (!base || !token) return response.status(503).json({ error: '服务端未配置 DeepSeek 用量组件' });
      const upstream = await fetch(new URL(path, base), {
        method, headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(90_000),
      });
      response.status(upstream.status).set('Content-Type', 'application/json').set('Cache-Control', 'no-store').send(await upstream.text());
    } catch { response.status(502).json({ error: '用量服务暂不可用' }); }
  }
  app.get('/internal/deepseek-usage', requireAdmin, (_request, response) => forward(response, '/api/usage', 'GET'));
  app.post('/internal/deepseek-sync', requireAdmin, (_request, response) => forward(response, '/api/sync', 'POST'));
}
