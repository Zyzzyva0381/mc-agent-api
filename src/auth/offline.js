'use strict'
// 离线模式（online-mode=false 的服务器）：任何合法用户名都能进服，所以 API 这一层必须自己设门槛。
//
//   "auth": { "type": "offline", "password": "共享口令", "allowedUsernames": ["Agent_1", "Agent_2"] }
//
// - password：所有账号共用的 API 口令；不设则不校验（只适合本机自测，启动时会警告）；
// - allowedUsernames：可选白名单。
const crypto = require('crypto')
const { ApiError } = require('../session')

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/

function offlineUuid (name) {
  // 与原版离线 UUID 相同的算法：md5("OfflinePlayer:" + name)，version 3
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest()
  h[6] = (h[6] & 0x0f) | 0x30
  h[8] = (h[8] & 0x3f) | 0x80
  return h.toString('hex')
}

function safeEqual (a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function create (opts) {
  const allowed = Array.isArray(opts.allowedUsernames) ? new Set(opts.allowedUsernames) : null
  if (!opts.password) console.warn('[auth/offline] no auth.password set: anyone who can reach the API can spawn bots')
  return {
    name: 'offline',
    async authenticate ({ username, password }) {
      if (!NAME_RE.test(username)) throw new ApiError('invalid_credentials', 'username must be 3-16 characters of A-Z a-z 0-9 _')
      if (allowed && !allowed.has(username)) throw new ApiError('invalid_credentials', 'username not allowed')
      if (opts.password && !safeEqual(password || '', opts.password)) throw new ApiError('invalid_credentials', 'wrong password')
      return {
        profile: { id: offlineUuid(username), name: username },
        botOptions: { username, auth: 'offline' }
      }
    }
  }
}

module.exports = { create, offlineUuid }
