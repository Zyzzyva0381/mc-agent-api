'use strict'
// 主进程这边的"一个登录 = 一个 bot 子进程"（子进程见 worker.js）。
// 子进程意外退出时自动重启（10 分钟内最多 5 次），期间的调用返回 not_connected。
const path = require('path')
const { fork } = require('child_process')
const { log } = require('./session')

const notConnected = message => ({ status: 200, json: JSON.stringify({ ok: false, error: { code: 'not_connected', message } }) })

class BotProcess {
  constructor ({ token, username, profile, botOptions, configPath }) {
    this.token = token
    this.username = username
    this.profile = profile
    // 认证适配器给的 HTTP agent 不能跨进程传，子进程里由 prepareBotOptions 补回
    const { agent, ...rest } = botOptions || {}
    this.botOptions = rest
    this.configPath = configPath
    this.createdAt = Date.now()
    this.pending = new Map()
    this.seq = 0
    this.destroyed = false
    this.restarts = []
    this.child = null
    this.spawn()
  }

  spawn () {
    const child = fork(path.join(__dirname, 'worker.js'), [], { stdio: 'inherit', serialization: 'advanced' })
    this.child = child
    child.on('message', m => {
      if (!m || m.type !== 'reply') return
      const p = this.pending.get(m.id)
      if (p) { this.pending.delete(m.id); p(m) }
    })
    child.on('error', e => log('BOTPROC', this.username, 'error', e.message))
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      for (const p of this.pending.values()) p(notConnected(`bot process exited (${signal || code})`))
      this.pending.clear()
      if (this.destroyed) return
      const now = Date.now()
      this.restarts = this.restarts.filter(t => now - t < 600000)
      if (this.restarts.length >= 5) { log('BOTPROC', this.username, 'exited', signal || code, '- too many restarts, giving up'); return }
      this.restarts.push(now)
      log('BOTPROC', this.username, 'exited', signal || code, '- restarting in 2 s')
      setTimeout(() => { if (!this.destroyed && !this.child) this.spawn() }, 2000).unref()
    })
    child.send({ type: 'init', configPath: this.configPath, token: this.token, username: this.username, profile: this.profile, botOptions: this.botOptions, createdAt: this.createdAt })
  }

  // 转发一次 API 调用，返回 { status, json }
  call (name, args) {
    const child = this.child
    if (!child || !child.connected) return Promise.resolve(notConnected('bot process is restarting'))
    const id = ++this.seq
    return new Promise(resolve => {
      this.pending.set(id, resolve)
      try { child.send({ type: 'call', id, name, args }) } catch (e) { this.pending.delete(id); resolve(notConnected('bot process unavailable: ' + e.message)) }
    })
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    const child = this.child
    if (!child) return
    try { child.send({ type: 'destroy' }) } catch (e) {}
    setTimeout(() => { try { child.kill('SIGKILL') } catch (e) {} }, 3000).unref()
  }
}

module.exports = { BotProcess }
