import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('real Workers runtime supports requests, retry timers, progress persistence and resume', async () => {
  let january = 0, february = 0, failing = true;
  const source = readFileSync(new URL('../src/usage.js', import.meta.url), 'utf8');
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-09-10',
    script: source + `
const settings = new Map();
export default { async fetch() {
  const env = { DEEPSEEK_API_KEY: 'fixture-api', DEEPSEEK_USAGE_TOKEN: 'fixture-web', DB: { prepare() { return {
    args: [], bind(...args) { this.args = args; return this; },
    async first() { return settings.has(this.args[0]) ? { value: settings.get(this.args[0]) } : null; },
    async run() { settings.set(this.args[0], this.args[1]); }
  }; } } };
  return Response.json(await syncUsage(env, new Date('2023-02-02T00:00:00Z')));
} };`,
    outboundService: async request => {
      if (new URL(request.url).hostname === 'api.deepseek.com') return Response.json({ balance_infos: [
        { currency: 'CNY', total_balance: '12.34', granted_balance: '2.34', topped_up_balance: '10.00' },
      ] });
      const month = new URL(request.url).searchParams.get('month');
      if (month === '1') january++; else february++;
      if (month === '1' && january === 1 || month === '2' && failing) {
        return new Response('<html>temporary response</html>', { status: 202, headers: { 'Content-Type': 'text/html' } });
      }
      const row = { model: 'legacy-model', usage: [{ type: 'PROMPT_TOKEN', amount: '100' }, { type: 'RESPONSE_TOKEN', amount: '20' }] };
      return Response.json({ data: { biz_data: { total: [row], days: [{ date: '2023-02-01', data: [row] }] } } });
    },
  }));
  try {
    const first = await (await runtime.dispatchFetch('http://local.test/')).json();
    assert.equal(first.balances[0].total_balance, 12.34);
    assert.equal(first.history_progress.completed, 1);
    assert.match(first.error, /2023-02.*HTTP 202.*text\/html/u);
    assert.equal(january, 2);
    assert.equal(february, 3);
    failing = false;
    const second = await (await runtime.dispatchFetch('http://local.test/')).json();
    assert.equal(second.error, '');
    assert.equal(second.usage.total_tokens, 240);
    assert.equal(january, 2);
  } finally { await runtime.dispose(); }
});
