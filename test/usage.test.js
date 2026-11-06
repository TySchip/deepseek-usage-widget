import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { beijingDate, readUsage, summarizeDeepSeekMonth, syncUsage } from '../src/usage.js';

const date = new Date('2023-02-01T20:00:00Z'); // Beijing February 2.
function environment(t) {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => database.close());
  return { ADMIN_TOKEN: 'fixture-admin', DEEPSEEK_API_KEY: 'fixture-api', DEEPSEEK_USAGE_TOKEN: 'fixture-web',
    DB: { prepare(sql) { return {
      args: [], bind(...args) { this.args = args; return this; },
      async first() { return database.prepare(sql).get(...this.args); },
      async run() { database.prepare(sql).run(...this.args); },
    }; } },
  };
}
function model(name = 'legacy-model') {
  return { model: name, usage: [
    { type: 'PROMPT_TOKEN', amount: '100' }, { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '60' },
    { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '40' }, { type: 'RESPONSE_TOKEN', amount: '20' },
    { type: 'REQUEST', amount: '2' },
  ] };
}
function monthPayload(month) {
  return { data: { biz_data: { total: [model(), model('future-model')], days: [
    { date: `${month}-01`, data: [model(), model('future-model')] },
    { date: `${month}-02`, data: [model('today-model')] },
  ] } } };
}
function mockUpstream(t, override) {
  const calls = [];
  t.mock.method(globalThis, 'setTimeout', callback => { queueMicrotask(callback); return 0; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    const custom = await override?.(String(url), options);
    if (custom) return custom;
    if (url === 'https://api.deepseek.com/user/balance') return Response.json({ balance_infos: [
      { currency: 'CNY', total_balance: '12.34', granted_balance: '2.34', topped_up_balance: '10.00' },
    ] });
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'platform.deepseek.com');
    return Response.json(monthPayload(`${parsed.searchParams.get('year')}-${parsed.searchParams.get('month').padStart(2, '0')}`));
  });
  return calls;
}
function request(path, token = 'fixture-admin', method = 'GET') {
  return new Request(`https://widget.test${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
}

test('uses Beijing dates across UTC, month and year boundaries', () => {
  assert.equal(beijingDate(new Date('2026-12-31T15:59:59Z')), '2026-12-31');
  assert.equal(beijingDate(new Date('2026-12-31T16:00:00Z')), '2027-01-01');
});

test('counts all models, excludes today and avoids adding prompt totals to cache breakdowns', () => {
  const data = summarizeDeepSeekMonth(monthPayload('2023-02'), '2023-02', '2023-02-02');
  assert.deepEqual(Object.keys(data), ['legacy-model', 'future-model']);
  assert.equal(data['legacy-model'].input_tokens, 100);
  assert.equal(data['legacy-model'].total_tokens, 120);
  assert.equal(data['legacy-model'].cache_hit_tokens, 60);
  assert.equal(data['legacy-model'].request_count, 2);
});

test('supports old prompt-only models and the first day of a month', () => {
  const row = model(); row.usage = row.usage.filter(item => !item.type.startsWith('PROMPT_CACHE_'));
  const data = { data: { biz_data: { total: [row], days: [] } } };
  assert.equal(summarizeDeepSeekMonth(data, '2023-01', '2023-02-01')['legacy-model'].total_tokens, 120);
  assert.equal(Object.keys(summarizeDeepSeekMonth(monthPayload('2023-02'), '2023-02', '2023-02-01')).length, 0);
});

test('rejects changed schemas, invalid dates and unknown token types', () => {
  assert.throws(() => summarizeDeepSeekMonth({}, '2023-02', '2023-02-02'));
  const dateData = monthPayload('2023-02'); dateData.data.biz_data.days[0].date = '02/01/2023';
  assert.throws(() => summarizeDeepSeekMonth(dateData, '2023-02', '2023-02-02'));
  const unknown = monthPayload('2023-02'); unknown.data.biz_data.total[0].usage.push({ type: 'NEW_TOKEN', amount: '1' });
  assert.throws(() => summarizeDeepSeekMonth(unknown, '2023-01', '2023-02-02'));
});

test('model names cannot mutate JavaScript prototypes', () => {
  const payload = { data: { biz_data: { total: [model('__proto__'), model('constructor')], days: [] } } };
  const data = summarizeDeepSeekMonth(payload, '2023-01', '2023-02-02');
  assert.equal(data.__proto__.total_tokens, 120);
  assert.equal(data.constructor.total_tokens, 120);
  assert.equal({}.total_tokens, undefined);
});

test('saves complete totals and reads do not disclose credentials, fingerprints or monthly cache', async t => {
  const env = environment(t); mockUpstream(t);
  const data = await syncUsage(env, date);
  assert.equal(data.balances[0].total_balance, 12.34);
  assert.equal(data.usage.total_tokens, 480);
  assert.equal(data.usage.through_date, '2023-02-01');
  assert.equal(data.history_pending, false);
  const output = JSON.stringify(await readUsage(env));
  for (const forbidden of [env.ADMIN_TOKEN, env.DEEPSEEK_API_KEY, env.DEEPSEEK_USAGE_TOKEN, 'identity', 'months']) {
    assert.ok(!output.includes(forbidden));
  }
});

test('same-day successful sync and reads do not repeat upstream requests', async t => {
  const env = environment(t), calls = mockUpstream(t);
  await syncUsage(env, date);
  const count = calls.length;
  await readUsage(env);
  const same = await syncUsage(env, new Date('2023-02-02T01:00:00Z'));
  assert.equal(same.usage.total_tokens, 480);
  assert.equal(calls.length, count);
  await syncUsage(env, new Date('2023-02-02T16:00:00Z'));
  assert.ok(calls.length > count);
});

test('backfills in batches and only publishes a total when all months are complete', async t => {
  const env = environment(t), calls = mockUpstream(t), later = new Date('2026-11-06T00:00:00Z');
  let data = await syncUsage(env, later);
  assert.equal(data.history_progress.completed, 6);
  assert.equal(data.usage, undefined);
  assert.equal(calls.filter(call => call.url.includes('/usage/amount')).length, 6);
  let batches = 1;
  while (data.history_pending && !data.error && batches++ < 12) data = await syncUsage(env, later);
  assert.equal(data.history_pending, false);
  assert.equal(data.history_progress.completed, 47);
  assert.equal(data.usage.total_tokens, 47 * 240 + 120);
});

test('retries transient HTML responses and preserves progress across a failed month', async t => {
  const env = environment(t);
  let failing = true;
  const calls = mockUpstream(t, url => url.includes('/usage/amount?month=2&year=2023') && failing
    ? new Response('<html>temporary response</html>', { status: 202, headers: { 'Content-Type': 'text/html' } }) : null);
  const first = await syncUsage(env, date);
  assert.equal(first.history_progress.completed, 1);
  assert.match(first.error, /2023-02.*HTTP 202.*text\/html/u);
  assert.equal(first.usage, undefined);
  assert.equal(calls.filter(call => call.url.includes('/usage/amount?month=2&year=2023')).length, 3);
  failing = false;
  const second = await syncUsage(env, date);
  assert.equal(second.error, '');
  assert.equal(second.usage.total_tokens, 480);
  assert.equal(calls.filter(call => call.url.includes('/usage/amount?month=1&year=2023')).length, 1);
});

test('expired web tokens are not repeatedly retried or counted as zero', async t => {
  const env = environment(t);
  const calls = mockUpstream(t, url => url.includes('/usage/amount') ? Response.json({}, { status: 401 }) : null);
  const data = await syncUsage(env, date);
  assert.match(data.error, /2023-01.*凭据无效/u);
  assert.equal(data.history_progress.completed, 0);
  assert.equal(data.usage, undefined);
  assert.equal(calls.filter(call => call.url.includes('/usage/amount')).length, 1);
});

test('balance works without a web token and successful values survive later upstream failures', async t => {
  const env = environment(t); let offline = false;
  mockUpstream(t, () => { if (offline) throw new Error('fixture-api must not leak'); });
  const before = await syncUsage(env, date);
  offline = true;
  const after = await syncUsage(env, new Date(date.getTime() + 86_400_000));
  assert.deepEqual(after.usage, before.usage);
  assert.deepEqual(after.balances, before.balances);
  assert.ok(!JSON.stringify(after).includes('fixture-api'));
  offline = false; env.DEEPSEEK_USAGE_TOKEN = '';
  const balanceOnly = await syncUsage(env, date);
  assert.equal(balanceOnly.balances[0].total_balance, 12.34);
  assert.equal(balanceOnly.usage, undefined);
  assert.match(balanceOnly.error, /网页用量 Token/u);
});

test('rejects redirects instead of forwarding sensitive headers to another host', async t => {
  const env = environment(t);
  const calls = mockUpstream(t, () => new Response(null, { status: 302, headers: { Location: 'https://other.test/' } }));
  const data = await syncUsage(env, date);
  assert.match(data.error, /HTTP 302/u);
  for (const call of calls) {
    assert.equal(call.options.redirect, 'manual');
    assert.ok(!call.url.includes('other.test'));
  }
});

test('protects read and sync endpoints and does not expose credentials in responses', async t => {
  const env = environment(t), calls = mockUpstream(t);
  for (const token of ['', 'wrong', 'fixture-api']) {
    for (const [path, method] of [['/api/usage', 'GET'], ['/api/sync', 'POST']]) {
      assert.equal((await worker.fetch(request(path, token, method), env)).status, 401);
    }
  }
  assert.equal(calls.length, 0);
  const empty = await worker.fetch(request('/api/usage'), env);
  assert.equal(empty.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await empty.json(), {});
  const synced = await worker.fetch(request('/api/sync', 'fixture-admin', 'POST'), env);
  assert.equal(synced.status, 200);
  assert.ok(!JSON.stringify(await synced.json()).includes('fixture-web'));
  assert.equal((await worker.fetch(request('/api/health', ''), env)).status, 200);
});

test('daily scheduling invokes the same synchronization operation', async t => {
  const env = environment(t); mockUpstream(t);
  const tasks = [];
  worker.scheduled({}, env, { waitUntil(task) { tasks.push(task); } });
  assert.equal(tasks.length, 1);
  await Promise.all(tasks);
  assert.equal((await readUsage(env)).history_progress.completed, 6);
});
