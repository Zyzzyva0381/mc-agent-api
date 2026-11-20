'use strict'
// 一个 bot 一个子进程：mineflayer 的物理、区块解析、寻路和 find_blocks 都很吃 CPU，
// 23 个 bot 挤在一个 Node 线程里时，任何一个 bot 的重计算都会拖慢所有 bot 的 status / control（实测 p99 4 s 以上）。
// 主进程（http.js）负责 HTTP、认证和 token；这里只跑一个 Session，并处理主进程转发来的 API 调用。
//
// 消息（主进程 → 子进程）：
//   { type: 'init', config, route, token, username, profile, botOptions, createdAt }
//   { type: 'call', id, name, args }
//   { type: 'destroy' }
// 消息（子进程 → 主进程）：
//   { type: 'reply', id, status, json }      json 是已序列化的响应体
const { createAuthProvider } = require('./auth')
const { readinessFactory } = require('./readiness')
const core = require('./session')
const { dispatch } = require('./dispatch')

process.on('uncaughtException', e => core.log('UNCAUGHT', e && e.stack || e))
process.on('unhandledRejection', e => core.log('UNHANDLED_REJECTION', e && e.stack || e))
// 主进程退出（IPC 断开）时跟着退出，不留孤儿 bot
process.on('disconnect', () => { try { if (session) session.destroy() } catch (e) {} setTimeout(() => process.exit(0), 300).unref() })

let session = null
const early = []

function reply (id, status, body) {
  let json
  try { json = JSON.stringify(body) } catch (e) { status = 200; json = JSON.stringify({ ok: false, error: { code: 'internal', message: 'response not serializable: ' + e.message } }) }
  if (process.connected) process.send({ type: 'reply', id, status, json })
}

async function handleCall (m) {
  if (!session) return reply(m.id, 200, { ok: false, error: { code: 'not_connected', message: 'bot process is starting' } })
  let r
  try {
    r = await dispatch(session, m.name, m.args || {})
  } catch (e) {
    r = { status: 200, body: { ok: false, error: { code: e.code || 'internal', message: e.message } } }
  }
  reply(m.id, r.status, r.body)
}

process.on('message', m => {
  if (!m || typeof m !== 'object') return
  if (m.type === 'init') {
    const { config } = m
    const authProvider = createAuthProvider(config)
    core.configure({ config, createReadiness: readinessFactory(config) })
    // 不能跨进程传的部分（例如 yggdrasil 的 sessionserver HTTP agent）由认证适配器在子进程里补回
    const botOptions = authProvider.prepareBotOptions ? authProvider.prepareBotOptions(m.botOptions) : m.botOptions
    session = new core.Session(m.token, m.username, m.profile, botOptions, m.route)
    session.createdAt = m.createdAt
    core.sessions.set(m.token, session)
    session.connect()
    for (const c of early.splice(0)) handleCall(c)
    return
  }
  if (m.type === 'call') {
    if (!session) { early.push(m); return }
    handleCall(m)
    return
  }
  if (m.type === 'destroy') {
    try { if (session) session.destroy() } catch (e) {}
    // 给 quit 包一点时间发出去
    setTimeout(() => process.exit(0), 500).unref()
  }
})
