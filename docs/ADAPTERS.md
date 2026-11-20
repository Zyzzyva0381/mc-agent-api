# 适配器：对接自己的服务器

核心引擎（`src/session.js`、`src/http.js`）不关心"账号从哪来"和"bot 什么时候算到位了"，这两件事交给两类适配器。内置的够用就只改配置；不够用就写一个 JS 文件，用 `module` 指过去（相对 `config.json` 所在目录）。

**进程模型**（1.3.13 起）：HTTP 主进程只做认证和转发，每个登录的 bot 跑在自己的子进程里（`src/worker.js`），这样一个 bot 的重计算（寻路、大范围 `find_blocks`）不会拖慢其它 bot 的请求。所以：认证适配器的 `authenticate` 在主进程里执行，返回的 `botOptions` 要通过 IPC 传给子进程；就绪判定适配器在子进程里创建，每个 bot 一份（模块级的单例也是每个子进程一份）。

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
  },
  // 可选：botOptions 会经 IPC（结构化克隆）传到 bot 子进程，函数、HTTP agent 之类传不过去。
  // 主进程会去掉 botOptions.agent；需要的话在这里（子进程里）补回来
  prepareBotOptions (botOptions) { return botOptions }
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

比赛服拆成多台后端时（每台一个服务端进程，主线程互不影响），给 `proxy` 加分配表，每个账号固定去一台：

```json
"readiness": {
  "type": "proxy",
  "server": "survival",
  "rcon": { "host": "10.0.0.6", "port": 25575, "passwordFile": ".rcon-pass" },
  "backends": { "survival2": { "rcon": { "host": "10.0.0.6", "port": 25576, "passwordFile": ".rcon-pass" } } },
  "assignmentsFile": "assignments.json"
}
```

`assignments.json` 是 `{"登录名": "后端名"}`。匹配不区分大小写。外置认证允许用不同标识登录同一角色时，分配表匹配的是请求中的 `username`。赛事部署应统一使用登记的角色名登录。

分配表在 bot 子进程启动时读取，文件条目覆盖内联的 `assignments`。没有匹配条目时使用 `server`。修改分配表后，新会话会使用新值。现有会话在原子进程内重连会保持原分配，子进程异常重启时会重新读取，即使客户端还在使用原 token。

在 Velocity 注册分配表里的每个后端，并给每个后端配置自己的 RCON。多服模式用目标后端的玩家列表确认 bot 在场。部署时应校验分配 JSON、后端名及 RCON 地址，再原子替换分配文件。适配器的 `server` 字段出现在 `/status.server`，表示目标后端。
