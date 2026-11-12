'use strict'
// 认证适配器。接口：
//
//   { name, authenticate({ username, password }) -> Promise<{ profile: { id, name }, botOptions }> }
//
// - profile.id 用来保证"同一角色只有一个 bot 在线"（新登录会顶掉旧 session）；
// - botOptions 原样展开进 mineflayer.createBot()（username / auth / session / sessionServer / agent ...）；
// - 失败时抛 ApiError：invalid_credentials / rate_limited / no_profile / auth_error。
//
// 内置：offline（离线模式服务器）、yggdrasil（authlib-injector / Blessing Skin 等外置登录）。
// 也可以写自己的：config.auth.module 指向一个导出 create(authConfig, config) 的文件。
const path = require('path')

const BUILTIN = {
  offline: () => require('./offline'),
  yggdrasil: () => require('./yggdrasil')
}

function createAuthProvider (config) {
  const a = config.auth || {}
  let mod
  if (a.module) mod = require(path.resolve(config.baseDir, a.module))
  else if (BUILTIN[a.type]) mod = BUILTIN[a.type]()
  else throw new Error(`unknown auth.type ${JSON.stringify(a.type)} (expected ${Object.keys(BUILTIN).join(' / ')} or auth.module)`)
  return mod.create(a, config)
}

module.exports = { createAuthProvider }
