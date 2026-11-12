# 适配器：对接自己的服务器

核心引擎（`src/session.js`、`src/http.js`）不关心"账号从哪来"和"bot 什么时候算到位了"，这两件事交给两类适配器。内置的够用就只改配置；不够用就写一个 JS 文件，用 `module` 指过去（相对 `config.json` 所在目录）。

## 认证适配器（`auth`）

```json
"auth": { "module": "./my-auth.js", "anyOption": 1 }
```

```js
// my-auth.js
const { ApiError } = require('mc-agent-api/src/session')   // 或者相对路径 require('../src/session')

exports.create = (authConfig, config) => ({
  name: 'my-auth',
  async authenticate ({ username, password }) {
    // 校验失败：throw new ApiError('invalid_credentials', '...')
    return {
      profile: { id: '唯一 id（同一 id 只允许一个 bot 在线）', name: '角色名' },
      // 原样展开进 mineflayer.createBot()
      botOptions: { username: '角色名', auth: 'offline' }
    }
  }
})
```

可用的错误码：`invalid_credentials`（401）、`no_profile`（401）、`rate_limited`（429）、`auth_error`（401）、`bad_args`。

## 就绪判定适配器（`readiness`）

```json
"readiness": { "module": "./my-readiness.js", "anyOption": 1 }
```

`create(session, readinessConfig, config)` 每个 session 调用一次，返回：

| 方法 | 必需 | 说明 |
|---|---|---|
| `attach(bot)` | ✓ | 每次新建 bot（含断线重连）后调用；在这里挂监听、开定时器 |
| `isReady()` | ✓ | `status.ready` 和所有动作接口的总闸 |
| `onAdvancements(packet)` | | 收到 `advancements` 包；`session.advancementDefinitions.size` 是当前定义数 |
| `onConnectWhileNotReady()` | | 已连接但未就绪时客户端调了 `/connect`；返回的对象会并入响应 |
| `onEnd(reason)` | | 连接断开 |
| `destroy()` | | session 销毁（登出 / 过期 / 被顶号） |

适配器里可以用：

- `session.bot`：当前 mineflayer bot；
- `session.pushEvent(type, data)`：往事件流推一条事件（建议就绪时推 `server_confirmed`）；
- `session.hardReconnect(reason)`：整条连接重登（60 秒内最多一次，累计最多 5 次）；
- `session.log(...)`：带用户名前缀的日志。

最小示例（等服务器发来某条欢迎语才算就绪）：

```js
exports.create = (session, opts) => {
  let ready = false
  return {
    attach (bot) {
      ready = false
      bot.on('messagestr', m => {
        if (!ready && m.includes(opts.welcome || 'Welcome')) {
          ready = true
          session.pushEvent('server_confirmed', { via: 'welcome' })
        }
      })
    },
    isReady: () => ready,
    onEnd: () => { ready = false }
  }
}
```

内置 `proxy` 适配器（`src/readiness/proxy.js`）是一个完整的参考实现：自动 `/server`、用 advancement 规模识别大厅 / 后端、用后端 RCON 做在场确认、切服失败时整条连接自愈。
