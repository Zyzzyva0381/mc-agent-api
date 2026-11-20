'use strict'
// HTTP 层：路由、Bearer token、登录限流。每个登录的 bot 跑在自己的子进程里（botproc.js / worker.js），
// 这里只做认证和转发；动作锁、stop_on 等在子进程的 dispatch.js 里。
const http = require('http')
const crypto = require('crypto')
const { log } = require('./session')
const { BotProcess } = require('./botproc')

// token -> BotProcess
const sessions = new Map()
const MAX_BODY_BYTES = 1024 * 1024

let config = null
let authProvider = null
const tokenTtlMs = () => config.session.tokenTtlHours * 60 * 60 * 1000

function configure (opts) {
  config = opts.config
  authProvider = opts.authProvider
}

// ---------- /auth/login 限流 ----------
// 口径：同一 IP 每分钟最多 N 次失败，超了锁一段时间；全局每分钟最多 M 次尝试，
// 免得把上游认证服务（皮肤站等）打爆。部署在反向代理 / 隧道后面时，打开
// http.trustProxyHeaders，按 CF-Connecting-IP / X-Forwarded-For 区分客户端。
const LOGIN_WINDOW_MS = 60 * 1000
const loginFails = new Map() // ip -> { count, windowStart }
const loginBlocked = new Map() // ip -> until(ms)
let loginAttempts = [] // 全局滑动窗口

function clientIp (req) {
  if (config.http.trustProxyHeaders) {
    const cf = req.headers['cf-connecting-ip']
    if (cf) return String(cf).split(',')[0].trim()
    const xff = req.headers['x-forwarded-for']
    if (xff) return String(xff).split(',')[0].trim()
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown'
}

function loginRateState (ip) {
  const now = Date.now()
  const until = loginBlocked.get(ip)
  if (until && until > now) return { blocked: true, retry: Math.ceil((until - now) / 1000), reason: 'ip' }
  if (until && until <= now) loginBlocked.delete(ip)
  loginAttempts = loginAttempts.filter(t => now - t < LOGIN_WINDOW_MS)
  if (loginAttempts.length >= config.http.loginRateLimit.maxGlobalPerMinute) {
    return { blocked: true, retry: 30, reason: 'global' }
  }
  loginAttempts.push(now)
  return { blocked: false }
}

function noteLoginFailure (ip) {
  const now = Date.now()
  const rec = loginFails.get(ip)
  const active = rec && now - rec.windowStart <= LOGIN_WINDOW_MS
  const count = active ? rec.count + 1 : 1
  const { maxFailsPerIp, blockSeconds } = config.http.loginRateLimit
  if (count >= maxFailsPerIp) {
    loginBlocked.set(ip, now + blockSeconds * 1000)
    loginFails.delete(ip)
  } else {
    loginFails.set(ip, { count, windowStart: active ? rec.windowStart : now })
  }
}

function noteLoginSuccess (ip) {
  loginFails.delete(ip)
  loginBlocked.delete(ip)
}

// HTTP 请求处理
async function handleRequest (req, res) {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }

  // Parse URL
  const match = req.url.match(/^\/api\/v1\/(.+?)(?:\?|$)/)
  if (!match) return send(404, { ok: false, error: { code: 'not_found' } })
  const path = match[1]

  const rejectOversizedBody = () => {
    res.setHeader('Connection', 'close')
    send(413, { ok: false, error: { code: 'body_too_large', message: 'request body exceeds 1 MiB' } })
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return rejectOversizedBody()
  const chunks = []
  let bytes = 0
  try {
    // Leave the socket open long enough to send the 413 response on an early return.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) return rejectOversizedBody()
      chunks.push(chunk)
    }
  } catch (error) {
    if (req.aborted || res.destroyed) return
    return send(400, { ok: false, error: { code: 'bad_json' } })
  }
  const body = Buffer.concat(chunks, bytes).toString('utf8')
  let args = {}
  try { args = body ? JSON.parse(body) : {} } catch { return send(400, { ok: false, error: { code: 'bad_json' } }) }
  // 查询串：文档里 /events 写的是 GET ?since=&limit=，之前只读 body 导致参数被静默忽略。
  // 查询参数作为基础值，JSON body 优先（同名时以 body 为准）。
  const qIndex = req.url.indexOf('?')
  if (qIndex >= 0) {
    const query = {}
    for (const [k, v] of new URLSearchParams(req.url.slice(qIndex + 1))) query[k] = v
    args = { ...query, ...args }
  }
  // 坐标别名：观察接口返回的 pos 可以直接回填给动作接口
  if (Array.isArray(args.pos) && args.pos.length === 3 && args.x === undefined) {
    [args.x, args.y, args.z] = args.pos.map(Number)
  }

  // Auth endpoints (no token required)
  if (path === 'auth/login') {
    const ip = clientIp(req)
    const rl = loginRateState(ip)
    if (rl.blocked) {
      log('LOGIN RATE LIMITED', ip, rl.reason, 'retry', rl.retry + 's')
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(rl.retry) })
      return res.end(JSON.stringify({ ok: false, error: { code: 'rate_limited', message: `too many login attempts, retry in ${rl.retry}s`, retry_after_s: rl.retry } }))
    }
    const { username, password } = args
    if (!username || typeof username !== 'string') return send(400, { ok: false, error: { code: 'bad_args', message: 'username required' } })
    try {
      const { profile, botOptions } = await authProvider.authenticate({ username, password })
      // 同一角色只能有一个 bot 在线：作废旧 session，避免新旧 bot 互踢
      for (const old of [...sessions.values()]) {
        if (old.profile.id === profile.id) { log('REPLACE', profile.name); old.destroy(); sessions.delete(old.token) }
      }
      const token = crypto.randomBytes(32).toString('hex')
      // 子进程启动后自动连接
      const session = new BotProcess({ token, username, profile, botOptions, configPath: config.configPath })
      sessions.set(token, session)
      noteLoginSuccess(ip)
      log('LOGIN', username, '->', profile.name, 'from', ip)
      return send(200, { ok: true, token, expires_at: new Date(Date.now() + tokenTtlMs()).toISOString(), bot_username: profile.name })
    } catch (e) {
      // 任何失败都计入限流（invalid_credentials / 上游 too frequent / 网络错误），
      // 否则被上游先限流时我们这边永远不会触发
      noteLoginFailure(ip)
      log('LOGIN FAIL', username, e.code, e.message, 'from', ip)
      return send(e.code === 'rate_limited' ? 429 : 401, { ok: false, error: { code: e.code || 'auth_error', message: e.message } })
    }
  }

  // All other endpoints require auth
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) return send(401, { ok: false, error: { code: 'unauthorized', message: 'Bearer token required' } })
  const token = auth.slice(7)
  const session = sessions.get(token)
  if (!session) return send(401, { ok: false, error: { code: 'invalid_token', message: 'token not found or expired' } })
  if (Date.now() - session.createdAt > tokenTtlMs()) {
    session.destroy(); sessions.delete(token)
    return send(401, { ok: false, error: { code: 'invalid_token', message: 'token expired' } })
  }

  // Auth logout
  if (path === 'auth/logout') {
    session.destroy(); sessions.delete(token)
    return send(200, { ok: true })
  }

  // API endpoints：转发给这个 token 的 bot 子进程
  const name = path.replace('/', '_') // e.g. window/view -> window_view
  const r = await session.call(name, args)
  res.writeHead(r.status, { 'content-type': 'application/json' })
  res.end(r.json)
}

// Cleanup expired sessions periodically
function sweep () {
  const now = Date.now()
  for (const [token, session] of sessions) {
    if (now - session.createdAt > tokenTtlMs()) {
      session.destroy(); sessions.delete(token)
      log('EXPIRED', session.username)
    }
  }
  for (const [ip, until] of loginBlocked) if (until <= now) loginBlocked.delete(ip)
  for (const [ip, rec] of loginFails) if (now - rec.windowStart > LOGIN_WINDOW_MS) loginFails.delete(ip)
  loginAttempts = loginAttempts.filter(t => now - t < LOGIN_WINDOW_MS)
}

function start () {
  const server = http.createServer(handleRequest)
  server.listen(config.http.port, config.http.host, () => log('Multi-instance API listening on', config.http.host + ':' + config.http.port))
  // Windows 上 localhost 先解析成 ::1。只监听 IPv4 时，客户端用 http://localhost:... 每建一个新连接都要先在 ::1 上白等
  // （Node 20+ fetch 约 250 ms 才回落到 IPv4，Python urllib / requests 约 2 s）。监听回环或全部地址时顺带监听 ::1。
  if (['127.0.0.1', '0.0.0.0', 'localhost'].includes(config.http.host)) {
    const v6 = http.createServer(handleRequest)
    v6.on('error', e => log('IPv6 loopback listener not started:', e.code || e.message))
    v6.listen({ port: config.http.port, host: '::1', ipv6Only: true }, () => log('Also listening on [::1]:' + config.http.port + ' (so http://localhost works without the IPv6 fallback delay)'))
  }
  setInterval(sweep, 60000).unref()
  log('Server started, waiting for logins...')
  return server
}

module.exports = { configure, start }
