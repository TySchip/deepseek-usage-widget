const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('deepseekWidgetAdminToken') || '';

async function api(path, method = 'GET') {
  const response = await fetch(path, { method, headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json();
  if (!response.ok) throw new Error(response.status === 401 ? '管理员令牌无效' : data.error || `HTTP ${response.status}`);
  return data;
}

function render(data) {
  $('balance').textContent = data.balances?.map(item => `${item.currency} ${item.total_balance.toFixed(2)}`).join(' / ') || '—';
  $('tokens').textContent = data.usage ? data.usage.total_tokens.toLocaleString('zh-CN') : '—';
  $('status').textContent = [data.balance_error, data.error,
    data.history_pending ? `同步中 ${data.history_progress?.completed || 0}/${data.history_progress?.total || '—'}` : ''].filter(Boolean).join('；');
}

async function login() {
  try {
    const data = await api('/api/usage');
    sessionStorage.setItem('deepseekWidgetAdminToken', token);
    $('token').value = '';
    $('login').hidden = true;
    $('dashboard').hidden = false;
    render(data);
  } catch (error) { $('loginStatus').textContent = error.message; }
}

$('loginForm').addEventListener('submit', event => {
  event.preventDefault();
  token = $('token').value.trim();
  login();
});

$('sync').addEventListener('click', async () => {
  $('sync').disabled = true;
  try {
    let data;
    do {
      data = await api('/api/sync', 'POST');
      render(data);
    } while (data.history_pending && !data.error);
  } catch (error) { $('status').textContent = error.message; }
  finally { $('sync').disabled = false; }
});

if (token) login();
