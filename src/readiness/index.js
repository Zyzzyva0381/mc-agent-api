'use strict'
// 就绪判定适配器：回答"bot 现在是否已在目标服务器上、可以执行动作"。
// 内置两种：
//   direct  直连单个服务器，出生（spawn）即就绪（默认）
//   proxy   挂在 Velocity / BungeeCord 后面：自动 /server <后端> 并确认，可选用后端 RCON 做在场确认
// 其它情况（例如用插件消息、计分板、自定义大厅流程判断）写成自定义适配器：
//
//   "readiness": { "module": "./my-readiness.js", ...任意参数 }
//
// 模块导出 create(session, readinessConfig, config)，返回对象：
//   attach(bot)                 必需。每次新建 bot 后调用，在这里挂监听 / 定时器
//   isReady() -> boolean        必需。status.ready 与所有动作接口的总闸（false 时动作返回 wrong_server）
//   onAdvancements(packet)      可选。收到 advancements 包（可用"advancement 树的规模"判断在哪个服）
//   onConnectWhileNotReady()    可选。已连接但未就绪时调用 /connect，可返回额外字段并补救
//   onEnd(reason)               可选。连接断开
//   destroy()                   可选。session 销毁
// 适配器可用 session.pushEvent(type, data) 发事件、session.hardReconnect(reason) 整条连接重登、
// session.log(...) 写日志。参考实现见 docs/ADAPTERS.md。
const path = require('path')

const BUILTIN = {
  direct: () => require('./direct'),
  proxy: () => require('./proxy')
}

function readinessFactory (config) {
  const r = config.readiness || {}
  let mod
  if (r.module) mod = require(path.resolve(config.baseDir, r.module))
  else if (BUILTIN[r.type]) mod = BUILTIN[r.type]()
  else throw new Error(`unknown readiness.type ${JSON.stringify(r.type)} (expected ${Object.keys(BUILTIN).join(' / ')} or readiness.module)`)
  const factory = session => mod.create(session, r, config)
  factory.adapterName = r.module ? path.basename(r.module) : r.type
  return factory
}

module.exports = { readinessFactory }
