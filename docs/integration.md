# 接入现有网站

如果只想快速嵌入，按 [README 的 iframe 方法](../README.md#方法一iframe最少改动) 即可。下面说明如何复用已有网站的后台登录，并把数字放进自己的卡片。

## 前提

- 已按 README 将组件部署到你自己的 Cloudflare 账户，首次同步成功。
- 你的网站有服务端，并已有管理员登录中间件。示例采用 Express，其他框架按相同请求关系移植。
- 同步接口应沿用你的网站既有 CSRF 防护，不向未登录访客开放。

## 1. 在网站服务端配置环境变量

把下面两个值添加到**你的网站服务端**环境变量或 Secret 管理中：

```dotenv
DEEPSEEK_WIDGET_URL=https://deepseek-usage-widget.YOUR_SUBDOMAIN.workers.dev
DEEPSEEK_WIDGET_ADMIN_TOKEN=the-admin-token-you-created
```

这是组件地址与组件管理员令牌，不是 DeepSeek 的 API Key 或网页 Token。DeepSeek 两种凭据仍只放在 Worker Secrets 中。

不要使用 `VITE_`、`NEXT_PUBLIC_` 等会把值打包到浏览器的公开变量前缀，也不要将真实值提交到仓库。

## 2. 注册已鉴权的服务端路由

将 [examples/express-route.mjs](../examples/express-route.mjs) 复制到自己的网站服务端。假设你的 Express 程序已有 `app` 和 `requireAdmin`：

```javascript
import { registerDeepSeekRoutes } from './express-route.mjs';

// requireAdmin 必须是你网站现有的管理员鉴权中间件。
// 在注册前接入网站已有的 CSRF 防护。
registerDeepSeekRoutes(app, requireAdmin);
```

它注册两个同源接口：

| 网站接口 | 组件接口 | 用途 |
| --- | --- | --- |
| `GET /internal/deepseek-usage` | `GET /api/usage` | 读取已保存快照 |
| `POST /internal/deepseek-sync` | `POST /api/sync` | 同步一批历史月份 |

浏览器不需要知道组件的管理员令牌。示例只提供代理路由，不是完整的 Express 站点；`app`、登录和 CSRF 校验由你的现有网站提供。

## 3. 在后台页面添加卡片

可以直接复制以下 HTML 到自己网站的后台页面，并按自己的设计修改样式：

```html
<section>
  <h3>DeepSeek</h3>
  <p>余额 <strong id="ds-balance">—</strong></p>
  <p>累计 Token <strong id="ds-tokens">—</strong></p>
  <button id="ds-sync" type="button">同步</button>
  <p id="ds-status" role="status"></p>
</section>

<script type="module">
  const balance = document.getElementById('ds-balance');
  const tokens = document.getElementById('ds-tokens');
  const button = document.getElementById('ds-sync');
  const status = document.getElementById('ds-status');

  async function request(path, method = 'GET') {
    // 如果你的网站需要 CSRF Header，在这里加入现有网站的 CSRF 令牌。
    const response = await fetch(path, { method, credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function render(data) {
    balance.textContent = data.balances?.map(item => `${item.currency} ${item.total_balance.toFixed(2)}`).join(' / ') || '—';
    tokens.textContent = data.usage ? data.usage.total_tokens.toLocaleString('zh-CN') : '—';
    status.textContent = [data.balance_error, data.error,
      data.history_pending ? `同步中 ${data.history_progress.completed}/${data.history_progress.total}` : '']
      .filter(Boolean).join('；');
  }

  request('/internal/deepseek-usage').then(render).catch(error => { status.textContent = error.message; });
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      let data;
      do {
        data = await request('/internal/deepseek-sync', 'POST');
        render(data);
      } while (data.history_pending && !data.error);
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
</script>
```

## 4. 验证接入

1. 未登录网站时，请求 `/internal/deepseek-usage` 应被你的管理员中间件拒绝。
2. 登录网站后打开卡片，余额和累计 Token 应与组件独立页面一致。
3. 浏览器 Network 面板中只应出现自己网站的 `/internal/...` 请求，不应出现 DeepSeek Key、网页 Token 或组件 `ADMIN_TOKEN`。
4. 点击同步，观察进度；刷新页面应读取快照，不会重新拉取全部历史。
5. 完成后关闭浏览器也不影响 Worker 每日定时更新。

如果你的站点只有静态 HTML、没有服务端，使用 iframe。不要把 Secret 放进静态文件，也不要开启公开接口来替代管理员登录。
