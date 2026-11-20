#!/usr/bin/env node
'use strict'
// 入口：读配置 → 装配认证与就绪适配器 → 启动 HTTP 服务。
const { loadConfig } = require('./config')
const { createAuthProvider } = require('./auth')
const { readinessFactory } = require('./readiness')
const core = require('./session')
const web = require('./http')

const config = loadConfig(process.argv[2])
const authProvider = createAuthProvider(config)
const createReadiness = readinessFactory(config)

core.configure({ config, createReadiness })
web.configure({ config, authProvider })

// 运行期异常不能拖垮整个多实例服务。初始化错误应使进程以非零状态退出。
process.on('uncaughtException', e => core.log('UNCAUGHT', e && e.stack || e))
process.on('unhandledRejection', e => core.log('UNHANDLED_REJECTION', e && e.stack || e))

core.log(`target ${config.minecraft.host}:${config.minecraft.port} (${config.minecraft.version}), auth=${authProvider.name}, readiness=${createReadiness.adapterName}`)
web.start()
