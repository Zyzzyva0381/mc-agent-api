'use strict'
// 配置：JSON 文件 + 默认值。路径取命令行第一个参数，或环境变量 MC_AGENT_CONFIG，默认 ./config.json。
const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  http: {
    host: '127.0.0.1',
    port: 18900,
    // 部署在反向代理 / Cloudflare Tunnel 后面时设为 true，按 CF-Connecting-IP / X-Forwarded-For 识别客户端
    trustProxyHeaders: false,
    loginRateLimit: { maxFailsPerIp: 10, blockSeconds: 60, maxGlobalPerMinute: 60 }
  },
  minecraft: { host: '127.0.0.1', port: 25565, version: '1.21.11' },
  session: { tokenTtlHours: 24 },
  auth: { type: 'offline' },
  readiness: { type: 'direct' }
}

function merge (base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v
  }
  return out
}

function loadConfig (file) {
  const p = path.resolve(file || process.env.MC_AGENT_CONFIG || 'config.json')
  let user = {}
  if (fs.existsSync(p)) {
    user = JSON.parse(fs.readFileSync(p, 'utf8'))
  } else if (file || process.env.MC_AGENT_CONFIG) {
    throw new Error('config file not found: ' + p)
  }
  const cfg = merge(DEFAULTS, user)
  cfg.baseDir = path.dirname(p)
  if (process.env.MC_AGENT_PORT) cfg.http.port = Number(process.env.MC_AGENT_PORT)
  return cfg
}

module.exports = { loadConfig, DEFAULTS }
