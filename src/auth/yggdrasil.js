'use strict'
// Yggdrasil 外置登录（authlib-injector 协议，Blessing Skin 等皮肤站都支持）：
// 用皮肤站账号密码换 accessToken，再用皮肤站的 sessionserver 进服。
//
//   "auth": {
//     "type": "yggdrasil",
//     "authServer": "https://skin.example.com/api/yggdrasil/authserver",
//     "sessionServer": "https://skin.example.com/api/yggdrasil/sessionserver",
//     "hosts": { "skin.example.com": "10.0.0.5" }      // 可选：静态解析（皮肤站在内网时）
//   }
const http = require('http')
const https = require('https')
const dns = require('dns')
const crypto = require('crypto')
const { ApiError } = require('../session')

function makeAgent (proto, hosts) {
  const Agent = proto === 'https:' ? https.Agent : http.Agent
  if (!hosts || !Object.keys(hosts).length) return new Agent({ keepAlive: true })
  return new Agent({
    keepAlive: true,
    lookup: (hostname, options, cb) => {
      const ip = hosts[hostname]
      if (ip) {
        const family = ip.includes(':') ? 6 : 4
        if (options && options.all) return cb(null, [{ address: ip, family }])
        return cb(null, ip, family)
      }
      return dns.lookup(hostname, options, cb)
    }
  })
}

function postJson (url, body, agent) {
  const u = new URL(url)
  const lib = u.protocol === 'https:' ? https : http
  const data = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      agent,
      timeout: 15000
    }, res => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('timeout', () => req.destroy(new Error('auth server timeout')))
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function create (opts) {
  if (!opts.authServer || !opts.sessionServer) throw new Error('auth.yggdrasil needs authServer and sessionServer')
  const authBase = opts.authServer.replace(/\/+$/, '')
  const sessionServer = opts.sessionServer.replace(/\/+$/, '')
  const authAgent = makeAgent(new URL(authBase).protocol, opts.hosts)
  const sessionAgent = makeAgent(new URL(sessionServer).protocol, opts.hosts)
  return {
    name: 'yggdrasil',
    // bot 跑在子进程里：主进程传过来的 botOptions 不带 agent（不能跨进程），在这里补回
    prepareBotOptions (opts) { return { ...opts, agent: sessionAgent } },
    async authenticate ({ username, password, profile: requestedProfile }) {
      if (!password) throw new ApiError('bad_args', 'password required')
      const clientToken = crypto.randomUUID()
      async function request (endpoint, body) {
        let res
        try {
          res = await postJson(authBase + endpoint, body, authAgent)
        } catch (e) {
          throw new ApiError('auth_error', e.message)
        }
        let r
        try { r = JSON.parse(res.text) } catch (e) { throw new ApiError('auth_error', 'failed to parse auth response') }
        if (!r || typeof r !== 'object' || Array.isArray(r)) throw new ApiError('auth_error', 'invalid auth response')
        if (res.status !== 200 || r.error) {
          const msg = r.errorMessage || 'authentication failed'
          throw new ApiError(/too frequent|too many/i.test(msg) ? 'rate_limited' : 'invalid_credentials', msg)
        }
        if (!r.accessToken || (r.clientToken !== undefined && r.clientToken !== clientToken)) {
          throw new ApiError('auth_error', 'invalid token in auth response')
        }
        return r
      }
      let r = await request('/authenticate', {
        agent: { name: 'Minecraft', version: 1 }, username, password, clientToken, requestUser: true
      })
      const available = Array.isArray(r.availableProfiles) ? r.availableProfiles : []
      const matches = p => p && (p.name === requestedProfile ||
        (typeof p.id === 'string' && p.id.replace(/-/g, '').toLowerCase() === requestedProfile.replace(/-/g, '').toLowerCase()))
      if (requestedProfile !== undefined && !matches(r.selectedProfile)) {
        const target = available.find(matches)
        if (!target) throw new ApiError('no_profile', 'requested character is not available on this account')
        // Token 必须在认证服务器上绑定角色，不能只替换本地 selectedProfile。
        r = await request('/refresh', {
          accessToken: r.accessToken,
          clientToken,
          selectedProfile: { id: target.id, name: target.name },
          requestUser: true
        })
        if (!r.selectedProfile || r.selectedProfile.id !== target.id || r.selectedProfile.name !== target.name) {
          throw new ApiError('auth_error', 'refresh did not select the requested character')
        }
      }
      const profile = r.selectedProfile || (requestedProfile === undefined && available.length === 1 ? available[0] : null)
      if (!profile) throw new ApiError('no_profile', 'account has no selected character; specify profile to choose one')
      return {
        profile,
        botOptions: {
          username: profile.name,
          auth: 'mojang',
          skipValidation: true,
          session: { accessToken: r.accessToken, clientToken: r.clientToken || clientToken, selectedProfile: profile },
          sessionServer,
          agent: sessionAgent
        }
      }
    }
  }
}

module.exports = { create }
