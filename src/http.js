'use strict'
// HTTP 层：路由、Bearer token、登录限流、动作锁与 stop_on。业务逻辑全部在 session.js。
const http = require('http')
const crypto = require('crypto')
const { Session, sessions, api, READONLY, ApiError, fmt, log } = require('./session')

let config = null
let authProvider = null
const tokenTtlMs = () => config.session.tokenTtlHours * 60 * 60 * 1000

function configure (opts) {
  config = opts.config
  authProvider = opts.authProvider
  const rl = config.http.loginRateLimit || {}
  if (rl.maxFailsPerIp) LOGIN_MAX_FAILS_PER_IP = rl.maxFailsPerIp
  if (rl.blockSeconds) LOGIN_BLOCK_MS = rl.blockSeconds * 1000
  if (rl.maxGlobalPerMinute) LOGIN_MAX_GLOBAL_PER_MIN = rl.maxGlobalPerMinute
}

// ---------- /auth/login 限流 ----------
// 口径：同一 IP 每分钟最多 N 次失败，超了锁一段时间；全局每分钟最多 M 次尝试，
// 免得把上游认证服务（皮肤站等）打爆。部署在反向代理 / 隧道后面时，打开
// http.trustProxyHeaders，按 CF-Connecting-IP / X-Forwarded-For 区分客户端。
const LOGIN_WINDOW_MS = 60 * 1000
let LOGIN_MAX_FAILS_PER_IP = 10
let LOGIN_BLOCK_MS = 60 * 1000
let LOGIN_MAX_GLOBAL_PER_MIN = 60
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
  if (loginAttempts.length >= LOGIN_MAX_GLOBAL_PER_MIN) {
    return { blocked: true, retry: 30, reason: 'global' }
  }
  loginAttempts.push(now)
  return { blocked: false }
}

function noteLoginFailure (ip) {
  const now = Date.now()
  const rec = loginFails.get(ip)
  if (!rec || now - rec.windowStart > LOGIN_WINDOW_MS) {
    loginFails.set(ip, { count: 1, windowStart: now })
    return
  }
  rec.count++
  if (rec.count >= LOGIN_MAX_FAILS_PER_IP) {
    loginBlocked.set(ip, now + LOGIN_BLOCK_MS)
    loginFails.delete(ip)
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

  // Read body
  let body = ''
  for await (const c of req) body += c
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
        if (old.profile.id === profile.id) { log('REPLACE', profile.name); old.destroy() }
      }
      const token = crypto.randomBytes(32).toString('hex')
      const session = new Session(token, username, profile, botOptions)
      sessions.set(token, session)
      noteLoginSuccess(ip)
      log('LOGIN', username, '->', profile.name, 'from', ip)
      // Auto-connect after login
      session.connect()
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
    session.destroy()
    return send(401, { ok: false, error: { code: 'invalid_token', message: 'token expired' } })
  }

  // Auth logout
  if (path === 'auth/logout') {
    session.destroy()
    return send(200, { ok: true })
  }

  // API endpoints
  const name = path.replace('/', '_') // e.g. find_blocks stays, move_to stays
  if (!api[name]) return send(404, { ok: false, error: { code: 'unknown_api', path } })

  // Action guards
  if (!READONLY.has(name)) {
    if (!session.isReady() && name !== 'connect') return send(200, { ok: false, error: { code: 'wrong_server', message: 'bot is not ready on the target server' } })
    if (!session.alive && name !== 'connect') return send(200, { ok: false, error: { code: 'dead', message: 'bot is dead, waiting for respawn' } })
    if (session.busy) return send(200, { ok: false, error: { code: 'busy', message: `running ${session.busy.name}` } })
    session.busy = { name, t: Date.now() }
    const defaults = name === 'attack' || name === 'shoot' ? ['death'] : ['hurt', 'death']
    session.activeStopOn = Array.isArray(args.stop_on) ? [...args.stop_on, 'death'] : defaults
    session.interruptedBy = null
  }

  const t0 = Date.now()
  const isAction = !READONLY.has(name)
  try {
    const result = await api[name](session, args)
    if (isAction && session.interruptedBy) {
      if (session.interruptedBy !== 'death' && result && Object.keys(result).length) result.interrupted_by = session.interruptedBy
      else throw new ApiError(session.interruptedBy === 'death' ? 'dead' : 'interrupted', `stopped because of ${session.interruptedBy}`)
    }
    session.log('API', name, 'OK', Date.now() - t0 + 'ms')
    send(200, { ok: true, ms: Date.now() - t0, result })
  } catch (e) {
    if (isAction && session.bot && (!session.alive || session.bot.health <= 0)) session.interruptedBy = 'death'
    if (isAction && session.interruptedBy && !['interrupted', 'dead'].includes(e.code)) {
      const inner = e
      e = new ApiError(session.interruptedBy === 'death' ? 'dead' : 'interrupted', `stopped because of ${session.interruptedBy} (${inner.message})`)
      e.extra = { ...(inner.extra || {}), ...(inner.code ? { inner_code: inner.code } : {}) }
    }
    if (['interrupted', 'dead'].includes(e.code) && session.bot) e.extra = { ...(e.extra || {}), cause: session.interruptedBy, health: session.bot.health, pos: fmt(session.bot.entity.position), nearest_hostile: session.nearestHostile(24), ...(session.interruptedBy === 'death' ? { death: session.lastDeath } : {}) }
    session.log('API', name, 'FAIL', e.code || 'internal', e.message)
    send(200, { ok: false, ms: Date.now() - t0, error: { code: e.code || 'internal', message: e.message, ...(e.extra || {}) } })
  } finally {
    if (!READONLY.has(name)) { session.busy = null; session.activeStopOn = null; session.applyPosture() }
  }
}

// Cleanup expired sessions periodically
function sweep () {
  const now = Date.now()
  for (const [token, session] of sessions) {
    if (now - session.createdAt > tokenTtlMs()) {
      session.destroy()
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
  setInterval(sweep, 60000).unref()
  log('Server started, waiting for logins...')
  return server
}

module.exports = { configure, start }
