// Historical usage schema adapted from Joyi-code/DeepSeekMonitorWindows (MIT). See NOTICE.md.
const FIRST_MONTH = '2023-01';
const HISTORY_BATCH = 6;
const UPSERT = 'INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at';

export function beijingDate(value = new Date()) {
  return new Date(value.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

async function read(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(key).first();
  return row?.value ? JSON.parse(row.value) : {};
}

export async function saveUsageSetting(env, key, value) {
  await env.DB.prepare(UPSERT).bind(key, JSON.stringify(value), new Date().toISOString()).run();
}

async function fingerprint(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function getJson(url, headers) {
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000), redirect: 'manual' });
  } catch {
    throw Object.assign(new Error('连接服务失败，请稍后重试'), { retryable: true });
  }
  if ([401, 403].includes(response.status)) throw new Error('凭据无效或已过期，请重新配置');
  if (response.status === 429) throw new Error('服务限流，请稍后重试');
  if (!response.ok) throw Object.assign(new Error(`查询失败：HTTP ${response.status}`), { retryable: response.status >= 500 });
  try { return await response.json(); }
  catch {
    const type = response.headers.get('Content-Type')?.split(';')[0] || '未知类型';
    throw Object.assign(new Error(`服务未返回有效 JSON（HTTP ${response.status}，${type}）`), { retryable: true });
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function deepSeekMonth(month, token) {
  const [year, value] = month.split('-');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await getJson(`https://platform.deepseek.com/api/v0/usage/amount?month=${Number(value)}&year=${year}`, {
        Authorization: `Bearer ${token}`, 'x-app-version': '1.0.0', Accept: 'application/json',
      });
    } catch (error) {
      if (!error.retryable || attempt === 2) throw error;
      await delay((attempt + 1) * 1_000);
    }
  }
}

function number(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean'
    || !Number.isFinite(Number(value))) throw new Error('服务返回的统计数据不完整');
  return Number(value);
}

function totals() {
  return { total_tokens: 0, input_tokens: 0, output_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0, request_count: 0 };
}

function add(target, source) {
  for (const key of Object.keys(totals())) target[key] += source[key];
}

function summarizeModels(rows) {
  if (!Array.isArray(rows)) throw new Error('用量接口返回的数据格式已变化');
  const models = Object.create(null);
  for (const row of rows) {
    if (typeof row.model !== 'string' || !Array.isArray(row.usage)) throw new Error('模型用量数据不完整');
    const entries = Object.fromEntries(row.usage.map(entry => {
      const value = number(entry.amount);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('模型用量数值无法识别');
      if (entry.type.endsWith('TOKEN') && !['PROMPT_TOKEN', 'PROMPT_CACHE_HIT_TOKEN', 'PROMPT_CACHE_MISS_TOKEN', 'RESPONSE_TOKEN'].includes(entry.type)) {
        throw new Error('模型 Token 类型已变化，请更新统计适配');
      }
      return [entry.type, value];
    }));
    const hit = entries.PROMPT_CACHE_HIT_TOKEN || 0, miss = entries.PROMPT_CACHE_MISS_TOKEN || 0;
    const input = 'PROMPT_CACHE_HIT_TOKEN' in entries || 'PROMPT_CACHE_MISS_TOKEN' in entries
      ? hit + miss : entries.PROMPT_TOKEN || 0;
    const output = entries.RESPONSE_TOKEN || 0;
    const item = models[row.model] ||= totals();
    add(item, { total_tokens: input + output, input_tokens: input, output_tokens: output,
      cache_hit_tokens: hit, cache_miss_tokens: miss, request_count: entries.REQUEST || 0 });
  }
  return models;
}

export function summarizeDeepSeekMonth(payload, month, today) {
  const data = payload?.data?.biz_data;
  if (!data || !Array.isArray(data.total) || !Array.isArray(data.days)) throw new Error('用量接口返回的数据格式已变化或登录已失效');
  if (month < today.slice(0, 7)) return summarizeModels(data.total);
  const models = Object.create(null);
  for (const day of data.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day.date) || !day.date.startsWith(month)) throw new Error('用量日期格式无法识别');
    if (day.date >= today) continue;
    for (const [model, usage] of Object.entries(summarizeModels(day.data))) add(models[model] ||= totals(), usage);
  }
  return models;
}

function monthsThrough(today) {
  const months = [];
  for (let year = 2023; year <= Number(today.slice(0, 4)); year++) {
    for (let month = 1; month <= 12; month++) {
      const value = `${year}-${String(month).padStart(2, '0')}`;
      if (value <= today.slice(0, 7)) months.push(value);
    }
  }
  return months;
}

export async function syncUsage(env, date = new Date()) {
  const credentials = { apiKey: String(env.DEEPSEEK_API_KEY || '').trim(), usageToken: String(env.DEEPSEEK_USAGE_TOKEN || '').trim() };
  const today = beijingDate(date), timestamp = date.toISOString();
  const identity = await fingerprint(`${credentials.apiKey}\0${credentials.usageToken}`);
  let state = await read(env, 'usage_deepseek');
  if (state.identity !== identity) state = { identity, months: {} };
  if (state.attempt_date === today && !state.history_pending && !state.error && !state.balance_error) return readUsage(env);
  state.error = '';
  if (!credentials.apiKey) state.balance_error = '尚未配置 DeepSeek API Key';
  else if (state.balance_attempt_date !== today || state.balance_error) {
    state.balance_attempt_date = today;
    try {
      const result = await getJson('https://api.deepseek.com/user/balance', { Authorization: `Bearer ${credentials.apiKey}` });
      if (!Array.isArray(result.balance_infos) || !result.balance_infos.length) throw new Error('余额数据不完整');
      state.balances = result.balance_infos.map(item => ({ currency: String(item.currency),
        total_balance: number(item.total_balance), granted_balance: number(item.granted_balance), topped_up_balance: number(item.topped_up_balance) }));
      state.balance_updated_at = timestamp;
      state.balance_error = '';
    } catch (error) { state.balance_error = error.message; }
  }
  if (!credentials.usageToken) {
    state.error = '历史 Token 统计需要配置 DeepSeek 网页用量 Token';
    state.history_pending = false;
  } else {
    const months = monthsThrough(today), current = months.at(-1), previous = months.at(-2);
    const missing = months.filter(month => !state.months[month]);
    const refresh = [previous, current].filter(month => month && state.months[month] && state.months[month].date !== today);
    const pending = [...new Set([...refresh, ...missing])].slice(0, HISTORY_BATCH);
    let activeMonth = '';
    try {
      for (const [index, month] of pending.entries()) {
        activeMonth = month;
        if (index) await delay(1_000);
        const result = await deepSeekMonth(month, credentials.usageToken);
        state.months[month] = { date: today, models: summarizeDeepSeekMonth(result, month, today) };
      }
    } catch (error) { state.error = `${activeMonth}：${error.message}`; }
    state.history_pending = months.some(month => !state.months[month]);
    state.history_progress = { completed: months.filter(month => state.months[month]).length, total: months.length };
    if (!state.history_pending && !state.error) {
      const combined = Object.create(null), total = totals();
      for (const month of months) {
        for (const [model, usage] of Object.entries(state.months[month].models)) add(combined[model] ||= totals(), usage);
      }
      for (const usage of Object.values(combined)) add(total, usage);
      state.usage = { ...total, models: Object.entries(combined).map(([model, usage]) => ({ model, ...usage })),
        start_date: `${FIRST_MONTH}-01`, through_date: beijingDate(new Date(date.getTime() - 86_400_000)), updated_at: timestamp };
    }
  }
  state.attempt_date = today;
  await saveUsageSetting(env, 'usage_deepseek', state);
  return readUsage(env);
}

export async function readUsage(env) {
  const { identity, months, ...snapshot } = await read(env, 'usage_deepseek');
  return snapshot;
}
