'use strict'
// 代理网络（Velocity / BungeeCord）：bot 先进大厅，自动 /server <后端> 并确认真的切过去了。
//
//   "readiness": {
//     "type": "proxy",
//     "server": "survival",            // 必填：后端名（/server 后面那个）
//     "minAdvancements": 20,           // 收到这么多条 advancement 定义即认为已在后端（大厅通常只有个位数）
//     "rcon": { "host": "10.0.0.6", "port": 25575, "passwordFile": ".rcon-pass" }   // 可选，见下
//   }
//
// 确认信号：
//  - advancement 集合规模：大厅只下发很小的自定义集合，后端下发完整原版树。注意后端可能分几次下发
//    （先 2 条 root，几十秒后才补全），所以单靠它会出现"明明在后端、ready 却一直 false"；
//  - 后端 RCON 的 `list`（可选，推荐）：名字出现在后端玩家列表里就是权威的"在场"。
//    配了 RCON 时，被后端踢回大厅也能在几秒内发现并重新切服。
// 连续 3 次 /server 都不生效（代理与后端状态脱节）会整条连接重登自愈。
const fs = require('fs')
const net = require('net')
const path = require('path')

const RCON_MAX_GAP = 12000

// ---------- 后端在场确认（RCON，进程级单例） ----------
// ready 不能只看 advancement 定义数：后端会把 advancement 树分几次下发
// （先 2 条 root，几十秒后才补 41 条），RCON 的玩家列表才是权威信号。
let rcon = null
function rconClient (opts, baseDir) {
  if (rcon) return rcon
  let pass = opts.password || null
  if (!pass) { try { pass = fs.readFileSync(path.resolve(baseDir, opts.passwordFile || '.rcon-pass'), 'utf8').trim() } catch (e) { console.log('RCON password unavailable:', e.message) } }
  let sock = null; let buf = Buffer.alloc(0); let authed = false; let pending = null; let seq = 0
  let players = new Map(); let pollAt = 0
  const packet = (id, type, body) => {
    const b = Buffer.from(body, 'utf8'); const p = Buffer.alloc(14 + b.length)
    p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(id, 4); p.writeInt32LE(type, 8); b.copy(p, 12)
    return p
  }
  const failAll = err => {
    if (pending) { clearTimeout(pending.timer); const p = pending; pending = null; p.reject(err) }
    if (sock) { try { sock.destroy() } catch (e) {} }
    sock = null; authed = false; buf = Buffer.alloc(0)
  }
  const onData = chunk => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 4) {
      const size = buf.readInt32LE(0)
      if (buf.length < size + 4) break
      const pkt = buf.subarray(4, size + 4); buf = buf.subarray(size + 4)
      const id = pkt.readInt32LE(0)
      if (!authed) {
        if (id === -1) { failAll(new Error('rcon auth failed')); return }
        authed = true
        if (pending) sock.write(packet(++seq, 2, pending.command))
        continue
      }
      if (pending) { clearTimeout(pending.timer); const p = pending; pending = null; p.resolve(pkt.subarray(8).toString('utf8').replace(/\0+$/, '')) }
    }
  }
  const command = (cmd, timeout = 2500) => new Promise((resolve, reject) => {
    if (!pass) return reject(new Error('rcon password unavailable'))
    if (pending) return reject(new Error('rcon busy'))
    if (!sock) {
      sock = net.connect({ host: opts.host, port: opts.port || 25575 })
      buf = Buffer.alloc(0); authed = false
      const s = sock
      s.on('connect', () => s.write(packet(0, 3, pass)))
      s.on('data', onData)
      s.on('error', e => failAll(e))
      s.on('close', () => failAll(new Error('rcon closed')))
    }
    const timer = setTimeout(() => failAll(new Error('rcon timeout')), timeout)
    pending = { resolve, reject, timer, command: cmd }
    if (authed && sock) sock.write(packet(++seq, 2, cmd))
  })
  const poll = async () => {
    try {
      const out = await command('list')
      const m = /online:\s*(.*)$/.exec(out.trim())
      const names = m && m[1] ? m[1].split(',').map(x => x.trim()).filter(Boolean) : []
      const now = Date.now()
      players = new Map(names.map(n => [n, now])); pollAt = now
    } catch (e) {
      if (pollAt && Date.now() - pollAt > 60000) players = new Map()
    }
  }
  setInterval(poll, 3000).unref()
  poll()
  rcon = {
    has (name) {
      if (!name || !pollAt || Date.now() - pollAt > RCON_MAX_GAP) return false
      const t = players.get(name)
      return !!t && Date.now() - t <= RCON_MAX_GAP
    },
    fresh () { return !!pollAt && Date.now() - pollAt <= RCON_MAX_GAP }
  }
  return rcon
}

function create (s, opts, config) {
  if (!opts.server) throw new Error('readiness.proxy needs "server" (the backend name used with /server)')
  const server = opts.server
  const minAdv = opts.minAdvancements || 20
  const backend = opts.rcon ? rconClient(opts.rcon, config.baseDir) : { has: () => false, fresh: () => false }
  let onServer = false
  let switchRequestedAt = 0
  let switchAttempts = 0
  let lastSwitchAt = 0
  let switchTimer = null
  let guardTimer = null

  const name = () => s.bot && s.bot.username
  const confirm = via => {
    if (onServer) return
    onServer = true; switchRequestedAt = 0; switchAttempts = 0
    s.log('GUARD confirmed ' + server + ' via ' + via)
    s.pushEvent('server_confirmed', { server, via })
  }
  // 安排一次 /server：同一时间只有一个定时器，两次尝试至少间隔 8 秒
  const requestSwitch = (delay = 0) => {
    if (switchTimer) return
    switchTimer = setTimeout(() => {
      switchTimer = null
      if (!s.bot || onServer) return
      const wait = 8000 - (Date.now() - lastSwitchAt)
      if (wait > 0) return requestSwitch(wait)
      lastSwitchAt = switchRequestedAt = Date.now()
      switchAttempts++
      s.log('GUARD sending /server ' + server + ' (attempt ' + switchAttempts + ')')
      try { s.bot.chat('/server ' + server) } catch (e) { s.log('GUARD chat failed', e.message) }
    }, delay)
    if (switchTimer.unref) switchTimer.unref()
  }

  return {
    attach (bot) {
      onServer = false; switchRequestedAt = 0; switchAttempts = 0
      bot._client.on('state', (n, o) => { if (n === 'play' && o === 'configuration') s.log('GUARD note: backend switch transition') })
      bot.on('spawn', () => setTimeout(() => requestSwitch(0), 1500))
      bot.on('messagestr', m => {
        if (!switchRequestedAt || Date.now() - switchRequestedAt > 8000) return
        s.log('GUARD chat:', m.replace(/\s+/g, ' ').slice(0, 200))
        // "already connected"：可能本来就在后端，也可能是被踢回大厅的瞬间 proxy 还挂着旧服务器
        if (/already connected|已经连接|已连接/i.test(m)) {
          if (backend.has(name())) return confirm('rcon')
          s.log('GUARD note: already on target server, waiting for advancement set')
          switchRequestedAt = 0
          requestSwitch(12000)
        }
      })
      // 心跳看守：不在后端就定期重发 /server；连续 3 次不生效就整条连接重登
      if (guardTimer) clearInterval(guardTimer)
      guardTimer = setInterval(() => {
        if (!s.bot) return
        const on = backend.has(name())
        if (!onServer && on) confirm('rcon')
        if (onServer && !on && backend.fresh()) {
          s.log('GUARD RCON says not on backend, re-switching')
          onServer = false; switchRequestedAt = 0; switchAttempts = 0
          requestSwitch(1000)
          return
        }
        if (onServer) return
        if (switchAttempts >= 3 && !on) s.hardReconnect('server switch not taking effect')
        else requestSwitch(0)
      }, 5000)
    },
    isReady () {
      if (!onServer && backend.has(name())) confirm('rcon')
      return onServer
    },
    // 大厅只下发很小的自定义 advancement 集合，后端下发完整原版树：这是唯一可靠的服务器身份信号
    onAdvancements (p) {
      const size = s.advancementDefinitions.size
      if (size >= minAdv) return confirm('advancements')
      if (p.reset && size <= 5) {
        if (backend.has(name())) { s.log('GUARD small advancement reset ignored, RCON says on backend'); return }
        const was = onServer
        onServer = false; switchRequestedAt = 0; switchAttempts = 0
        if (was) s.log('GUARD detected lobby advancement set (bounced back)')
        requestSwitch(2000)
      }
    },
    onConnectWhileNotReady () {
      requestSwitch(0)
      return { resent_server_switch: true }
    },
    onEnd () {
      onServer = false; switchRequestedAt = 0; switchAttempts = 0
      if (guardTimer) { clearInterval(guardTimer); guardTimer = null }
    },
    destroy () {
      if (switchTimer) { clearTimeout(switchTimer); switchTimer = null }
      if (guardTimer) { clearInterval(guardTimer); guardTimer = null }
    }
  }
}

module.exports = { create }
