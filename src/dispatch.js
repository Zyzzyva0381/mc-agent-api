'use strict'
// 一次 API 调用在 bot 进程里的完整处理：动作锁、就绪 / 死亡守卫、stop_on、错误归一。
// 以前写在 http.js 里；现在每个 bot 跑在自己的子进程（src/worker.js），HTTP 主进程只负责认证和转发。
const { api, READONLY, ApiError, fmt } = require('./session')

// 这些观察接口要用到世界 / 实体；重连途中 bot 对象已建好但世界还没装上，以前会报
// internal "Cannot read properties of undefined (reading 'getBlock' / 'position')"
const NEED_WORLD = new Set(['get_block', 'find_blocks', 'get_entities', 'inventory'])
const PROXY_WORLD_ENDPOINTS = new Set([...NEED_WORLD, 'advancements', 'posture', 'look'])

function readinessError (session) {
  const state = session.readiness.guardsWorld ? session.readiness.state() : null
  if (state === 'backend_unavailable') return { code: 'backend_unavailable', message: 'cannot confirm player presence on the target server' }
  if (session.bot && session.readiness.isReady() && !session.worldReady) return { code: 'not_ready', message: 'world is still loading; retry in a moment' }
  return { code: 'wrong_server', message: 'bot is not ready on the target server' }
}

// 返回 { status, body }：status 是 HTTP 状态码，body 是响应 JSON
async function dispatch (session, name, args) {
  if (!Object.hasOwn(api, name)) return { status: 404, body: { ok: false, error: { code: 'unknown_api', path: name } } }
  const isAction = !READONLY.has(name)
  const b = session.bot
  if ((isAction || (session.readiness.guardsWorld && PROXY_WORLD_ENDPOINTS.has(name))) && !session.isReady()) {
    return { status: 200, body: { ok: false, error: readinessError(session) } }
  }
  if (NEED_WORLD.has(name) && b && !(b.entity && b.world && typeof b.blockAt === 'function' && b.inventory)) {
    return { status: 200, body: { ok: false, error: { code: 'not_ready', message: 'bot is (re)connecting, world not loaded yet; retry in a moment' } } }
  }

  // Action guards
  if (isAction) {
    if (!session.alive) return { status: 200, body: { ok: false, error: { code: 'dead', message: 'bot is dead, waiting for respawn' } } }
    if (session.busy) return { status: 200, body: { ok: false, error: { code: 'busy', message: `running ${session.busy.name}` } } }
    session.busy = { name, t: Date.now() }
    // 其它动作开始前先松开 control wait:false 留下的按键（control 自己会处理）
    if (name !== 'control' && name !== 'connect') session.releaseHeld()
    const defaults = name === 'attack' || name === 'shoot' ? ['death'] : ['hurt', 'death']
    session.activeStopOn = Array.isArray(args.stop_on) ? [...args.stop_on, 'death'] : defaults
    session.interruptedBy = null
  }

  const t0 = Date.now()
  try {
    const protectAction = session.readiness.guardsWorld && (isAction || name === 'look' || name === 'posture')
    const invoke = () => api[name](session, args)
    const result = await (protectAction ? session.withBackendAction(invoke) : invoke())
    if (isAction && session.interruptedBy) {
      if (session.interruptedBy === 'server_changed') throw new ApiError('interrupted', 'target server verification was lost', { cause: 'server_changed' })
      if (session.interruptedBy !== 'death' && result && Object.keys(result).length) result.interrupted_by = session.interruptedBy
      else throw new ApiError(session.interruptedBy === 'death' ? 'dead' : 'interrupted', `stopped because of ${session.interruptedBy}`)
    }
    session.log('API', name, 'OK', Date.now() - t0 + 'ms')
    return { status: 200, body: { ok: true, ms: Date.now() - t0, result } }
  } catch (e) {
    // 动作进行中 bot 被 /disconnect、踢出或断线：s.bot 变成 null，动作里随后的属性访问会抛 TypeError，
    // 以前报成 internal "Cannot read properties of null (reading 'pathfinder')"
    if (isAction && !session.bot && !e.code) e = new ApiError('not_connected', `bot disconnected while ${name} was running`)
    if (isAction && session.interruptedBy !== 'server_changed' && session.bot && (!session.alive || session.bot.health <= 0)) session.interruptedBy = 'death'
    if (isAction && session.interruptedBy && !['interrupted', 'dead'].includes(e.code)) {
      const inner = e
      e = new ApiError(session.interruptedBy === 'death' ? 'dead' : 'interrupted', `stopped because of ${session.interruptedBy} (${inner.message})`)
      e.extra = { ...(inner.extra || {}), ...(inner.code ? { inner_code: inner.code } : {}) }
    }
    if (['interrupted', 'dead'].includes(e.code) && session.bot?.entity && (!session.readiness.guardsWorld || session.isReady()) && e.extra?.cause !== 'server_changed') e.extra = { ...(e.extra || {}), cause: session.interruptedBy, health: session.bot.health, pos: fmt(session.bot.entity.position), nearest_hostile: session.nearestHostile(24), ...(session.interruptedBy === 'death' ? { death: session.lastDeath } : {}) }
    session.log('API', name, 'FAIL', e.code || 'internal', e.message)
    return { status: 200, body: { ok: false, ms: Date.now() - t0, error: { code: e.code || 'internal', message: e.message, ...(e.extra || {}) } } }
  } finally {
    if (isAction) { session.busy = null; session.activeStopOn = null; session.applyPosture() }
  }
}

module.exports = { dispatch }
