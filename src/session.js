'use strict'
// 核心引擎：每个登录对应一个独立的 mineflayer bot（Session），以及全部观察 / 动作接口（api）。
// 与具体服务器耦合的部分都在适配器里：认证见 src/auth/，就绪判定见 src/readiness/。
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { AsyncLocalStorage } = require('node:async_hooks')
const { createMotionTracker } = require('./motion')
const { installMovementCompatibility } = require('./movement-compat')

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function sleepInterruptible (s, ms, bot = s.bot) {
  const deadline = Date.now() + Math.max(0, ms)
  while (Date.now() < deadline) {
    if (s.interruptedBy || !s.alive || s.bot !== bot || !s.backendActionIsCurrent()) return false
    await sleep(Math.min(50, deadline - Date.now()))
  }
  return !(s.interruptedBy || !s.alive || s.bot !== bot || !s.backendActionIsCurrent())
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

let config = null
let createReadiness = null
function configure (opts) {
  config = opts.config
  createReadiness = opts.createReadiness
}

// Token -> Session mapping
const sessions = new Map()

class ApiError extends Error {
  constructor(code, message, extra) { super(message); this.code = code; this.extra = extra }
}
const fail = (code, msg, extra) => { throw new ApiError(code, msg, extra) }
const CONNECTION_EVENTS = new Set(['server_confirmed', 'kicked', 'disconnected', 'reconnect', 'reconnect_failed'])
const backendAction = new AsyncLocalStorage()
function requireConnected(s, bot = s.bot) {
  if (s.bot !== bot || !bot?.entity) fail('not_connected', 'bot is no longer connected')
  s.requireBackendAction?.()
  return bot
}

class Session {
  constructor(token, username, profile, botOptions, route) {
    this.token = token
    this.username = username
    this.profile = profile
    this.route = route
    this.backendGeneration = 0
    // 认证适配器给出的 mineflayer.createBot 参数（username / auth / session / sessionServer ...）
    this.botOptions = botOptions
    this.createdAt = Date.now()
    this.bot = null
    this.mcData = null
    this.busy = null
    this.alive = true
    this.lastDeath = null
    this.activeStopOn = null
    this.interruptedBy = null
    this.events = []
    this.seq = 0
    this.advancementDefinitions = new Map()
    this.advancementProgress = new Map()
    this.advancementsReady = false
    this.advancementPackets = 0
    this.advancementsUpdatedAt = null
    // 持久姿态（不占动作锁）：潜行 + 举盾。全量设置语义，见 api.posture
    this.posture = { sneak: false, shield: false, jump: false }
    // /control wait:false 留下的按键：到点自动松开；新的 control、其它动作、stop、死亡都会先松开
    this.heldControl = null
    // 正在使用物品的时长统计（status.using_item）
    this.usingItem = null
    // 连接自愈（hardReconnect）：适配器发现连接与服务器状态脱节时，可以要求整条连接重登
    this.reconnectPending = false
    this.reconnectTimer = null
    this.lastReconnectAt = 0
    this.reconnectCount = 0
    this.destroyed = false
    // 就绪判定适配器：决定"bot 是否已在目标服务器上、可以执行动作"，见 src/readiness/
    this.readiness = createReadiness(this)
  }

  // 动作接口的总闸：连着、且就绪适配器确认已在目标服务器
  isReady () {
    return !!this.bot && !!this.worldReady && !!this.readiness.isReady()
  }

  withBackendAction (perform) {
    return backendAction.run({ session: this, generation: this.backendGeneration }, async () => {
      try { return await perform() } finally { this.requireBackendAction() }
    })
  }

  backendActionIsCurrent () {
    const action = backendAction.getStore()
    return action?.session !== this || (action.generation === this.backendGeneration && this.readiness.isReady())
  }

  requireBackendAction () {
    if (!this.backendActionIsCurrent()) fail('interrupted', 'target server verification was lost', { cause: 'server_changed' })
  }

  onBackendConfirmed () {
    if (!this.bot?.entity || !this.isReady() || this.spawnEventGen === this.worldGen) return
    this.spawnEventGen = this.worldGen
    this.pushEvent('spawn', { pos: fmt(this.bot.entity.position) })
  }

  hardReconnect (reason) {
    const s = this
    if (s.reconnectPending || s.destroyed || !s.bot) return
    const now = Date.now()
    if (now - s.lastReconnectAt < 60000) return
    if (s.reconnectCount >= 5) {
      s.pushEvent('reconnect_failed', { reason, attempts: s.reconnectCount })
      return
    }
    s.lastReconnectAt = now
    s.reconnectCount++
    s.reconnectPending = true
    s.log('GUARD hard reconnect:', reason)
    s.pushEvent('reconnect', { reason, attempt: s.reconnectCount })
    try { s.bot.quit('resync: ' + reason) } catch (e) { s.bot = null }
  }

  log(...a) { log(`[${this.username}]`, ...a) }

  pushEvent(type, data) {
    if (this.readiness?.guardsWorld && !CONNECTION_EVENTS.has(type) && !this.readiness.isReady()) return
    this.events.push({ seq: ++this.seq, t: Date.now(), type, ...data })
    if (this.events.length > 500) this.events.shift()
  }

  interrupt(cause) {
    if (!this.busy || !this.activeStopOn || !this.activeStopOn.includes(cause)) return
    if (this.interruptedBy && cause !== 'death') return
    this.interruptedBy = cause
    if (!this.bot) return
    this.bot.pathfinder?.setGoal?.(null)
    if (this.bot._client?.state === 'play') {
      try { this.bot.stopDigging() } catch {}
      try { this.bot.deactivateItem() } catch {}
    } else {
      this.bot.usingHeldItem = false
      this.usingItem = null
    }
    this.bot.clearControlStates?.()
    this.applyPosture()
  }

  nearestHostile(radius) {
    if (!this.bot?.entity) return null
    const me = this.bot.entity.position
    const h = Object.values(this.bot.entities).filter(e => e.type === 'hostile' && e.position.distanceTo(me) <= radius)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
    return h && { id: h.id, name: h.name, dist: +h.position.distanceTo(me).toFixed(1) }
  }

  // 动作内部会 clearControlStates / deactivateItem（stop、被打断、切维度），
  // 姿态必须在这之后重放，否则 agent 以为还蹲着，实际已经站起来。
  applyPosture() {
    const b = this.bot
    if (!b || !b.entity) return
    if (this.readiness.guardsWorld && !this.readiness.isReady()) return
    const held = this.heldControl ? this.heldControl.keys : []
    try { b.setControlState('sneak', !!this.posture.sneak || held.includes('sneak')) } catch {}
    try { b.setControlState('jump', !!this.posture.jump || held.includes('jump')) } catch {}
    if (this.posture.shield) { try { b.activateItem(true) } catch {} }
  }

  releaseHeld() {
    const h = this.heldControl
    if (!h) return
    this.heldControl = null
    clearTimeout(h.timer)
    for (const t of h.hitTimers) clearTimeout(t)
    if (this.bot) for (const k of h.keys) { try { this.bot.setControlState(k, false) } catch {} }
    this.applyPosture()
  }

  clearPosture() {
    this.posture.sneak = false
    this.posture.shield = false
    this.posture.jump = false
    if (!this.bot) return
    try { this.bot.setControlState('sneak', false) } catch {}
    try { this.bot.setControlState('jump', false) } catch {}
  }

  onBackendUnconfirmed() {
    this.backendGeneration++
    const b = this.bot
    if (!b) return
    const inPlay = b._client?.state === 'play'
    backendAction.exit(() => {
      this.clearPosture()
      this.releaseHeld()
      if (this.busy) this.interruptedBy = 'server_changed'
      b.pathfinder?.setGoal?.(null)
      if (inPlay) {
        try { b.stopDigging() } catch {}
        try { b.deactivateItem() } catch {}
      } else {
        b.usingHeldItem = false
        this.usingItem = null
      }
      b.clearControlStates?.()
    })
  }

  connect() {
    const s = this
    s.usingItem = null
    s.releaseHeld()
    s.advancementDefinitions.clear()
    s.advancementProgress.clear()
    s.advancementsReady = false
    s.advancementPackets = 0
    s.advancementsUpdatedAt = null
    s.worldReady = false
    s.worldGen = 0
    s.spawnEventGen = -1
    s.lastEntitySpawnAt = 0
    s.bot = mineflayer.createBot({
      host: config.minecraft.host, port: config.minecraft.port, version: config.minecraft.version,
      profilesFolder: false, checkTimeoutInterval: 30000,
      ...s.botOptions
    })
    const worldBot = s.bot
    worldBot.loadPlugin(pathfinder)
    if (worldBot.pathfinder) worldBot.pathfinder.goto = createSafeGoto(worldBot)
    worldBot.once('inject_allowed', () => installMovementCompatibility(worldBot))
    // mineflayer 回显 accepts teleport 用的 teleportId 来自它最后看到的 position 包。
    // Velocity 切后端（play -> configuration -> play）时会漏出一个没有 teleportId 的
    // position 事件，protodef 对 undefined 字段直接跳过，于是序列化出一个"空 body"的
    // serverbound accept_teleportation，服务端解码失败并踢人：
    //   Failed to decode packet 'serverbound/minecraft:accept_teleportation'
    // 这里只放行合法 id。
    //
    // 同一类坑还有"写了协议里不存在的包名"：protodef 不报错，而是静默产出
    // "只有 id 0x00、没有 body" 的帧（1.21.9+ 已删除 player_command，就是这样翻车的）。
    // 所以这里再按协议 packet 映射表把 play 状态的写包拦一道（映射表才是包名全集，
    // packet_* 类型表会漏掉复用公共类型的包，例如 settings）。
    // 按每个协议状态（handshaking/status/login/configuration/play）的 packet 映射表把写包拦一道：
    // 不仅防"写了协议里不存在的包名"，也防 Velocity 切后端进入 configuration 状态时
    // mineflayer 残留回调误发 block_dig 等 play-only 包导致代理报 internal error 踢人。
    const outPacketsByState = new Map()
    try {
      const proto = require('minecraft-data')(s.bot.version || config.minecraft.version).protocol
      for (const [st, spec] of Object.entries(proto || {})) {
        const cont = spec?.toServer?.types?.packet
        const mapperField = Array.isArray(cont?.[1])
          ? (cont[1].find(f => f.type && Array.isArray(f.type) && f.type[0] === 'mapper') || cont[1][0])
          : null
        const mappings = mapperField?.type?.[1]?.mappings
        if (mappings) outPacketsByState.set(st, new Set(Object.values(mappings)))
      }
    } catch (e) {
      s.log('packet table unavailable, outbound name guard disabled:', e.message)
    }
    const client = s.bot._client
    const clientWrite = client.write.bind(client)
    client.write = (name, params) => {
      if (!s.backendActionIsCurrent()) return false
      const allowed = outPacketsByState.get(client.state)
      if (allowed && allowed.size > 0 && !allowed.has(name)) {
        s.log('SKIP unknown outbound packet ' + name + ' (not in ' + (s.bot && s.bot.version) + ' ' + client.state + '.toServer)')
        return false
      }
      if (name === 'teleport_confirm') {
        const id = params && params.teleportId
        if (!Number.isInteger(id) || id < 0) {
          s.log('SKIP invalid teleport_confirm id=' + String(id) + ' state=' + client.state)
          return false
        }
      }
      return clientWrite(name, params)
    }
    // 1.21.11 的座位状态只有 set_passengers 是权威的：服务端把乘客清空时，
    // mineflayer 4.39 不会把 bot.vehicle 置空，于是 dismount 永远报 still riding
    // （实测服务端 RootVehicle 已经是空的）。这里自己同步一次。
    s.bot._client.on('set_passengers', p => {
      const v = s.bot.vehicle
      if (!v || !s.bot.entity) return
      const ids = Array.isArray(p.passengers) ? p.passengers : []
      if (p.entityId === v.id && !ids.includes(s.bot.entity.id)) {
        s.bot.vehicle = null
        try { s.bot.emit('dismount', v) } catch (e) {}
      }
    })
    // 1.21.9+ 的 entity_velocity / spawn_entity 速度字段是 lpVec3，minecraft-protocol 已解成
    // 格/tick，但 mineflayer 4.39 仍按旧协议再乘 1/8000 —— bot 吃到的击退被缩小 8000 倍，
    // 看上去"免疫击退"（实测服务端位置纹丝不动），别的实体的 velocity 也全是 ~0。
    // mineflayer 的内置插件在 inject_allowed（createBot 之后的 setTimeout 0）才注册监听器，
    // 这里要等它之后再挂，才能排在它后面把值改回原样（直接在这里 on 会先跑、再被它覆盖）。
    let lpVelocity = false
    try {
      const t = require('minecraft-data')(s.bot.version || config.minecraft.version).protocol.play.toClient.types
      lpVelocity = JSON.stringify(t.packet_entity_velocity).includes('lpVec3')
    } catch (e) {}
    if (lpVelocity) {
      const fixVelocity = p => {
        const e = s.bot && s.bot.entities[p.entityId]
        if (e && p.velocity) e.velocity.set(p.velocity.x, p.velocity.y, p.velocity.z)
      }
      const bot = s.bot
      bot.once('inject_allowed', () => {
        bot._client.on('entity_velocity', fixVelocity)
        bot._client.on('spawn_entity', fixVelocity)
      })
    }
    // 1.21 的物品组件里，prismarine-item 的 item.enchants 返回 {enchantments:[{id,level}]} 对象而不是
    // [{name,lvl}] 数组；mineflayer 的 digTime 把它交给 prismarine-block 用 for...of 遍历，
    // 手持附魔工具挖任何方块都抛 "enchantments is not iterable"（头盔附魔则被静默忽略）。
    // 照 mineflayer 原实现重写 bot.digTime，附魔改从组件里读并换成它要的格式。
    {
      const bot = s.bot
      const enchList = item => {
        if (!item) return []
        const ex = itemExtras(item).enchantments
        if (ex) return ex.map(e => ({ name: e.name, lvl: e.level }))
        const raw = item.enchants
        return Array.isArray(raw) ? raw : []
      }
      bot.once('inject_allowed', () => {
        bot.digTime = block => {
          const held = bot.heldItem
          const head = bot.inventory.slots[bot.getEquipmentDestSlot('head')]
          return block.digTime(
            held ? held.type : null,
            bot.game.gameMode === 'creative',
            ['water', 'flowing_water'].includes(bot._getBlockAtEyeLevel()?.name),
            !bot.entity.onGround,
            [...enchList(held), ...enchList(head)],
            bot.entity.effects
          )
        }
      })
    }
    s.bot._client.removeAllListeners('add_resource_pack')
    s.bot._client.on('add_resource_pack', async data => {
      s.log('RESOURCE_PACK request', s.bot._client.state, data.uuid)
      for (const result of [3, 4, 0]) {
        if (!s.bot) return
        s.bot._client.write('resource_pack_receive', { uuid: data.uuid, result })
        await sleep(100)
      }
      s.log('RESOURCE_PACK answered loaded')
    })
    s.bot._client.on('state', (n, o) => s.log('STATE', o, '->', n))
    const attrFix = buildAttributeFix(config.minecraft.version)
    s.bot._client.prependListener('entity_update_attributes', p => {
      for (const prop of p.properties) if (attrFix.has(prop.key)) prop.key = attrFix.get(prop.key)
    })
    // 附魔台提示用的是服务器下发的附魔注册表下标，按实际顺序记下来
    s.bot._client.on('registry_data', p => {
      const id = p.codec?.id || p.id || ''
      if (!Array.isArray(p.entries)) return
      if (/enchantment$/.test(id)) enchantRegistryNames = s.enchantRegistry = p.entries.map(e => e.key)
      if (/banner_pattern$/.test(id)) bannerPatternNames = p.entries.map(e => e.key.replace(/^minecraft:/, ''))
      if (/damage_type$/.test(id)) damageTypeNames = p.entries.map(e => e.key)
    })
    // 切石机配方：登录时一次性下发（输入物品 id 集合 -> 产物），界面里的选项就是"输入匹配的配方"按此顺序排列
    s.bot._client.on('declare_recipes', p => {
      if (Array.isArray(p.stoneCutterRecipes)) stonecutterRecipes = p.stoneCutterRecipes.map(r => ({ inputs: r.input && r.input.ids, out: r.slotDisplay && r.slotDisplay.data }))
    })
    // 织布机：不需要图案物品的旗帜图案（tag minecraft:no_item_required）
    s.bot._client.on('tags', p => {
      for (const t of p.tags) if (/banner_pattern$/.test(t.tagType)) {
        const tag = t.tags.find(x => /no_item_required$/.test(x.tagName))
        if (tag) loomFreePatterns = tag.entries
      }
    })
    s.bot.recipeBook = new Map()
    s.bot._client.on('recipe_book_add', p => {
      if (p.replace) s.bot.recipeBook.clear()
      for (const e of p.entries || []) s.bot.recipeBook.set(e.recipe.displayId, e.recipe)
    })
    s.bot._client.on('recipe_book_remove', p => {
      for (const id of p.recipeIds || []) s.bot.recipeBook.delete(id)
    })
    worldBot.on('login', () => { if (s.bot === worldBot && s.bot.recipeBook) s.bot.recipeBook.clear() })
    // Mineflayer itself does not expose advancements, but minecraft-protocol fully parses this packet.
    // The packet is a full reset on login/server switch, followed by incremental definition/progress updates.
    s.bot._client.on('advancements', p => {
      if (s.bot !== worldBot) return
      if (p.reset) {
        s.advancementDefinitions.clear()
        s.advancementProgress.clear()
      }
      for (const { key, value } of p.advancementMapping || []) {
        const d = value.displayData
        s.advancementDefinitions.set(key, {
          id: key,
          parent: value.parentId || null,
          title: advancementComponentText(d && d.title),
          description: advancementComponentText(d && d.description),
          frame: advancementFrame(d && d.frameType),
          hidden: advancementHidden(d && d.flags),
          requirements: Array.isArray(value.requirements)
            ? value.requirements.map(group => Array.isArray(group) ? group.map(String) : [])
            : [],
          recipe: /(^|:)recipes\//.test(key)
        })
      }
      for (const id of p.identifiers || []) {
        s.advancementDefinitions.delete(id)
        s.advancementProgress.delete(id)
      }
      for (const { key, value } of p.progressMapping || []) {
        const criteria = { ...(s.advancementProgress.get(key) || {}) }
        for (const c of value || []) criteria[c.criterionIdentifier] = advancementTime(c.criterionProgress)
        s.advancementProgress.set(key, criteria)
      }
      s.advancementsReady = true
      s.advancementPackets++
      s.advancementsUpdatedAt = Date.now()
      s.log('ADVANCEMENTS', `packet=${s.advancementPackets}`, `reset=${!!p.reset}`, `definitions=${s.advancementDefinitions.size}`)
      if (s.readiness.onAdvancements) s.readiness.onAdvancements(p)
    })
    s.bot.on('login', () => s.log('EV login'))
    s.bot.on('mount', () => {
      s.log('EV mount', s.bot.vehicle && s.bot.vehicle.name)
      s.pushEvent('vehicle', { action: 'mount', name: s.bot.vehicle && s.bot.vehicle.name })
    })
    s.bot.on('dismount', v => s.pushEvent('vehicle', { action: 'dismount', name: v && v.name }))
    s.bot.on('sleep', () => s.pushEvent('sleep', {}))
    s.bot.on('wake', () => s.pushEvent('wake', {}))
    s.bot.on('entityEffect', (e, eff) => {
      if (!s.bot || e !== s.bot.entity || !s.mcData || !eff) return
      s.pushEvent('effect_start', { name: effectName(s, eff.id), level: (eff.amplifier || 0) + 1, duration_s: +((eff.duration || 0) / 20).toFixed(1) })
    })
    s.bot.on('entityEffectEnd', (e, eff) => {
      if (!s.bot || e !== s.bot.entity || !s.mcData || !eff) return
      s.pushEvent('effect_end', { name: effectName(s, eff.id) })
    })
    worldBot.on('spawn', () => {
      const gen = s.worldGen
      setTimeout(() => {
        if (s.bot !== worldBot || gen !== s.worldGen) return
        if (worldBot.vehicle) { const v = worldBot.vehicle; worldBot.vehicle = null; worldBot.emit('dismount', v); s.log('WATCHDOG cleared phantom vehicle', v.name) }
        // 相对位移为 0，保留真实击退速度。
        worldBot._client.emit('position', { teleportId: -1, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: { x: true, y: true, z: true, yaw: true, pitch: true, dx: false, dy: false, dz: false } })
      }, 4000).unref()
    })
    s.bot.once('spawn', () => {
      // 保持与原版服务端一致的 0.3 半宽（0.6 碰撞箱）；配合 movement-compat 里的 1e-7 碰撞容差，
      // 既防 IEEE-754 穿墙，又避免 0.3001 在服务端贴墙坐标（wall±0.3）下把垂直墙面当脚底导致半空浮空。
      s.bot.physics.playerHalfWidth = 0.3
      s.mcData = require('minecraft-data')(s.bot.version)
      patchBrokenPickaxeMaterials(s.mcData)
      patchBrokenPickaxeMaterials(s.bot.registry)
      s.bot.pathfinder.goto = createSafeGoto(s.bot)
      s.bot.pathfinder.bestHarvestTool = block => selectBestHarvestTool(s.bot, block)
      s.bot.pathfinder.setMovements(createMovements(s.bot))
      // 4 s 思考上限（20 ms/tick 约合 1.6 s 纯 A* 算力，足够覆盖 128 格视距），
      // 避免不可达目标白算 15 s 触发 8 s stalled 看门狗或拖死 allow_partial
      s.bot.pathfinder.thinkTimeout = 4000
      // 每个物理 tick（50 ms）里寻路最多算 20 ms：所有 bot 同时寻路时不至于把 CPU 吃满、拖慢别的请求
      s.bot.pathfinder.tickTimeout = 20
      s.log('SPAWN', fmt(s.bot.entity.position))
    })
    // ready 还要等周围的区块和实体到齐：服务端先发区块、再陆续发实体，
    // 以前 ready 一变 true 就调 get_entities 常常拿到 []。每次（重新）进入一个后端世界都重新等：
    // 区块到齐（最多 8 s）后，再等到 600 ms 内没有新实体出现（最多再 3 s）。
    worldBot.on('entitySpawn', () => { if (s.bot === worldBot) s.lastEntitySpawnAt = Date.now() })
    // 死亡重生、切维度走的是 respawn 包（不是 login），之前 ready 一直是 true，
    // 换完世界后约 0.25 s 内 get_block 会 not_loaded、get_entities 为空
    let hasSpawned = false
    let waitingGen = -1
    let positionedGen = -1
    const maybeEnablePhysics = () => {
      if (s.bot !== worldBot || worldBot.physicsEnabled || positionedGen !== s.worldGen) return
      if (hasLocalPhysicsChunks(worldBot)) worldBot.physicsEnabled = true
    }
    const resetWorld = () => {
      if (s.bot !== worldBot) return
      s.worldReady = false
      s.worldGen++
      positionedGen = -1
      worldBot.physicsEnabled = false
    }
    for (const ev of ['login', 'respawn']) worldBot.on(ev, resetWorld)
    worldBot._client.on('state', (state, previous) => { if (previous === 'play' && state !== 'play') resetWorld() })
    worldBot.on('chunkColumnLoad', maybeEnablePhysics)
    const waitForWorld = async () => {
      if (s.bot !== worldBot || s.worldReady || waitingGen === s.worldGen) return
      const gen = s.worldGen
      waitingGen = gen
      const t0 = Date.now()
      try { await withTimeout(worldBot.waitForChunksToLoad(), 8000, 'chunk load') } catch (e) {}
      // 旧世界的异步回调不能提前开启新世界的物理。
      if (s.bot !== worldBot || gen !== s.worldGen) return
      worldBot.physicsEnabled = true
      const t1 = Date.now()
      await sleep(300)
      while (Date.now() - t1 < 3000 && Date.now() - s.lastEntitySpawnAt < 600) await sleep(100)
      if (s.bot !== worldBot || gen !== s.worldGen || s.worldReady) return
      if (worldBot.isAlive && worldBot.health > 0) s.alive = true
      s.worldReady = true
      s.log('WORLD ready after', Date.now() - t0, 'ms, entities', Object.keys(worldBot.entities).length - 1)
      if (s.readiness.guardsWorld) s.onBackendConfirmed()
    }
    worldBot.on('spawn', () => {
      hasSpawned = true
      maybeEnablePhysics()
      void waitForWorld()
    })
    // 收到服务端真实 position 后，只要脚下局部区块加载完成就立即恢复物理重力，
    // 避免等 5x5 全区块（3.5~8s）期间 physicsEnabled=false 导致人物悬空被踢 "floating too long"。
    // Velocity 切服可能只有 login 和位置同步，Mineflayer 不一定再次触发 spawn。
    worldBot._client.on('position', ({ teleportId }) => {
      if (s.bot !== worldBot || worldBot._client.state !== 'play') return
      if (!Number.isInteger(teleportId) || teleportId < 0) return
      positionedGen = s.worldGen
      maybeEnablePhysics()
      if (!hasSpawned || s.worldReady || waitingGen === s.worldGen) return
      if (worldBot.supportFeature('sendsPlayerLoadedPacket')) worldBot._client.write('player_loaded', {})
      void waitForWorld()
    })
    // 被别的实体挤开：原版里这是客户端自己算的（服务端只推生物，不推玩家），
    // prismarine-physics 没实现，bot 就成了推不动的柱子。照原版 Entity.push 每 tick 加一点水平速度。
    const NOT_PUSHABLE = new Set(['item', 'experience_orb', 'marker', 'area_effect_cloud',
      'item_frame', 'glow_item_frame', 'painting', 'leash_knot', 'end_crystal', 'evoker_fangs', 'lightning_bolt',
      'block_display', 'item_display', 'text_display', 'interaction', 'falling_block', 'tnt', 'fishing_bobber'])
    const LIVING_TYPES = new Set(['player', 'mob', 'hostile', 'passive', 'animal', 'ambient', 'water_creature', 'living'])
    const pushable = e => !NOT_PUSHABLE.has(e.name) && (LIVING_TYPES.has(e.type) || /boat|raft|minecart/.test(e.name || ''))
    s.motion = createMotionTracker()
    // physicsTick 只在物理开着时触发：传送、骑乘上下车之后从头算，免得把一段跳变当成速度
    for (const ev of ['forcedMove', 'mount', 'dismount', 'respawn']) s.bot.on(ev, () => s.motion && s.motion.reset())
    s.bot.on('physicsTick', () => { if (s.bot && s.bot.entity && s.motion) s.motion.tick(s.bot.entity.position) })
    s.bot.on('physicsTick', () => {
      const bot = s.bot
      const me = bot && bot.entity
      if (!me || !bot.physicsEnabled || bot.vehicle || bot.isSleeping || bot.game.gameMode === 'spectator') return
      const p = me.position
      const h = me.height || 1.8
      for (const id in bot.entities) {
        const e = bot.entities[id]
        if (e === me || !e.position || e.isValid === false || !pushable(e)) continue
        if (e.vehicle === me || (me.passengers || []).includes(e)) continue
        const reach = 0.3 + (e.width || 0.6) / 2
        let dx = e.position.x - p.x
        let dz = e.position.z - p.z
        if (Math.abs(dx) >= reach || Math.abs(dz) >= reach) continue
        if (e.position.y >= p.y + h || e.position.y + (e.height || 1.8) <= p.y) continue
        let f = Math.max(Math.abs(dx), Math.abs(dz))
        if (f < 0.01) continue
        f = Math.sqrt(f)
        const g = Math.min(1, 1 / f) * 0.05
        dx = dx / f * g
        dz = dz / f * g
        me.velocity.x -= dx
        me.velocity.z -= dz
      }
    })
    if (!s.readiness.guardsWorld) s.bot.on('spawn', () => s.pushEvent('spawn', { pos: fmt(s.bot.entity.position) }))
    s.bot.on('messagestr', (m, pos) => {
      if (pos === 'game_info') return
      if (s.readiness.guardsWorld && !s.readiness.isReady()) return
      const text = m.replace(/\s+/g, ' ').trim()
      if (s.lastDeath && !s.lastDeath.cause && Date.now() - s.lastDeath.t < 3000 && text.startsWith(s.bot.username + ' ')) s.lastDeath.cause = text
      s.pushEvent('chat', { text: text.slice(0, 300) })
    })
    s.bot.on('death', () => {
      s.alive = false
      if (s.readiness.guardsWorld && !s.readiness.isReady()) return
      s.lastDeath = { pos: fmt(s.bot.entity.position), t: Date.now(), dropped_items_at: fmt(s.bot.entity.position) }
      s.pushEvent('death', s.lastDeath); s.releaseHeld(); s.interrupt('death')
      s.clearPosture()
    })
    s.bot.on('spawn', () => { s.alive = true })
    let lastHealth
    // 服务端每次扣血前发 damage_event（1.19.4+），带 damage_type 注册表下标和来源实体（id+1，0 = 无）。
    // 记下来挂到 hurt 事件上，免得"被零星伤害打断"时无从查起。
    let lastDamage = null
    for (const event of ['login', 'respawn']) worldBot.on(event, () => { lastHealth = undefined; lastDamage = null })
    s.bot._client.on('damage_event', p => {
      if (!s.bot || !s.bot.entity || p.entityId !== s.bot.entity.id) return
      if (s.readiness.guardsWorld && !s.readiness.isReady()) return
      const causeId = (p.sourceCauseId || 0) - 1
      const cause = causeId >= 0 ? s.bot.entities[causeId] : null
      lastDamage = {
        t: Date.now(),
        source: (damageTypeNames && damageTypeNames[p.sourceTypeId] || `#${p.sourceTypeId}`).replace(/^minecraft:/, ''),
        ...(cause ? { source_entity: { id: cause.id, name: cause.name || cause.username } } : {})
      }
    })
    s.bot.on('health', () => {
      if (s.bot.health < lastHealth) {
        const attacker = s.nearestHostile(16)
        const dmg = lastDamage && Date.now() - lastDamage.t < 1500 ? lastDamage : null
        lastDamage = null
        s.pushEvent('hurt', { health: +s.bot.health.toFixed(1), damage: +(lastHealth - s.bot.health).toFixed(1), ...(dmg ? { source: dmg.source, ...(dmg.source_entity ? { source_entity: dmg.source_entity } : {}) } : {}), ...(attacker ? { likely_attacker: attacker } : {}) })
        s.interrupt('hurt')
      }
      lastHealth = s.bot.health
    })
    s.bot.on('playerCollect', (collector, item) => {
      if (collector !== s.bot.entity) return
      const it = item.getDroppedItem && item.getDroppedItem()
      if (it) s.pushEvent('pickup', { item: it.name, count: it.count })
    })
    s.bot.on('kicked', r => { s.log('KICKED', JSON.stringify(r)); s.pushEvent('kicked', { reason: JSON.stringify(r).slice(0, 300) }) })
    s.bot.on('error', e => s.log('ERROR', e.message))
    s.bot.on('end', r => {
      if (s.bot !== worldBot) return
      s.log('END', r)
      s.pushEvent('disconnected', { reason: r })
      s.bot = null
      s.usingItem = null
      s.releaseHeld()
      s.clearPosture()
      if (s.readiness.onEnd) s.readiness.onEnd(r)
      if (s.reconnectPending && !s.destroyed) {
        s.reconnectPending = false
        if (s.reconnectTimer) clearTimeout(s.reconnectTimer)
        s.reconnectTimer = setTimeout(() => {
          s.reconnectTimer = null
          if (s.bot || s.destroyed) return
          s.log('GUARD reconnecting after resync')
          s.connect()
        }, 3000)
        if (s.reconnectTimer.unref) s.reconnectTimer.unref()
      }
    })
    s.readiness.attach(s.bot)
  }

  destroy() {
    this.destroyed = true
    this.reconnectPending = false
    this.usingItem = null
    this.releaseHeld()
    if (this.readiness.destroy) this.readiness.destroy()
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.bot) this.bot.quit()
    sessions.delete(this.token)
    this.log('session destroyed')
  }
}

function buildAttributeFix(version) {
  const data = require('minecraft-data')(version)
  const mapper = data.protocol.play.toClient.types.packet_entity_update_attributes[1][1].type[1].type[1][0].type[1].mappings
  const fix = new Map()
  for (const [id, wrongName] of Object.entries(mapper)) {
    const right = data.attributesArray[+id]
    if (right) fix.set(wrongName, right.resource)
  }
  for (const [id, a] of data.attributesArray.entries()) if (!(id in mapper)) fix.set(String(id), a.resource)
  return fix
}

const fmt = p => p && [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)]
const vec = a => new Vec3(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z))

// 1.21 advancement titles/descriptions are encoded as NBT chat components.
// Return literal text when present, otherwise the stable translation key.
function unwrapNbt(v) {
  if (v == null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(unwrapNbt)
  if (Object.prototype.hasOwnProperty.call(v, 'type') && Object.prototype.hasOwnProperty.call(v, 'value')) {
    if (v.type === 'list' && v.value && Array.isArray(v.value.value)) return v.value.value.map(unwrapNbt)
    return unwrapNbt(v.value)
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrapNbt(x)]))
}

function advancementComponentText(component) {
  const c = unwrapNbt(component)
  if (c == null) return null
  if (typeof c === 'string' || typeof c === 'number') return String(c)
  if (Array.isArray(c)) return c.map(advancementComponentText).filter(Boolean).join('') || null
  const own = c.text != null ? String(c.text) : (c.translate != null ? String(c.translate) : null)
  const extra = Array.isArray(c.extra) ? c.extra.map(advancementComponentText).filter(Boolean).join('') : ''
  return own != null ? own + extra : null
}

function advancementFrame(frame) {
  if (frame == null) return null
  if (typeof frame === 'string') return frame
  return ['task', 'challenge', 'goal'][frame] || String(frame)
}

function advancementHidden(flags) {
  if (flags == null) return false
  if (typeof flags === 'number') return !!(flags & 4)
  return !!flags.hidden
}

// minecraft-protocol represents i64 as [high32, low32] in this packet.
function advancementTime(value) {
  if (value == null) return null
  if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) {
    return value[0] * 0x100000000 + (value[1] >>> 0)
  }
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'object' && Number.isFinite(value.high) && Number.isFinite(value.low)) {
    return value.high * 0x100000000 + (value.low >>> 0)
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : String(value)
}

function advancementResult(def, criteria, includeCriteria) {
  criteria = criteria || {}
  const requirements = def.requirements || []
  const requirementTimes = requirements.map(group => group.map(name => criteria[name]).filter(t => t != null))
  const requirementsDone = requirementTimes.filter(times => times.length).length
  const completed = requirements.length > 0 && requirementsDone === requirements.length
  const allCriterionNames = new Set([...requirements.flat(), ...Object.keys(criteria)])
  const criteriaDone = [...allCriterionNames].filter(name => criteria[name] != null).length
  const inProgress = !completed && criteriaDone > 0
  const result = {
    id: def.id,
    parent: def.parent,
    title: def.title,
    description: def.description,
    frame: def.frame,
    hidden: def.hidden,
    status: completed ? 'completed' : (inProgress ? 'in_progress' : 'not_started'),
    completed_at: completed ? Math.max(...requirementTimes.map(times => Math.min(...times))) : null,
    progress: {
      requirements_done: requirementsDone,
      requirements_total: requirements.length,
      criteria_done: criteriaDone,
      criteria_total: allCriterionNames.size
    },
    requirements
  }
  if (includeCriteria) result.criteria = Object.fromEntries([...allCriterionNames].sort().map(name => [name, criteria[name] ?? null]))
  return result
}

// 1.21 物品组件：附魔是 {id, level}，id 为服务器下发的附魔注册表下标；自定义名称是 NBT 字符串
let enchantRegistryNames = null
let damageTypeNames = null
let bannerPatternNames = null   // 服务器下发的旗帜图案注册表
let loomFreePatterns = null     // 织布机不需要图案物品的图案下标（服务器顺序）
let stonecutterRecipes = null   // [{inputs:[itemId], out:{itemId, itemCount}}]
// 原版 1.21 药水注册表顺序（服务器不下发），药水物品组件里的 potionId 是这里的下标
const POTION_NAMES = ['water', 'mundane', 'thick', 'awkward', 'night_vision', 'long_night_vision', 'invisibility', 'long_invisibility',
  'leaping', 'long_leaping', 'strong_leaping', 'fire_resistance', 'long_fire_resistance', 'swiftness', 'long_swiftness', 'strong_swiftness',
  'slowness', 'long_slowness', 'strong_slowness', 'turtle_master', 'long_turtle_master', 'strong_turtle_master', 'water_breathing',
  'long_water_breathing', 'healing', 'strong_healing', 'harming', 'strong_harming', 'poison', 'long_poison', 'strong_poison',
  'regeneration', 'long_regeneration', 'strong_regeneration', 'strength', 'long_strength', 'strong_strength', 'weakness', 'long_weakness',
  'luck', 'slow_falling', 'long_slow_falling', 'wind_charged', 'weaving', 'oozing', 'infested']
const DYE_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
function itemExtras(i) {
  const out = {}
  if (i.durabilityUsed) out.durability_used = i.durabilityUsed
  const cm = i.componentMap
  if (cm) {
    const ench = cm.get('enchantments') || cm.get('stored_enchantments')
    const list = ench && ench.data && ench.data.enchantments
    if (list && list.length) {
      out.enchantments = list.map(e => ({
        name: (enchantRegistryNames && enchantRegistryNames[e.id] || `#${e.id}`).replace(/^minecraft:/, ''),
        level: e.level
      }))
    }
    const cn = cm.get('custom_name')
    if (cn && cn.data) out.custom_name = typeof cn.data === 'string' ? cn.data : (cn.data.value?.text?.value ?? cn.data.value ?? JSON.stringify(cn.data))
    const pc = cm.get('potion_contents')
    if (pc && pc.data && pc.data.potionId !== undefined && pc.data.potionId !== null) out.potion = POTION_NAMES[pc.data.potionId] || `#${pc.data.potionId}`
    const bp = cm.get('banner_patterns')
    const layers = bp && bp.data && bp.data.layers
    if (layers && layers.length) {
      out.banner_patterns = layers.map(l => ({
        pattern: l.pattern && l.pattern.patternId !== undefined ? (bannerPatternNames && bannerPatternNames[l.pattern.patternId] || `#${l.pattern.patternId}`) : (l.pattern?.data?.assetId || 'custom'),
        color: DYE_COLORS[l.colorId] || `#${l.colorId}`
      }))
    }
  }
  return out
}
const itemSummary = i => i && { name: i.name, count: i.count, slot: i.slot, ...itemExtras(i) }
const invCounts = (bot) => {
  const c = {}
  for (const i of bot.inventory.items()) c[i.name] = (c[i.name] || 0) + i.count
  return c
}

async function withTimeout(promise, ms, what) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new ApiError('timeout', `${what} timed out after ${ms}ms`)), ms) })])
  } finally { clearTimeout(timer) }
}

const EXTRA_AVOID_BLOCKS = ['sweet_berry_bush', 'cactus', 'magma_block', 'campfire', 'soul_campfire', 'powder_snow', 'wither_rose']

function createMovements(bot, { parkour = true, sprint = true } = {}) {
  const m = new Movements(bot)
  m.canDig = false
  m.allow1by1towers = false
  m.allowSprinting = sprint
  m.scafoldingBlocks = []
  m.allowParkour = parkour
  const blocksByName = bot.registry && bot.registry.blocksByName
  if (blocksByName) {
    for (const name of EXTRA_AVOID_BLOCKS) {
      if (blocksByName[name]) m.blocksToAvoid.add(blocksByName[name].id)
    }
  }
  return m
}

// 替换 mineflayer-pathfinder/lib/goto.js 的默认实现：
// 原版先判 results.path.length === 0 再判 status，导致 noPath/timeout 且 path 为空时误当成功，
// 以及 tickTimeout 产生 partial + path:[] 时立刻返回成功却残留 stateGoal 在后台继续乱走。
function createSafeGoto(bot) {
  return function safeGoto(goal, { allowPartial = false } = {}) {
    return new Promise((resolve, reject) => {
      let done = false
      let tickCount = 0
      let partialPending = false
      let partialReason = null
      let partialStartTick = -1

      const makeErr = (name, message) => { const e = new Error(message); e.name = name; return e }
      const finish = (err, val) => {
        if (done) return
        done = true
        bot.removeListener('goal_reached', onReached)
        bot.removeListener('path_update', onUpdate)
        bot.removeListener('goal_updated', onGoalUpdated)
        bot.removeListener('path_stop', onStop)
        bot.removeListener('path_reset', onReset)
        bot.removeListener('physicsTick', onTick)
        setTimeout(() => {
          if (bot.pathfinder && bot.pathfinder.goal === goal) {
            try { bot.pathfinder.setGoal(null) } catch {}
          }
          if (err) reject(err)
          else resolve(val)
        }, 0)
      }

      const onReached = () => finish(null, { reached: true, partial: false })
      const onGoalUpdated = newGoal => {
        if (newGoal !== goal) finish(makeErr('GoalChanged', 'The goal was changed before it could be completed!'))
      }
      const onStop = () => finish(makeErr('PathStopped', 'Path was stopped before it could be completed! Thus, the desired goal was not reached.'))
      const onReset = () => { partialPending = false }
      const onUpdate = results => {
        if (!results) return
        if (results.status === 'partial') {
          partialPending = false
          return
        }
        if (results.status === 'noPath' || results.status === 'timeout') {
          if (allowPartial && Array.isArray(results.path) && results.path.length > 0) {
            partialPending = true
            partialReason = results.status
            partialStartTick = tickCount
            return
          }
          // 清空 results.path，避免 monitorMovement 在本 tick 紧接着把它赋给 path 并走 1 tick
          if (Array.isArray(results.path)) results.path.length = 0
          if (results.status === 'noPath') finish(makeErr('NoPath', 'No path to the goal!'))
          else finish(makeErr('Timeout', 'Took too long to decide path to goal!'))
          return
        }
        if (results.status === 'success' && Array.isArray(results.path) && results.path.length === 0) {
          const p = bot.entity && bot.entity.position
          if (p && (goal.isEnd(p.floored()) || goal.isEnd(p.floored().offset(0, 1, 0)))) {
            finish(null, { reached: true, partial: false })
          }
        }
      }
      const onTick = () => {
        tickCount++
        if (!partialPending || tickCount <= partialStartTick) return
        const pf = bot.pathfinder
        if (pf && !pf.isMoving() && !pf.isMining() && !pf.isBuilding()) {
          finish(null, { reached: false, partial: true, reason: partialReason })
        }
      }

      bot.on('path_stop', onStop)
      bot.on('goal_reached', onReached)
      bot.on('path_update', onUpdate)
      bot.on('goal_updated', onGoalUpdated)
      bot.on('path_reset', onReset)
      bot.on('physicsTick', onTick)
      bot.pathfinder.setGoal(goal)
    })
  }
}

// 精准停位微调：在 pathfinder 进入目标格后用真实物理按键（近距自动潜行防掉崖）收敛到目标点
async function alignToPoint(s, aimX, aimZ, { tol = 0.15, maxMs = 600, stopWhen = null } = {}) {
  const bot = requireConnected(s)
  if (bot.vehicle || !bot.entity || typeof bot.look !== 'function' || typeof bot.setControlState !== 'function') return
  // 若刚跳落还在半空，先等落地（最多 400 ms），避免在空中返回或未着地就测距
  const landBy = Date.now() + 400
  while (Date.now() < landBy && s.bot === bot && bot.entity && !bot.entity.onGround && !bot.entity.isInWater && !bot.entity.isInLava) {
    if (!s.alive || s.interruptedBy || (stopWhen && stopWhen())) break
    await sleep(50)
  }
  requireConnected(s, bot)
  const p0 = bot.entity.position
  const d0 = Math.hypot(aimX - p0.x, aimZ - p0.z)
  if (d0 <= tol || d0 > 1.35) return
  const deadline = Date.now() + maxMs
  let bestDist = d0
  let staleTicks = 0
  try {
    while (Date.now() < deadline) {
      requireConnected(s, bot)
      if (!s.alive || s.interruptedBy) break
      if (stopWhen && stopWhen()) break
      const p = bot.entity.position
      const dx = aimX - p.x, dz = aimZ - p.z
      const d = Math.hypot(dx, dz)
      if (d <= tol) break
      if (d < bestDist - 0.01) { bestDist = d; staleTicks = 0 }
      else if (++staleTicks >= 4) break
      bot.look(Math.atan2(-dx, -dz), 0, true)
      bot.setControlState('forward', true)
      bot.setControlState('sprint', false)
      bot.setControlState('sneak', d < 0.5 && !!bot.entity.onGround)
      await sleep(50)
    }
  } finally {
    if (s.bot === bot && bot.entity && typeof bot.clearControlStates === 'function') bot.clearControlStates()
  }
  if (s.bot === bot && bot.entity) await sleep(50)
}

// pathfinder 卡在实体碰撞箱（例如船顶）或未加载区块时会一声不响地原地转圈，
// 以前 move_to 会一直占着动作锁直到客户端 HTTP 超时。这里按位移做看门狗，
// 并在连续 stuck 2 次时自动临时关闭跑酷与疾跑做一次稳健降级重试。
async function gotoWatched(s, goal, timeout, opts = 8000) {
  const stallMs = typeof opts === 'number' ? opts : (opts.stallMs ?? 8000)
  const allowPartial = typeof opts === 'object' && opts ? !!opts.allowPartial : false
  const bot = requireConnected(s)
  let last = bot.entity.position.clone()
  let lastMoveAt = Date.now()
  let stuckResets = 0
  let savedMovements = null

  const onReset = reason => {
    if (reason !== 'stuck') return
    stuckResets++
    const m = bot.pathfinder && bot.pathfinder.movements
    if (stuckResets >= 2 && !savedMovements && m && (m.allowParkour || m.allowSprinting)) {
      savedMovements = { m, parkour: m.allowParkour, sprint: m.allowSprinting }
      m.allowParkour = false
      m.allowSprinting = false
      stuckResets = 0
      lastMoveAt = Date.now()
      if (s.log) s.log('pathfinder stuck x2, retrying without parkour/sprint')
      if (typeof bot.pathfinder.setMovements === 'function') bot.pathfinder.setMovements(m)
    }
  }
  bot.on('path_reset', onReset)

  const sampler = setInterval(() => {
    if (!bot.entity) return
    const p = bot.entity.position
    if (p.distanceTo(last) > 0.35) { last = p.clone(); lastMoveAt = Date.now(); stuckResets = 0 }
  }, 400)
  let watchdog = null
  const stalled = new Promise((_, reject) => {
    watchdog = setInterval(() => {
      if (Date.now() - lastMoveAt > stallMs) {
        clearInterval(watchdog)
        reject(new ApiError('stalled', `pathfinder made no progress for ${Math.round(stallMs / 1000)}s (stuck on an entity hitbox or unloaded chunk?)`))
      }
    }, 400)
  })
  let onEnd
  const disconnected = new Promise((_, reject) => {
    onEnd = () => reject(new ApiError('not_connected', 'bot disconnected during pathfinding'))
    bot.once('end', onEnd)
  })
  try {
    const res = await withTimeout(Promise.race([bot.pathfinder.goto(goal, { allowPartial }), stalled, disconnected]), timeout, 'pathfinding')
    requireConnected(s, bot)
    return res
  } catch (e) {
    if (bot.pathfinder) {
      try { bot.pathfinder.setGoal(null) } catch {}
    }
    throw e
  } finally {
    bot.removeListener('end', onEnd)
    bot.removeListener('path_reset', onReset)
    clearInterval(sampler)
    if (watchdog) clearInterval(watchdog)
    if (savedMovements && bot.pathfinder && bot.pathfinder.movements === savedMovements.m) {
      savedMovements.m.allowParkour = savedMovements.parkour
      savedMovements.m.allowSprinting = savedMovements.sprint
    }
  }
}

// 眼睛到方块中心的距离（mineflayer canDigBlock 的口径，上限 5.1；服务端交互距离也按眼睛算）
const eyeToBlock = (s, p) => s.bot.entity.position.offset(0, s.bot.entity.eyeHeight || 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5))

// reach：要对方块动手（挖 / 放）时传。"脚到方块角 ≤ range+0.5"就不动的提前返回，
// 对斜下方的方块会出现"没走过去、眼睛却够不着"（线上 dig 原地 1 ms 报 out_of_reach），
// 所以提前返回还要求眼睛距离在 reach 以内。寻路的 GoalNear 本身到达时眼睛距离 ≤ range+1.35，不受影响。
async function goNear(s, pos, range, timeout = 60000, reach = null) {
  const bot = requireConnected(s)
  if (bot.entity.position.distanceTo(pos) <= range + 0.5 && (reach === null || eyeToBlock(s, pos) <= reach)) return
  let resets = 0
  const onReset = r => { if (r === 'place_error' || r === 'dig_error') resets++ }
  bot.on('path_reset', onReset)
  try {
    await gotoWatched(s, new goals.GoalNear(pos.x, pos.y, pos.z, range), timeout)
  } catch (e) {
    requireConnected(s, bot)
    const from = bot.entity.position
    if (e instanceof ApiError) { e.extra = { pos: fmt(from), dist_left: +from.distanceTo(pos).toFixed(1), resets }; throw e }
    fail('path_not_found', e.message, { from: fmt(from), to: fmt(pos) })
  } finally { bot.removeListener('path_reset', onReset) }
}

// 桶：原版是"使用物品"包（use_item），服务端按玩家视线做射线判定，
// 不是"右键方块"包——以前走 activateBlock，装水倒水都只返回 changed:false。
//  - 空桶：pos 传液体源方块，瞄准它的液面；
//  - 满桶（水 / 岩浆 / 细雪 / 鱼桶）：pos 传承载方块，液体出现在它朝向 bot 的那一面（通常是顶面）；
//    pos 若是空气 / 可替换格，就当作目标格，改瞄它下面那块的顶面。
// 玻璃瓶装水、放睡莲 / 蛙卵也是同一套：use_item + 服务端视线判定（只认水源），activateBlock 对水无效。
//  - pos 传水方块本身；传了水面上方那格也认（改用它下面的水）
//  - 玻璃瓶：水不变，背包多一瓶水；睡莲 / 蛙卵：出现在水面上方那格
const WATER_AIM_ITEMS = new Set(['glass_bottle', 'lily_pad', 'frogspawn'])
const isWaterSource = blk => {
  if (!blk) return false
  if (blk.name === 'bubble_column') return true
  const props = blockProps(blk)
  if (blk.name === 'water') return String(props.level ?? 0) === '0'
  return props.waterlogged === true || props.waterlogged === 'true'
}
// 对着水用（返回实际要瞄的水方块；不是水就返回 null，交给普通右键方块）
function waterAimTarget (s, p, item) {
  if (!WATER_AIM_ITEMS.has(item)) return null
  const at = s.bot.blockAt(p)
  if (isWaterSource(at)) return p
  const under = s.bot.blockAt(p.offset(0, -1, 0))
  if (at && at.boundingBox === 'empty' && isWaterSource(under)) return under.position
  return null
}

async function useBucket (s, p, item) {
  const b = s.bot
  const eye = b.entity.position.offset(0, b.entity.eyeHeight || 1.62, 0)
  const center = p.offset(0.5, 0.5, 0.5)
  let clicked = p
  let normal = null
  if (WATER_AIM_ITEMS.has(item)) {
    if (!isWaterSource(b.blockAt(p))) fail('cannot_interact', `${item} needs pos to be a water source block`)
  } else if (item === 'bucket') {
    const src = b.blockAt(p)
    const props = src ? blockProps(src) : {}
    if (!src || !(['water', 'lava', 'powder_snow', 'bubble_column'].includes(src.name) || props.waterlogged === true || props.waterlogged === 'true')) {
      fail('cannot_interact', `an empty bucket needs pos to be the liquid block itself (got ${src ? src.name : 'nothing'})`, { block: src ? src.name : null })
    }
  } else {
    const at = b.blockAt(p)
    const below = b.blockAt(p.offset(0, -1, 0))
    if (at && at.boundingBox === 'empty' && below && below.boundingBox === 'block') {
      clicked = below.position
      normal = new Vec3(0, 1, 0)
    } else {
      const d = eye.minus(center)
      const ax = Math.abs(d.x); const ay = Math.abs(d.y); const az = Math.abs(d.z)
      normal = d.y > 0.5 ? new Vec3(0, 1, 0)
        : ax >= ay && ax >= az ? new Vec3(Math.sign(d.x), 0, 0)
          : az >= ay ? new Vec3(0, 0, Math.sign(d.z)) : new Vec3(0, Math.sign(d.y), 0)
    }
  }
  // 空桶瞄液面稍下（源方块液面高约 0.89）：瞄中心的话斜着看会先擦到旁边方块的顶面
  const aim = normal ? clicked.offset(0.5, 0.5, 0.5).plus(normal.scaled(0.49)) : p.offset(0.5, 0.85, 0.5)
  const target = item === 'bucket' || item === 'glass_bottle' ? p : normal ? clicked.plus(normal) : p.offset(0, 1, 0)
  const before = b.blockAt(target)
  const invBefore = invCounts(b)
  await b.lookAt(aim, true)
  await sleep(100)
  b.activateItem()
  await sleep(500)
  try { b.deactivateItem() } catch {}
  const after = b.blockAt(target)
  const invAfter = invCounts(b)
  const used = {}; const gained = {}
  for (const k of new Set([...Object.keys(invBefore), ...Object.keys(invAfter)])) {
    const d = (invAfter[k] || 0) - (invBefore[k] || 0)
    if (d < 0) used[k] = -d
    if (d > 0) gained[k] = d
  }
  const changed = !!(before && after && before.stateId !== after.stateId)
  return {
    block: b.blockAt(clicked) ? b.blockAt(clicked).name : null,
    target: fmt(target), before: before && before.name, after: after && after.name, changed,
    ...(Object.keys(used).length ? { used } : {}), ...(Object.keys(gained).length ? { gained } : {})
  }
}

// 原版左键：沿视线找 3 格内（生存模式实体交互距离，从眼睛算）最近的实体判定箱，被方块挡住的不算；
// 命中就发攻击包 + 挥手，没命中只挥手（不挖方块，挖掘请用 /dig）。
// 不用 mineflayer 的 entityAtCursor：它把 type=object 的实体（船、矿车、末影水晶）全滤掉了，且距离从脚底算。
const HIT_REACH = 3.0
const UNHITTABLE = new Set(['item', 'experience_orb', 'arrow', 'spectral_arrow', 'trident', 'fishing_bobber', 'falling_block',
  'area_effect_cloud', 'marker', 'eye_of_ender', 'ender_pearl', 'snowball', 'egg', 'potion', 'experience_bottle',
  'firework_rocket', 'llama_spit', 'shulker_bullet', 'small_fireball', 'evoker_fangs', 'lightning_bolt', 'interaction',
  'block_display', 'item_display', 'text_display'])
function rayBox (o, d, min, max) {
  let t0 = 0; let t1 = Infinity
  for (const a of ['x', 'y', 'z']) {
    if (Math.abs(d[a]) < 1e-9) { if (o[a] < min[a] || o[a] > max[a]) return null; continue }
    let n = (min[a] - o[a]) / d[a]; let f = (max[a] - o[a]) / d[a]
    if (n > f) [n, f] = [f, n]
    t0 = Math.max(t0, n); t1 = Math.min(t1, f)
    if (t0 > t1) return null
  }
  return t0
}
function leftClick (s) {
  const b = s.bot
  const me = b.entity
  const eye = me.position.offset(0, me.eyeHeight || 1.62, 0)
  const dir = new Vec3(-Math.sin(me.yaw) * Math.cos(me.pitch), Math.sin(me.pitch), -Math.cos(me.yaw) * Math.cos(me.pitch))
  const block = b.blockAtCursor(HIT_REACH)
  const limit = block && block.intersect ? eye.distanceTo(block.intersect) : HIT_REACH
  let best = null; let bestT = limit
  for (const e of Object.values(b.entities)) {
    if (e === me || (b.vehicle && e === b.vehicle) || UNHITTABLE.has(e.name) || !e.position) continue
    const w = (e.width || 0.6) / 2; const h = e.height || 1.8
    const t = rayBox(eye, dir, e.position.offset(-w, 0, -w), e.position.offset(w, h, w))
    if (t !== null && t <= bestT) { best = e; bestT = t }
  }
  if (best) {
    b.attack(best)   // use_entity(attack) + swing
    return { entity: { id: best.id, name: best.username || best.name, dist: +bestT.toFixed(2) } }
  }
  b.swingArm('right')
  return { entity: null, ...(block ? { block: { name: block.name, pos: [block.position.x, block.position.y, block.position.z] } } : {}) }
}

function findItem(s, name) {
  const it = s.bot.inventory.items().find(i => i.name === name)
  if (!it) fail('missing_item', `no ${name} in inventory`, { inventory: invCounts(s.bot) })
  return it
}

// 原版攻击冷却（ms）：空手 4.0 攻速 = 250ms、剑 1.6 = 625ms、斧约 1.0 = 1000ms。
// 之前固定 650ms：空手敲船时船每 tick 自愈 -1 伤害，650ms 一拳刚好被衰减抵消，永远敲不烂。
const ATTACK_INTERVAL_MS = { sword: 625, axe: 1000, pickaxe: 833, shovel: 1000, hoe: 1000 }
function attackIntervalMs (item) {
  if (!item) return 250
  if (item.name === 'trident') return 909
  if (item.name === 'mace') return 1667
  // 斧 / 锄的攻速随材质变（原版 1.21：木/石/铜斧 0.8、铁斧 0.9；石/铜锄 2.0、铁锄 3.0、钻石/下界合金锄 4.0）
  const BY_NAME = { wooden_axe: 1250, stone_axe: 1250, copper_axe: 1250, iron_axe: 1111,
    stone_hoe: 500, copper_hoe: 500, iron_hoe: 333, diamond_hoe: 250, netherite_hoe: 250 }
  if (BY_NAME[item.name]) return BY_NAME[item.name]
  const m = /_(sword|axe|pickaxe|shovel|hoe)$/.exec(item.name || '')
  // 非工具物品（方块、食物……）没有攻击速度修饰，和空手一样 4.0 次/秒
  return (m && ATTACK_INTERVAL_MS[m[1]]) || 250
}

// 载具（船 / 炽足兽 / 猪 / 马）在 1.21 是"客户端权威"：实测 player_input 和
// steer_boat 都不会让船动一个方块，服务端只认 vehicle_move 里上报的坐标。
// 所以这里自己按匀加速积分位置，逐帧发 vehicle_move，同时把 bot.entity 一起挪，
// 免得物理插件用旧坐标把玩家拽回去。
const VEHICLE_MAX_SPEED = { oak_boat: 8, boat: 8, strider: 4, pig: 5, horse: 9, donkey: 7, mule: 7, skeleton_horse: 9, camel: 6 }
function itemEnchantments (item) {
  if (!item) return []
  const ex = itemExtras(item).enchantments
  if (ex) return ex.map(e => ({ name: e.name, lvl: e.level }))
  const raw = item.enchants
  return Array.isArray(raw) ? raw : []
}

// 1.21 物品组件附魔版 bestHarvestTool：mineflayer-pathfinder 原版只读旧 nbt.Enchantments（1.21 上恒为空），
// 导致效率 V 铁镐输给排在前面的白板铁镐。这里直接用组件附魔算 digTime。
function selectBestHarvestTool (bot, block) {
  const availableTools = bot.inventory.items()
  const effects = bot.entity?.effects || {}
  let fastest = Number.MAX_VALUE
  let bestCanHarvest = false
  let bestTool = null
  for (const tool of availableTools) {
    const canHarvest = !block.harvestTools || !!block.harvestTools[tool.type]
    const digTime = block.digTime(tool.type, false, false, false, itemEnchantments(tool), effects)
    if ((canHarvest && !bestCanHarvest) || (canHarvest === bestCanHarvest && digTime < fastest)) {
      fastest = digTime
      bestCanHarvest = canHarvest
      bestTool = tool
    }
  }
  return bestTool
}

const WEAPON_BASE_DAMAGE = {
  wooden_sword: 4, golden_sword: 4, stone_sword: 5, copper_sword: 5, iron_sword: 6, diamond_sword: 7, netherite_sword: 8,
  wooden_axe: 7, golden_axe: 7, stone_axe: 9, copper_axe: 7, iron_axe: 9, diamond_axe: 9, netherite_axe: 10
}
function weaponScore (item) {
  const base = WEAPON_BASE_DAMAGE[item.name] || 1
  const sharp = itemEnchantments(item).find(e => e.name === 'sharpness')
  const dmg = base + (sharp ? 0.5 * sharp.lvl + 0.5 : 0)
  return dmg * (1000 / attackIntervalMs(item))
}

async function driveVehicle(s, tx, tz, range, timeout) {
  const b = s.bot
  const first = b.vehicle
  if (!first) fail('not_in_vehicle', 'bot is not riding anything')
  const maxSpeed = VEHICLE_MAX_SPEED[first.name] || 6
  const started = { pos: fmt(b.entity.position), vehicle: first.name }
  const t0 = Date.now()
  const DT = 50
  let speed = 0
  let dist = Infinity
  while (Date.now() - t0 < timeout && !s.interruptedBy && s.alive) {
    requireConnected(s, b)
    if (!b.vehicle) fail('dismounted', `no longer riding ${first.name} (vehicle vanished mid-drive)`)
    const p = b.vehicle.position
    const dx = tx - p.x
    const dz = tz - p.z
    dist = Math.hypot(dx, dz)
    if (dist <= range) break
    const ux = dx / dist
    const uz = dz / dist
    // 接近目标时线性减速，避免冲过头来回摆
    const desired = Math.max(1.2, Math.min(maxSpeed, dist * 1.2))
    speed += (desired - speed) * 0.3
    const step = Math.min(dist, (speed * DT) / 1000)
    const nx = p.x + ux * step
    const nz = p.z + uz * step
    const yaw = Math.atan2(-ux, -uz)
    p.set(nx, p.y, nz)
    b.entity.position.set(nx, p.y, nz)
    b.entity.yaw = yaw
    b.entity.pitch = 0
    b._client.write('vehicle_move', {
      x: nx, y: p.y, z: nz,
      yaw: 180 - (yaw * 180) / Math.PI, // mineflayer -> notchian yaw
      pitch: 0,
      onGround: true
    })
    await sleep(DT)
  }
  requireConnected(s, b)
  if (s.interruptedBy || !s.alive) {
    return { pos: fmt(b.entity.position), vehicle: b.vehicle ? { id: b.vehicle.id, name: b.vehicle.name } : { name: first.name }, dist: +dist.toFixed(2), ms: Date.now() - t0 }
  }
  if (dist > range) {
    fail('drive_timeout', `${first.name} did not reach target`, { pos: fmt(b.entity.position), dist: +dist.toFixed(1), started })
  }
  return { pos: fmt(b.entity.position), vehicle: { id: b.vehicle.id, name: b.vehicle.name }, dist: +dist.toFixed(2), ms: Date.now() - t0 }
}

// 药水效果列表：mineflayer 把 effect 存在 bot.entity.effects，键是效果 id
function effectList(s) {
  const map = (s.bot.entity.effects || {})
  const out = []
  for (const k of Object.keys(map)) {
    const x = map[k]
    if (!x) continue
    const id = typeof x.id === 'number' ? x.id : Number(k)
    out.push({
      name: effectName(s, id),
      level: (x.amplifier || 0) + 1,
      duration_s: +((x.duration || 0) / 20).toFixed(1)
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// 护甲值：1.21 客户端会同步 generic.armor 属性；属性表本身有版本错位问题，
// 连接时已用 buildAttributeFix 重新映射过 key，这里优先读属性，读不到再按装备估算。
const ARMOR_ITEM_POINTS = {
  leather_helmet: 1, leather_chestplate: 3, leather_leggings: 2, leather_boots: 1,
  golden_helmet: 2, golden_chestplate: 5, golden_leggings: 3, golden_boots: 1,
  chainmail_helmet: 2, chainmail_chestplate: 5, chainmail_leggings: 4, chainmail_boots: 1,
  iron_helmet: 2, iron_chestplate: 6, iron_leggings: 5, iron_boots: 2,
  diamond_helmet: 3, diamond_chestplate: 8, diamond_leggings: 6, diamond_boots: 3,
  netherite_helmet: 3, netherite_chestplate: 8, netherite_leggings: 6, netherite_boots: 3,
  turtle_helmet: 2
}
function armorPoints(bot) {
  const attrs = (bot.entity && bot.entity.attributes) || {}
  const a = attrs.armor || attrs['minecraft:armor']
  let sum = 0
  for (const slot of [5, 6, 7, 8]) {
    const it = bot.inventory.slots[slot]
    if (it && ARMOR_ITEM_POINTS[it.name]) sum += ARMOR_ITEM_POINTS[it.name]
  }
  const attrValue = a && Number.isFinite(a.value) ? a.value : 0
  return Math.max(sum, attrValue)
}

// 水方块：水本体 + 气泡柱 + 水里长的植物（这些格子实际上仍是水）
const WATER_PLANTS = new Set(['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant'])
const isWaterBlock = blk => {
  if (!blk) return false
  if (blk.name === 'water' || blk.name === 'bubble_column' || WATER_PLANTS.has(blk.name)) return true
  try { return !!(blk.getProperties && blk.getProperties().waterlogged) } catch { return false }
}
// 一次"用一下手上物品"里可以投掷的东西
const THROWABLE = new Set(['ender_pearl', 'ender_eye', 'snowball', 'egg', 'wind_charge', 'splash_potion', 'lingering_potion', 'firework_rocket', 'experience_bottle'])
// 放下后变成实体的物品（船、矿车）
const isVehicleItem = name => /_boat$|_raft$|(^|_)minecart$/.test(name)

const PROJECTILE_PHYSICS = {
  bow: { speed: 3.0, gravity: 0.05, drag: 0.99, charge_ms: 1100 },
  crossbow: { speed: 3.15, gravity: 0.05, drag: 0.99, charge_ms: 1400 },
  trident: { speed: 2.5, gravity: 0.05, drag: 0.99, charge_ms: 750 }
}

function solveProjectile(origin, target, physics) {
  const dx = target.x - origin.x
  const dz = target.z - origin.z
  const horizontal = Math.hypot(dx, dz)
  if (horizontal < 0.01) fail('bad_args', 'projectile target is directly above or below the bot')
  const ux = dx / horizontal
  const uz = dz / horizontal
  let best = null
  // Simulating vanilla projectile motion avoids a large dependency and also
  // accounts for drag, which matters for the 30-50 block advancement shots.
  for (let deg = -25; deg <= 80; deg += 0.25) {
    const angle = deg * Math.PI / 180
    let x = origin.x; let y = origin.y; let z = origin.z
    let vx = ux * physics.speed * Math.cos(angle)
    let vy = physics.speed * Math.sin(angle)
    let vz = uz * physics.speed * Math.cos(angle)
    for (let tick = 1; tick <= 160; tick++) {
      const x0 = x; const y0 = y; const z0 = z
      x += vx; y += vy; z += vz
      // Collision is swept along the whole tick segment, so measuring only
      // tick endpoints badly favors slow high arcs at long range.
      const sx = x - x0; const sy = y - y0; const sz = z - z0
      const segment2 = sx * sx + sy * sy + sz * sz
      const u = Math.max(0, Math.min(1, ((target.x - x0) * sx + (target.y - y0) * sy + (target.z - z0) * sz) / segment2))
      const cx = x0 + sx * u; const cy = y0 + sy * u; const cz = z0 + sz * u
      const miss2 = (cx - target.x) ** 2 + (cy - target.y) ** 2 + (cz - target.z) ** 2
      const cost = miss2 + tick * 0.002 // prefer the safer low arc when both hit
      if (!best || cost < best.cost) {
        best = { angle, ticks: tick, miss2, cost }
      }
      vx *= physics.drag; vy = vy * physics.drag - physics.gravity; vz *= physics.drag
      if (y < Math.min(origin.y, target.y) - 16 || Math.hypot(x - origin.x, z - origin.z) > horizontal + 12) break
    }
  }
  return best
}

// 只听服务端发来的某一格方块变化（block_change / multi_block_change 原始包），
// 不受 mineflayer 本地预测（挖完先把方块改成空气）的影响。state = 最后一次服务端给的状态 id，没收到为 null。
function watchServerBlock(bot, pos) {
  const k = pos.floored()
  const w = { state: null }
  const single = bot.supportFeature('usesMultiblockSingleLong')
  const onOne = pk => {
    if (pk.location && pk.location.x === k.x && pk.location.y === k.y && pk.location.z === k.z) w.state = pk.type
  }
  const onMulti = pk => {
    const c = pk.chunkCoordinates
    if (!c || c.x !== Math.floor(k.x / 16) || c.z !== Math.floor(k.z / 16) || c.y !== Math.floor(k.y / 16)) return
    for (const r of pk.records || []) {
      const bx = single ? (r >> 8) & 0x0f : (r.horizontalPos >> 4) & 0x0f
      const bz = single ? (r >> 4) & 0x0f : r.horizontalPos & 0x0f
      const by = single ? r & 0x0f : r.y
      if (c.x * 16 + bx === k.x && c.y * 16 + by === k.y && c.z * 16 + bz === k.z) w.state = single ? r >> 12 : r.blockId
    }
  }
  bot._client.on('block_change', onOne)
  bot._client.on('multi_block_change', onMulti)
  w.stop = () => {
    bot._client.removeListener('block_change', onOne)
    bot._client.removeListener('multi_block_change', onMulti)
  }
  return w
}

function projectileAim(bot, target, physics, velocity) {
  const origin = bot.entity.position.offset(0, 1.52, 0)
  let aimed = target
  let solution = solveProjectile(origin, aimed, physics)
  // 只按水平速度算提前量：站在地上的生物，服务端发来的速度带着 y≈-0.078 的"重力残值"，
  // 按它外推会把瞄点压低 1 格多（1.3.5 修好速度包之前这里的速度一直是 ~0，提前量等于没生效）。
  if (velocity && Math.hypot(velocity.x, velocity.z) > 0.005) {
    aimed = target.offset(velocity.x * solution.ticks, 0, velocity.z * solution.ticks)
    solution = solveProjectile(origin, aimed, physics)
  }
  const dx = aimed.x - origin.x
  const dz = aimed.z - origin.z
  return {
    yaw: Math.atan2(-dx, -dz),
    // Mineflayer exposes positive pitch as up (the wire protocol uses the
    // opposite sign and the physics plugin performs that conversion).
    pitch: solution.angle,
    target: aimed,
    ticks: solution.ticks,
    miss: Math.sqrt(solution.miss2)
  }
}

function crossbowLoaded(item) {
  const component = item && item.componentMap && item.componentMap.get('charged_projectiles')
  if (!component) return false
  const data = component.data ?? component
  const projectiles = data.projectiles ?? data.items ?? data.value ?? (Array.isArray(data) ? data : null)
  return Array.isArray(projectiles) && projectiles.length > 0
}

function hasArrow(bot) {
  return bot.inventory.items().some(i => i.name === 'arrow' || i.name === 'spectral_arrow' || i.name === 'tipped_arrow')
}

async function collectDrops(s, near, radius = 4) {
  const bot = requireConnected(s)
  await sleep(400)
  for (let k = 0; k < 4; k++) {
    requireConnected(s, bot)
    const drop = Object.values(bot.entities)
      .filter(e => e.name === 'item' && e.position.distanceTo(near) < radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (!drop) return
    try { await goNear(s, drop.position, 0.5, 8000) } catch { return }
    await sleep(300)
  }
}

function strictCoordinate (value, axis, label = 'operation') {
  if (typeof value === 'boolean' || value === null || value === undefined) {
    fail('bad_args', `${label} requires a finite ${axis} coordinate`)
  }
  if (typeof value === 'string') {
    if (!value.trim()) fail('bad_args', `${label} requires a finite ${axis} coordinate`)
    value = Number(value)
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('bad_args', `${label} requires a finite ${axis} coordinate`)
  }
  return value
}

function movementCoordinate(value, axis) {
  return strictCoordinate(value, axis, 'move_to')
}

function strictPositiveInt (value, name, max = Infinity) {
  if (typeof value === 'boolean' || value === null || value === undefined || value === '') {
    fail('bad_args', `${name} must be a positive integer`)
  }
  const n = typeof value === 'string' && value.trim() ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max) {
    fail('bad_args', max < Infinity ? `${name} must be an integer between 1 and ${max}` : `${name} must be a positive integer`)
  }
  return n
}

// 对实体右键：无 item 就是"用一下"（上船/上马/村民对话），有 item 就是把物品用在它身上
// （喂食繁殖、驯服、剪羊毛、挤奶、拴绳、装鞍、桶装生物、给狼穿脱甲）
// 起床。mineflayer 4.39 的 bot.wake() 写死 actionId: 2，而 1.21.6+ 的 player_command 去掉了潜行两项，
// 2 现在是 stop_sprinting：服务端收不到起床，bot 一直躺着（只有全员入睡跳夜时才会被服务端叫醒）。
// 这里按名字发 stop_sleeping，并等服务端真的把人放下床。
async function leaveBed(s) {
  const b = s.bot
  b._client.write('entity_action', { entityId: b.entity.id, actionId: 'stop_sleeping', jumpBoost: 0 })
  const t0 = Date.now()
  while (b.isSleeping && Date.now() - t0 < 2000) await sleep(50)
  if (b.isSleeping) fail('cannot_sleep', 'server did not let the bot leave the bed within 2 s')
  return { woke: true }
}

async function interactEntity(s, entityId, item) {
  let e = s.bot.entities[entityId]
  if (!e) fail('no_such_entity', `entity ${entityId} not visible`, {
    nearby: Object.values(s.bot.entities).slice(0, 20).map(x => ({ id: x.id, name: x.username || x.name }))
  })
  await goNear(s, e.position, 3, 20000)
  e = s.bot.entities[entityId]
  if (!e) fail('no_such_entity', `entity ${entityId} disappeared while walking there`)
  if (item) await s.bot.equip(findItem(s, item), 'hand')
  const windowBefore = s.bot.currentWindow
  const invBefore = invCounts(s.bot)
  const vehicleBefore = s.bot.vehicle ? s.bot.vehicle.id : null
  try {
    if (item) await s.bot.useOn(e)
    else await s.bot.activateEntity(e)
  } catch (err) {
    fail('cannot_interact', err.message, { entity: { id: e.id, name: e.username || e.name } })
  }
  await sleep(500)
  if (s.bot.currentWindow && s.bot.currentWindow !== windowBefore) {
    const title = s.bot.currentWindow.type
    s.bot.closeWindow(s.bot.currentWindow)
    fail('use_window_api', `${e.username || e.name} opens a GUI (${title}); use window/view or window/act with entity_id`, { entity_id: e.id })
  }
  const after = invCounts(s.bot)
  const used = {}
  const gained = {}
  for (const [k, v] of Object.entries(invBefore)) if (v > (after[k] || 0)) used[k] = v - (after[k] || 0)
  for (const [k, v] of Object.entries(after)) if (v > (invBefore[k] || 0)) gained[k] = v - (invBefore[k] || 0)
  const v = s.bot.vehicle
  return {
    entity: { id: e.id, name: e.username || e.name },
    in_vehicle: v ? { id: v.id, name: v.name } : null,
    ...(vehicleBefore !== (v ? v.id : null) ? { vehicle_changed: true } : {}),
    ...(Object.keys(used).length ? { used } : {}),
    ...(Object.keys(gained).length ? { gained } : {})
  }
}

// 船/矿车这类"放下来变成实体"的物品：在面前找一格空地，朝相邻实心方块右键。
// 不能用 bot.placeEntity：它按 1.8 的实体名 boat/Boat 找实体，1.21 的实体名是 oak_boat，永远等不到。
async function placeEntityFromItem(s, item, it, point) {
  const b = s.bot
  const base = b.entity.position.floored()
  const fx = -Math.sin(b.entity.yaw)
  const fz = -Math.cos(b.entity.yaw)
  const cells = []
  // 显式给了 target 就以它为准（矿车轨道、水面放船都靠这个），没给才按"面前 2 格 → 面前 1 格 → 脚下"猜
  const explicit = point ? new Vec3(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z)) : null
  if (explicit) cells.push(explicit)
  for (const c of [base.offset(Math.round(fx * 2), 0, Math.round(fz * 2)),
                   base.offset(Math.round(fx), 0, Math.round(fz)),
                   base]) {
    if (!cells.some(x => x.equals(c))) cells.push(c)
  }
  await b.equip(it, 'hand')
  const errors = []
  for (const cell of cells) {
    // 只有"猜"出来的格子才跳过脚底；显式 target 就站在同一格时也该照放（在水里放船就是这种情况）
    if (!(explicit && cell.equals(explicit)) && b.entity.position.floored().equals(cell)) continue
    const cur = b.blockAt(cell)
    if (cur && cur.boundingBox !== 'empty' && cur.name !== 'water') continue
    for (const f of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const fv = new Vec3(...f)
      const ref = b.blockAt(cell.plus(fv))
      if (!ref || (ref.boundingBox !== 'block' && ref.name !== 'water')) continue
      const before = new Set(Object.values(b.entities).map(e => e.id))
      try {
        // 1.21 放船要两步：先 use_item_on 指着方块，再发一次 use_item，服务端才生成实体
        await b.activateBlock(ref, fv.scaled(-1), new Vec3(0.5, 0.5, 0.5))
        await sleep(120)
        b.activateItem(false)
        await sleep(120)
        try { b.deactivateItem() } catch {}
        for (let i = 0; i < 25; i++) {
          await sleep(100)
          const ent = Object.values(b.entities).find(e =>
            !before.has(e.id) && /boat|raft|minecart/.test(e.name || '') &&
            e.position.distanceTo(cell) < 6)
          if (ent) {
            return { used: { name: item, count: 1 }, entity: { id: ent.id, name: ent.name }, pos: fmt(ent.position) }
          }
        }
        errors.push(`${ref.name}@${fmt(ref.position)}: no entity spawned, saw ${Object.values(b.entities).filter(e => !before.has(e.id)).map(e => e.name).join(',') || 'none'}`)
      } catch (e) {
        errors.push(`${ref.name}@${fmt(ref.position)}: ${e.message}`)
      }
    }
  }
  fail('cannot_use', `could not find a spot to put down ${item}`, { attempts: errors.slice(0, 6), pos: fmt(b.entity.position) })
}

// 打开工作台：mineflayer 的 openBlock 要等 20 s 才放弃，并以 internal "Event windowOpen did not fire" 报出
// （线上出现过 6 次，原因没复现出来）。这里 5 s 就停，返回 no_window 并附位置 / 眼睛距离，方便排查。
async function openTable(s, table) {
  let timedOut = false
  const p = s.bot.openBlock(table)
  p.then(w => { if (timedOut && s.bot && s.bot.currentWindow === w) s.bot.closeWindow(w) }, () => {})
  try {
    return await withTimeout(p, 5000, 'opening the crafting table')
  } catch (e) {
    if (e.code !== 'timeout') throw e
    timedOut = true
    fail('no_window', `crafting table at ${table.position} did not open (server ignored the click)`, {
      table: [table.position.x, table.position.y, table.position.z], pos: fmt(s.bot.entity.position), eye_dist: +eyeToBlock(s, table.position).toFixed(2)
    })
  }
}

function nearestBlockOf(s, names, maxDistance = 32) {
  const ids = names.map(n => s.mcData.blocksByName[n]?.id).filter(x => x !== undefined)
  return s.bot.findBlock({ matching: ids, maxDistance })
}

// ---------- 按 stateId 扫描半径内的方块（find_blocks 用） ----------
// mineflayer 的 findBlocks + useExtraInfo 会为每个位置构造 Block 对象（含方块实体、生物群系），
// 半径 64 时要几百毫秒到几秒，而且是同步的：这段时间同一个 bot 的 status 等请求全部排队。
// 这里直接读区块里的 stateId，用预先算好的"透明 / 无碰撞箱"表判断是否露天，每 4 ms 让出一次事件循环。
const seeThroughCache = new Map()
function seeThroughTable(mcData) {
  let t = seeThroughCache.get(mcData.version.minecraftVersion)
  if (t) return t
  let max = 0
  for (const b of mcData.blocksArray) max = Math.max(max, b.maxStateId)
  t = new Uint8Array(max + 1)
  for (const b of mcData.blocksArray) if (b.boundingBox === 'empty' || b.transparent) t.fill(1, b.minStateId, b.maxStateId + 1)
  seeThroughCache.set(mcData.version.minecraftVersion, t)
  return t
}

// want(stateId) 为真且至少一面挨着透明 / 无碰撞箱方块的位置；返回按距离排序的前 max 个 [x, y, z, dist, stateId]
async function scanExposed(s, radius, want, max) {
  if (max <= 0) return []
  const bot = s.bot
  const rawPos = bot.entity.position
  const me = typeof rawPos.clone === 'function' ? rawPos.clone() : { x: rawPos.x, y: rawPos.y, z: rawPos.z }
  const see = seeThroughTable(s.mcData)
  const minY = bot.game.minY, maxY = bot.game.minY + bot.game.height - 1
  const cols = new Map()
  const tmp = { x: 0, y: 0, z: 0 }
  const colKey = (cx, cz) => cx * 4294967296 + (cz >>> 0)
  const getCol = (cx, cz) => {
    const key = colKey(cx, cz)
    let c = cols.get(key)
    if (c === undefined) { c = bot.world.getColumn(cx, cz) || null; cols.set(key, c) }
    return c
  }
  const sid = (x, y, z) => {
    if (y < minY || y > maxY) return -1
    const c = getCol(x >> 4, z >> 4)
    if (!c) return -1
    tmp.x = x & 15; tmp.y = y; tmp.z = z & 15
    return c.getBlockStateId(tmp)
  }
  const open = (x, y, z) => { const v = sid(x, y, z); return v >= 0 && see[v] === 1 }

  const r2 = radius * radius
  const xMin = Math.floor(me.x - radius), xMax = Math.ceil(me.x + radius)
  const zMin = Math.floor(me.z - radius), zMax = Math.ceil(me.z + radius)
  const yMin = Math.max(Math.floor(me.y - radius), minY)
  const yMax = Math.min(Math.ceil(me.y + radius), maxY)
  if (yMin > yMax) return []

  // 先收集球体覆盖到的已加载区块列，按最短水平距离升序遍历；
  // 配合 cutoff2 提前剪枝，稠密目标（或摘要模式）凑满 max 个最近结果即可停止。
  const chunkCols = []
  for (let cx = xMin >> 4; cx <= (xMax >> 4); cx++) {
    const bx0 = cx << 4
    const nearX = me.x < bx0 ? bx0 : (me.x > bx0 + 15 ? bx0 + 15 : me.x)
    const dxNear = nearX - me.x
    const dxNear2 = dxNear * dxNear
    if (dxNear2 > r2) continue
    for (let cz = zMin >> 4; cz <= (zMax >> 4); cz++) {
      const bz0 = cz << 4
      const nearZ = me.z < bz0 ? bz0 : (me.z > bz0 + 15 ? bz0 + 15 : me.z)
      const dzNear = nearZ - me.z
      const colMinDist2 = dxNear2 + dzNear * dzNear
      if (colMinDist2 > r2) continue
      const col = getCol(cx, cz)
      if (!col) continue
      chunkCols.push({ cx, cz, bx0, bz0, col, colMinDist2 })
    }
  }
  chunkCols.sort((a, b) => a.colMinDist2 - b.colMinDist2)

  const out = []
  let cutoff2 = r2
  let hasCutoff = false
  let t0 = Date.now(), ops = 0
  const want0 = !!want(0)
  const solidCache = new Map()
  const isAllSolid = (cx, si, cz, expectMinY) => {
    const col = getCol(cx, cz)
    if (!col) return true
    if (!Array.isArray(col.sections)) return false
    const cMinY = typeof col.minY === 'number' ? col.minY : minY
    if (cMinY !== expectMinY) return false
    if (si < 0 || si >= col.sections.length) return true
    const key = colKey(cx, cz)
    let arr = solidCache.get(key)
    if (!arr) { arr = new Int8Array(col.sections.length); arr.fill(-1); solidCache.set(key, arr) }
    if (arr[si] !== -1) return arr[si] === 1
    const sec = col.sections[si]
    let solid = false
    if (!sec) {
      solid = see[0] !== 1
    } else {
      const d = sec.data
      if (d && Array.isArray(d.palette)) {
        solid = true
        for (let i = 0; i < d.palette.length; i++) if (see[d.palette[i]] === 1) { solid = false; break }
      } else if (d && typeof d.value === 'number') {
        solid = see[d.value] !== 1
      }
    }
    arr[si] = solid ? 1 : 0
    return solid
  }

  for (const { cx, cz, bx0, bz0, col, colMinDist2 } of chunkCols) {
    if (colMinDist2 > cutoff2) break
    const lx0 = Math.max(0, xMin - bx0), lx1 = Math.min(15, xMax - bx0)
    const lz0 = Math.max(0, zMin - bz0), lz1 = Math.min(15, zMax - bz0)

    if (Array.isArray(col.sections)) {
      const colMinY = typeof col.minY === 'number' ? col.minY : minY
      const secMin = Math.max(0, (yMin - colMinY) >> 4)
      const secMax = Math.min(col.sections.length - 1, (yMax - colMinY) >> 4)
      for (let si = secMin; si <= secMax; si++) {
        const secY0 = colMinY + (si << 4)
        const secY1 = secY0 + 15
        const nearY = me.y < secY0 ? secY0 : (me.y > secY1 ? secY1 : me.y)
        const dyNear = nearY - me.y
        if (colMinDist2 + dyNear * dyNear > cutoff2) continue

        const section = col.sections[si]
        if (!section && !want0) continue

        const data = section && section.data
        const hasPalette = !!(data && Array.isArray(data.palette))
        const isSingle = !!(data && !hasPalette && typeof data.value === 'number')
        const singleVal = !section ? 0 : (isSingle ? data.value : -1)

        // 先做调色板 / 单值过滤，不含目标方块则 O(1) / O(palette) 跳过整段
        let palMatch = null
        let rawData = null
        if (!section || isSingle) {
          if (!want(singleVal)) continue
        } else if (hasPalette) {
          const palette = data.palette
          let any = false
          palMatch = new Uint8Array(palette.length)
          for (let pi = 0; pi < palette.length; pi++) {
            if (want(palette[pi])) { palMatch[pi] = 1; any = true }
          }
          if (!any) continue
          if (data.data && typeof data.data.get === 'function') rawData = data.data
        }

        // 若整段自身不含任何透明/无碰撞箱方块，只有紧贴非全实心邻段的边界面才可能暴露；
        // 6 个邻段也全为实心时整段不可能有暴露方块，直接跳过。
        const selfSolid = isAllSolid(cx, si, cz, colMinY)
        let fX0 = false, fX1 = false, fZ0 = false, fZ1 = false, fY0 = false, fY1 = false
        if (selfSolid) {
          fX0 = !isAllSolid(cx - 1, si, cz, colMinY)
          fX1 = !isAllSolid(cx + 1, si, cz, colMinY)
          fZ0 = !isAllSolid(cx, si, cz - 1, colMinY)
          fZ1 = !isAllSolid(cx, si, cz + 1, colMinY)
          fY0 = !isAllSolid(cx, si - 1, cz, colMinY)
          fY1 = !isAllSolid(cx, si + 1, cz, colMinY)
          if (!fX0 && !fX1 && !fZ0 && !fZ1 && !fY0 && !fY1) continue
        }

        const ly0 = Math.max(0, yMin - secY0), ly1 = Math.min(15, yMax - secY0)
        if (!section || isSingle) {
          for (let lx = lx0; lx <= lx1; lx++) {
            const x = bx0 + lx
            const dx2 = (x - me.x) ** 2
            if (dx2 > cutoff2) continue
            const xFace = (fX0 && lx === 0) || (fX1 && lx === 15)
            for (let lz = lz0; lz <= lz1; lz++) {
              const z = bz0 + lz
              const dxz = dx2 + (z - me.z) ** 2
              if (dxz > cutoff2) continue
              const xzFace = xFace || (fZ0 && lz === 0) || (fZ1 && lz === 15)
              for (let ly = ly0; ly <= ly1; ly++) {
                if (selfSolid && !xzFace && !(fY0 && ly === 0) && !(fY1 && ly === 15)) continue
                const y = secY0 + ly
                const d2 = dxz + (y - me.y) ** 2
                if (d2 > cutoff2) continue
                if (open(x + 1, y, z) || open(x - 1, y, z) || open(x, y + 1, z) || open(x, y - 1, z) || open(x, y, z + 1) || open(x, y, z - 1)) out.push([x, y, z, d2, singleVal])
              }
              if ((++ops & 63) === 0 && Date.now() - t0 > 4) {
                await new Promise(res => setImmediate(res))
                if (s.bot !== bot || !bot.entity) fail('not_connected', 'bot disconnected during find_blocks')
                t0 = Date.now()
              }
            }
          }
          continue
        }

        const secGet = data && typeof data.get === 'function' ? data : null
        for (let lx = lx0; lx <= lx1; lx++) {
          const x = bx0 + lx
          const dx2 = (x - me.x) ** 2
          if (dx2 > cutoff2) continue
          const xFace = (fX0 && lx === 0) || (fX1 && lx === 15)
          for (let lz = lz0; lz <= lz1; lz++) {
            const z = bz0 + lz
            const dxz = dx2 + (z - me.z) ** 2
            if (dxz > cutoff2) continue
            const xzFace = xFace || (fZ0 && lz === 0) || (fZ1 && lz === 15)
            const xzIdx = (lz << 4) | lx
            for (let ly = ly0; ly <= ly1; ly++) {
              if (selfSolid && !xzFace && !(fY0 && ly === 0) && !(fY1 && ly === 15)) continue
              const y = secY0 + ly
              const d2 = dxz + (y - me.y) ** 2
              if (d2 > cutoff2) continue
              let v
              if (rawData) {
                const pi = rawData.get((ly << 8) | xzIdx)
                if (!palMatch[pi]) continue
                v = data.palette[pi]
              } else if (secGet) {
                v = secGet.get((ly << 8) | xzIdx)
                if (!want(v)) continue
              } else {
                tmp.x = lx; tmp.y = y; tmp.z = lz
                v = col.getBlockStateId(tmp)
                if (v < 0 || !want(v)) continue
              }
              if (open(x + 1, y, z) || open(x - 1, y, z) || open(x, y + 1, z) || open(x, y - 1, z) || open(x, y, z + 1) || open(x, y, z - 1)) out.push([x, y, z, d2, v])
            }
            if ((++ops & 63) === 0 && Date.now() - t0 > 4) {
              await new Promise(res => setImmediate(res))
              if (s.bot !== bot || !bot.entity) fail('not_connected', 'bot disconnected during find_blocks')
              t0 = Date.now()
            }
          }
        }
      }
    } else {
      // 兼容没有 sections 结构的自定义 / 旧版区块对象
      for (let lx = lx0; lx <= lx1; lx++) {
        const x = bx0 + lx
        const dx2 = (x - me.x) ** 2
        if (dx2 > cutoff2) continue
        for (let lz = lz0; lz <= lz1; lz++) {
          const z = bz0 + lz
          const dxz = dx2 + (z - me.z) ** 2
          if (dxz > cutoff2) continue
          for (let y = yMin; y <= yMax; y++) {
            const d2 = dxz + (y - me.y) ** 2
            if (d2 > cutoff2) continue
            tmp.x = lx; tmp.y = y; tmp.z = lz
            const v = col.getBlockStateId(tmp)
            if (v < 0 || !want(v)) continue
            if (open(x + 1, y, z) || open(x - 1, y, z) || open(x, y + 1, z) || open(x, y - 1, z) || open(x, y, z + 1) || open(x, y, z - 1)) out.push([x, y, z, d2, v])
          }
          if ((++ops & 63) === 0 && Date.now() - t0 > 4) {
            await new Promise(res => setImmediate(res))
            if (s.bot !== bot || !bot.entity) fail('not_connected', 'bot disconnected during find_blocks')
            t0 = Date.now()
          }
        }
      }
    }

    if (out.length > max || (!hasCutoff && out.length === max)) {
      out.sort((a, b) => a[3] - b[3])
      out.length = max
      cutoff2 = out[max - 1][3]
      hasCutoff = true
    }
    if ((++ops & 63) === 0 && Date.now() - t0 > 4) {
      await new Promise(res => setImmediate(res))
      if (s.bot !== bot || !bot.entity) fail('not_connected', 'bot disconnected during find_blocks')
      t0 = Date.now()
    }
  }

  out.sort((a, b) => a[3] - b[3])
  if (out.length > max) out.length = max
  for (let i = 0; i < out.length; i++) out[i][3] = Math.sqrt(out[i][3])
  return out
}

function isExposed(s, p) {
  if (p && p.position) p = p.position
  return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(d => {
    const b = s.bot.blockAt(p.offset(...d))
    return b && (b.boundingBox === 'empty' || b.transparent)
  })
}

// 作物 -> 表示生长阶段的属性名；最大值从 minecraft-data 的状态定义里取
const CROP_AGE_PROP = {
  wheat: 'age', carrots: 'age', potatoes: 'age', beetroots: 'age', nether_wart: 'age', sweet_berry_bush: 'age',
  cocoa: 'age', torchflower_crop: 'age', pitcher_crop: 'age', melon_stem: 'age', pumpkin_stem: 'age'
}

// 方块状态属性：整数型转成 number，布尔/枚举原样返回
function blockProps(b) {
  const out = {}
  for (const [k, v] of Object.entries(b.getProperties())) out[k] = typeof v === 'string' && /^\d+$/.test(v) ? +v : v
  return out
}

// 作物返回 { growth: [当前, 最大], mature }；非作物返回 {}
function cropInfo(s, b, props) {
  const prop = CROP_AGE_PROP[b.name]
  if (!prop || props[prop] === undefined) return {}
  const st = (s.mcData.blocksByName[b.name].states || []).find(x => x.name === prop)
  const max = st ? st.num_values - 1 : null
  return { growth: [props[prop], max], mature: max !== null && props[prop] >= max }
}

// 校验 find_blocks 的 properties 过滤条件：属性名必须至少在一种目标方块上存在
function checkPropFilter(s, types, filter) {
  for (const key of Object.keys(filter)) {
    if (!types.some(n => (s.mcData.blocksByName[n].states || []).some(st => st.name === key))) {
      fail('bad_args', `property ${key} does not exist on ${types.join(', ')}`)
    }
  }
}

// ---------- 统一界面引擎（window/view、window/act） ----------
// 每种界面只描述"区域 -> 槽位"和可读属性；put/take/select/text 四个操作对所有界面通用
const CONTAINER = { sections: w => ({ container: range(0, w.inventoryStart) }) }
const FURNACE_LIKE = {
  sections: () => ({ input: [0], fuel: [1], output: [2] }),
  outputs: ['output'],
  info: p => {
    const out = { burning: (p[0] || 0) > 0 }
    if (p[3]) out.progress = +((p[2] || 0) / p[3]).toFixed(2)
    if (p[1]) out.fuel_left = +((p[0] || 0) / p[1]).toFixed(2)
    return out
  }
}
const WINDOW_KINDS = {
  'minecraft:generic_9x1': CONTAINER, 'minecraft:generic_9x2': CONTAINER, 'minecraft:generic_9x3': CONTAINER,
  'minecraft:generic_9x4': CONTAINER, 'minecraft:generic_9x5': CONTAINER, 'minecraft:generic_9x6': CONTAINER,
  'minecraft:generic_3x3': CONTAINER, 'minecraft:hopper': CONTAINER, 'minecraft:shulker_box': CONTAINER,
  'minecraft:furnace': FURNACE_LIKE, 'minecraft:blast_furnace': FURNACE_LIKE, 'minecraft:smoker': FURNACE_LIKE,
  'minecraft:crafting': { sections: () => ({ grid: range(1, 10), output: [0] }), outputs: ['output'] },
  'minecraft:enchantment': {
    sections: () => ({ item: [0], lapis: [1] }),
    // 属性 0-2：所需等级；4-6：提示的附魔 id；7-9：提示的附魔等级
    options: (s, w, p) => [0, 1, 2].map(i => ({
      index: i, level_required: p[i] || 0, lapis_cost: i + 1,
      hint: p[4 + i] >= 0 && p[i] > 0 ? { enchantment: enchantmentName(s, p[4 + i]), level: p[7 + i] } : null,
      available: (p[i] || 0) > 0 && s.bot.experience.level >= p[i] && ((w.slots[1] && w.slots[1].count) || 0) >= i + 1
    })),
    select: (s, w, opt) => s.bot._client.write('enchant_item', { windowId: w.id, enchantment: opt }),
    selectWatch: [0]
  },
  'minecraft:anvil': {
    sections: () => ({ left: [0], right: [1], output: [2] }), outputs: ['output'],
    info: p => (p[0] !== undefined ? { repair_cost: p[0] } : {}),
    text: (s, w, value) => s.bot._client.write('name_item', { name: value })
  },
  'minecraft:grindstone': { sections: () => ({ top: [0], bottom: [1], output: [2] }), outputs: ['output'] },
  'minecraft:smithing': { sections: () => ({ template: [0], base: [1], addition: [2], output: [3] }), outputs: ['output'] },
  'minecraft:stonecutter': {
    sections: () => ({ input: [0], output: [1] }), outputs: ['output'],
    info: p => (p[0] !== undefined && p[0] >= 0 ? { selected: p[0] } : {}),
    // 选项 = 服务器下发的切石配方中，输入能匹配当前放入物品的那些，保持下发顺序
    options: (s, w) => {
      const inp = w.slots[0]
      if (!inp || !stonecutterRecipes) return []
      return stonecutterRecipes.filter(r => r.inputs && r.inputs.includes(inp.type)).map((r, i) => ({
        index: i, get: r.out && s.mcData.items[r.out.itemId] ? { name: s.mcData.items[r.out.itemId].name, count: r.out.itemCount } : null, available: true
      }))
    },
    select: (s, w, opt) => s.bot._client.write('enchant_item', { windowId: w.id, enchantment: opt }),
    selectWatch: [1]
  },
  'minecraft:loom': {
    sections: () => ({ banner: [0], dye: [1], pattern: [2], output: [3] }), outputs: ['output'],
    // 选项 = 不需要图案物品的图案（服务器 tag 顺序）；放了图案物品时服务器只给那一种，选项退化为 [0]
    options: (s, w) => {
      if (!w.slots[0] || !w.slots[1]) return []
      if (w.slots[2]) return [{ index: 0, pattern: 'from_pattern_item', available: true }]
      return (loomFreePatterns || []).map((id, i) => ({ index: i, pattern: bannerPatternNames ? bannerPatternNames[id] : `#${id}`, available: true }))
    },
    select: (s, w, opt) => s.bot._client.write('enchant_item', { windowId: w.id, enchantment: opt }),
    selectWatch: [3]
  },
  'minecraft:brewing_stand': {
    sections: () => ({ bottles: [0, 1, 2], ingredient: [3], fuel: [4] }),
    info: p => ({ ...(p[0] !== undefined ? { brew_time_left: +(p[0] / 20).toFixed(1) } : {}), ...(p[1] !== undefined ? { fuel_left: p[1] } : {}) })
  },
  'minecraft:merchant': {
    sections: () => ({ payment1: [0], payment2: [1], output: [2] }), outputs: ['output'],
    options: (s, w) => (w.trades || []).map((t, i) => ({
      index: i,
      give: [t.cost1, t.cost2].filter(Boolean),
      get: t.result,
      uses: t.uses, max_uses: t.max_uses,
      available: !t.disabled && t.uses < t.max_uses && hasItems(s, w, [t.cost1, t.cost2].filter(Boolean))
    })),
    info: (p, w) => (w.merchant ? { villager_level: w.merchant.level, villager_xp: w.merchant.xp } : {}),
    select: (s, w, opt) => s.bot._client.write('select_trade', { slot: opt }),
    selectWatch: [2]
  },
  'minecraft:beacon': {
    sections: () => ({ payment: [0] }),
    // 属性 0：信标等级；1/2：当前主/副效果。协议里效果是"注册表下标 + 1"，0 表示无
    info: (p, w, s) => ({
      ...(p[0] !== undefined ? { beacon_level: p[0] } : {}),
      ...(p[1] > 0 ? { primary: effectName(s, p[1] - 1) } : {}),
      ...(p[2] > 0 ? { secondary: effectName(s, p[2] - 1) } : {})
    }),
    // 选项按原版规则随信标等级开放；select 时需同时放好付款（铁锭/金锭/绿宝石/钻石/下界合金锭）
    options: (s, w, p) => {
      const lvl = p[0] || 0
      const pay = !!w.slots[0]
      return BEACON_OPTIONS.map((o, i) => ({ index: i, primary: o.primary, ...(o.secondary ? { secondary: o.secondary } : {}), min_level: o.level, available: lvl >= o.level && pay }))
    },
    select: (s, w, opt) => {
      const o = BEACON_OPTIONS[opt]
      // set_beacon_effect 的效果 id 就是注册表下标（不 +1），与上面窗口属性不同
      const id = n => s.mcData.effectsByName[n].id
      s.bot._client.write('set_beacon_effect', { primary_effect: id(o.primaryKey), secondary_effect: o.secondaryKey ? id(o.secondaryKey) : undefined })
    },
    selectWatch: [0]
  }
}

// 信标可选效果（原版规则）：1 级速度/急迫，2 级抗性/跳跃，3 级力量，4 级可选第二效果（再生或同效果 II）
const BEACON_OPTIONS = [
  ['speed', 'Speed', 1], ['haste', 'Haste', 1], ['resistance', 'Resistance', 2], ['jump_boost', 'JumpBoost', 2], ['strength', 'Strength', 3]
].flatMap(([n, k, lvl]) => [
  { primary: n, primaryKey: k, level: lvl },
  { primary: n, primaryKey: k, secondary: 'regeneration', secondaryKey: 'Regeneration', level: 4 },
  { primary: n, primaryKey: k, secondary: n + '_ii', secondaryKey: k, level: 4 }
])

function effectName(s, id) {
  const e = s.mcData.effects[id]
  return e ? e.name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() : `#${id}`
}

// 按名字找界面方块时，同一类的变体一起算（铁砧用久了会变成 chipped/damaged）
const BLOCK_FAMILY = {
  anvil: ['anvil', 'chipped_anvil', 'damaged_anvil'],
  chest: ['chest', 'trapped_chest'],
  shulker_box: ['shulker_box', ...['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map(c => `${c}_shulker_box`)]
}

function range(a, b) { const r = []; for (let i = a; i < b; i++) r.push(i); return r }
const shortType = t => (t || '').replace(/^minecraft:/, '')

function enchantmentName(s, id) {
  const reg = s.enchantRegistry
  if (reg && reg[id]) return reg[id].replace(/^minecraft:/, '')
  const e = s.mcData.enchantments[id]
  return e ? e.name : `#${id}`
}

// 背包（含当前界面的玩家背包部分）是否够付这些物品；村民界面里已经放进付款槽的也算
function hasItems(s, w, wants) {
  const have = {}
  const add = it => { if (it) have[it.name] = (have[it.name] || 0) + it.count }
  for (let i = w.inventoryStart; i < w.inventoryEnd; i++) add(w.slots[i])
  if (w.type === 'minecraft:merchant') { add(w.slots[0]); add(w.slots[1]) }
  return wants.every(x => (have[x.name] || 0) >= x.count)
}

// window/view|act 既接受规范的 {target:{...}}，也接受扁平写法 {pos}/{x,y,z}/{block}/{entity_id}：
// 文档里"目标三选一"的写法会让人直接传平铺参数，之前会报 target required。
function windowTarget (args = {}) {
  if (args.target && typeof args.target === 'object') return args.target
  if (Array.isArray(args.pos) && args.pos.length >= 3) return { pos: args.pos.map(Number) }
  if (args.x !== undefined && args.y !== undefined && args.z !== undefined) return { pos: [Number(args.x), Number(args.y), Number(args.z)] }
  if (args.entity_id !== undefined) return { entity_id: args.entity_id }
  if (args.block !== undefined) return { block: args.block }
  return null
}

// 打开方块或实体的界面；target: {pos:[x,y,z]} | {entity_id} | {block:'furnace'}
async function openTarget(s, target) {
  if (!target || typeof target !== 'object') fail('bad_args', 'target required: {pos:[x,y,z]} | {entity_id} | {block:name}')
  if (s.bot.currentWindow) { s.bot.closeWindow(s.bot.currentWindow); await sleep(200) }
  let opener, what
  if (target.entity_id !== undefined) {
    const e = s.bot.entities[target.entity_id]
    if (!e) fail('no_such_entity', `entity ${target.entity_id} not visible`)
    await goNear(s, e.position, 2.5)
    const live = s.bot.entities[target.entity_id]
    if (!live) fail('no_such_entity', `entity ${target.entity_id} vanished before opening`)
    what = live.name
    opener = () => s.bot.activateEntity(live)
  } else {
    let block
    if (target.pos) {
      const [x, y, z] = target.pos
      block = s.bot.blockAt(new Vec3(strictCoordinate(x, 'x', 'window'), strictCoordinate(y, 'y', 'window'), strictCoordinate(z, 'z', 'window')).floored())
      if (!block) fail('not_loaded', 'chunk not loaded')
    } else if (target.block) {
      if (!s.mcData.blocksByName[target.block]) fail('bad_args', `unknown block ${target.block}`)
      block = nearestBlockOf(s, BLOCK_FAMILY[target.block] || [target.block], 32)
      if (!block) fail('not_found', `no ${target.block} within 32 blocks`)
    } else fail('bad_args', 'target needs pos, entity_id or block')
    await goNear(s, block.position, 3)
    what = block.name
    opener = () => s.bot.activateBlock(block)
  }
  // 村民的 trade_list 会在 open_window 之后立刻到，先挂监听
  let trades = null, merchant = null
  const onTrades = p => {
    trades = p.trades.map(t => {
      const cost1 = tradeItem(s, t.inputItem1)
      if (cost1) {
        const itDef = s.mcData.itemsByName[cost1.name]
        const stackSize = (itDef && itDef.stackSize) || 64
        const demandDiff = Math.max(0, Math.floor(cost1.count * (t.demand || 0) * (t.priceMultiplier || 0)))
        cost1.count = Math.min(Math.max(cost1.count + (t.specialPrice || 0) + demandDiff, 1), stackSize)
      }
      return {
        raw: t,
        cost1, cost2: t.inputItem2 ? tradeItem(s, t.inputItem2) : null,
        result: itemSummaryNotch(s, t.outputItem), disabled: t.tradeDisabled, uses: t.nbTradeUses, max_uses: t.maximumNbTradeUses,
        special_price: t.specialPrice, demand: t.demand, multiplier: t.priceMultiplier
      }
    })
    merchant = { level: p.villagerLevel, xp: p.experience }
  }
  const props = {}
  const onProp = p => { if (s.bot.currentWindow && p.windowId === s.bot.currentWindow.id) props[p.property] = p.value }
  // 记录服务器实际发来的槽位总数，用来发现 prismarine-windows 里过时的槽位表
  let serverSlotCount = null
  const onItems = p => { if (s.bot.currentWindow && p.windowId === s.bot.currentWindow.id) serverSlotCount = p.items.length }
  s.bot._client.prependListener('window_items', onItems)
  s.bot._client.on('trade_list', onTrades)
  s.bot._client.on('craft_progress_bar', onProp)
  const opened = new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, v) => {
      if (settled) return
      settled = true
      clearTimeout(t)
      s.bot?.removeListener('windowOpen', ok)
      fn(v)
    }
    const t = setTimeout(() => finish(reject, new ApiError('no_window', `${what} did not open a GUI`)), 2500)
    const ok = w => finish(resolve, w)
    s.bot.once('windowOpen', ok)
    Promise.resolve().then(opener).catch(err => finish(reject, err))
  })
  try {
    const w = await opened
    await sleep(350) // 等 window_items / 属性 / 交易列表
    if (w.type === 'minecraft:merchant') for (let i = 0; i < 10 && !trades; i++) await sleep(100)
    // prismarine-windows 的槽位表有过时的（如锻造台仍是 1.16 的 3 格），以服务器为准修正：玩家背包固定是最后 36 格
    // 注意不能比 w.slots.length：mineflayer 处理 window_items 时逐格写入，数组已被自动撑到服务器的长度
    if (serverSlotCount && w.inventoryStart !== serverSlotCount - 36) {
      s.log('WINDOW slot table fix', w.type, 'local inventoryStart', w.inventoryStart, 'server slots', serverSlotCount)
      w.slots.length = serverSlotCount
      for (let i = 0; i < serverSlotCount; i++) if (w.slots[i] === undefined) w.slots[i] = null
      w.inventoryStart = serverSlotCount - 36
      w.inventoryEnd = serverSlotCount
      w.hotbarStart = serverSlotCount - 9
      await s.bot._syncWindow(w) // 让服务器把整窗内容重发一遍，按新的槽位数落位
      await sleep(150)
    }
    w.props = props
    w.trades = trades
    w.merchant = merchant
    w.cleanup = () => {
      s.bot._client.removeListener('trade_list', onTrades); s.bot._client.removeListener('craft_progress_bar', onProp)
      s.bot._client.removeListener('window_items', onItems)
    }
    w.target = what
    return w
  } catch (e) {
    s.bot._client.removeListener('trade_list', onTrades); s.bot._client.removeListener('craft_progress_bar', onProp)
    s.bot._client.removeListener('window_items', onItems)
    throw e
  }
}

// 转成 mineflayer 内部期望的交易对象（inputItem1/inputItem2 为带 type、count 的物品）
function mineflayerTrade(s, t) {
  const toItem = x => x && { type: s.mcData.itemsByName[x.name].id, count: x.count }
  return {
    inputItem1: toItem(t.cost1), inputItem2: toItem(t.cost2), hasItem2: !!t.cost2,
    outputItem: t.result && toItem(t.result), tradeDisabled: !!t.disabled,
    nbTradeUses: t.uses, maximumNbTradeUses: t.max_uses
  }
}

function tradeItem(s, t) {
  const it = t && s.mcData.items[t.itemId]
  return it && t.itemCount ? { name: it.name, count: t.itemCount } : null
}
function itemSummaryNotch(s, slot) {
  if (!slot || !slot.itemCount) return null
  const it = s.mcData.items[slot.itemId]
  return it ? { name: it.name, count: slot.itemCount } : null
}

function windowKind(w) {
  const k = WINDOW_KINDS[w.type]
  if (!k) fail('unsupported_window', `GUI ${w.type} is not supported yet`)
  return k
}

function describeWindow(s, w) {
  const kind = windowKind(w)
  const secs = kind.sections(w)
  const sections = {}
  for (const [name, slots] of Object.entries(secs)) {
    sections[name] = slots.map(i => w.slots[i]).filter(Boolean).map(i => ({ name: i.name, count: i.count, ...itemExtras(i) }))
  }
  const out = { window: shortType(w.type), target: w.target, sections }
  const info = kind.info ? kind.info(w.props || {}, w, s) : null
  if (info && Object.keys(info).length) out.info = info
  if (kind.options) out.options = kind.options(s, w, w.props || {})
  return out
}

function diffGain(before, after) {
  const gained = {}
  for (const [k, v] of Object.entries(after)) if (v > (before[k] || 0)) gained[k] = v - (before[k] || 0)
  return gained
}

// 当前界面里玩家背包部分的物品数量
function windowInvCounts(w) {
  const c = {}
  for (let i = w.inventoryStart; i < w.inventoryEnd; i++) { const it = w.slots[i]; if (it) c[it.name] = (c[it.name] || 0) + it.count }
  return c
}

// 越小越"干净"：没附魔、没改名、耐久损耗少
function plainScore(i) {
  const x = itemExtras(i)
  return (x.enchantments ? 1000 : 0) + (x.custom_name ? 500 : 0) + (x.durability_used || 0)
}

// 同名不可堆叠物品的挑选条件：enchanted（true/false）、custom_name（精确匹配）
function matchItemFilter(x, f) {
  const e = itemExtras(x)
  if (f.enchanted === true && !e.enchantments) return false
  if (f.enchanted === false && e.enchantments) return false
  if (f.custom_name !== undefined && e.custom_name !== f.custom_name) return false
  return true
}

// slot：区域内第几格（工作台 grid 为 0-8，按行从左上开始），用于有形状的配方
// potion：同为 potion/splash_potion 时按药水种类挑选
// enchanted / custom_name：工具、武器等同名多件时指定用哪一件
async function opPut(s, w, kind, { item, count, to, slot, potion, enchanted, custom_name }) {
  const filter = { ...(enchanted !== undefined ? { enchanted } : {}), ...(custom_name !== undefined ? { custom_name } : {}) }
  const secs = kind.sections(w)
  if (!secs[to]) fail('bad_section', `section "${to}" not in ${shortType(w.type)}; have: ${Object.keys(secs).join(', ')}`)
  if ((kind.outputs || []).includes(to)) fail('bad_section', `cannot put into output section "${to}"`)
  const it = s.mcData.itemsByName[item]
  if (!it) fail('bad_args', `unknown item ${item}`)
  const reqCount = count === undefined ? undefined : strictPositiveInt(count, 'count')
  const have = windowInvCounts(w)[item] || 0
  if (!have) fail('missing_item', `no ${item} in inventory`, { inventory: windowInvCounts(w) })
  let want = Math.min(reqCount ?? have, have)
  let slots = secs[to]
  if (slot !== undefined) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= slots.length) fail('bad_args', `slot must be 0..${slots.length - 1} for section ${to}`)
    slots = [slots[slot]]
  }
  if (potion) {
    // 指定药水种类：逐格搬，每次从背包里挑对应种类的那瓶
    const pick = () => range(w.inventoryStart, w.inventoryEnd).map(i => w.slots[i]).find(x => x && x.type === it.id && itemExtras(x).potion === potion)
    if (!pick()) fail('missing_item', `no ${item} of ${potion} in inventory`)
    let moved = 0
    for (const dest of slots) {
      if (moved >= (reqCount ?? 1)) break
      if (w.slots[dest]) continue
      const src = pick()
      if (!src) break
      await s.bot.clickWindow(src.slot, 0, 0)
      await s.bot.clickWindow(dest, 0, 0)
      if (w.selectedItem) await s.bot.clickWindow(src.slot, 0, 0)
      await sleep(150)
      if (w.slots[dest]) moved++
    }
    if (!moved) fail('section_full', `${to} has no free slot for ${potion}`)
    return { put: item, potion, count: moved, to }
  }
  // 按背包减少量计数：熔炉燃料放进去可能当场被烧掉，看槽位数量会误判为没放进去
  const before = have
  for (const dest of slots) {
    if (want <= 0) break
    const cur = w.slots[dest]
    if (cur && cur.type !== it.id) continue
    const room = (cur ? cur.stackSize - cur.count : it.stackSize)
    const n = Math.min(room, want)
    if (n <= 0) continue
    if (it.stackSize === 1) {
      // 不可堆叠（工具/武器/装备）：按 enchanted / custom_name 过滤；同名多件时默认用"干净"的那件，enchanted:true 时用附魔最多的
      const cands = range(w.inventoryStart, w.inventoryEnd).map(i => w.slots[i]).filter(x => x && x.type === it.id && matchItemFilter(x, filter))
      if (!cands.length) fail('missing_item', `no ${item} matching ${JSON.stringify(filter)} in inventory`)
      const src = cands.sort((a, b) => filter.enchanted === true ? plainScore(b) - plainScore(a) : plainScore(a) - plainScore(b))[0]
      await s.bot.clickWindow(src.slot, 0, 0)
      await s.bot.clickWindow(dest, 0, 0)
      if (w.selectedItem) await s.bot.clickWindow(src.slot, 0, 0) // 目标槽不收，放回原处
    } else {
      await s.bot.transfer({ window: w, itemType: it.id, metadata: null, sourceStart: w.inventoryStart, sourceEnd: w.inventoryEnd, destStart: dest, destEnd: dest + 1, count: n })
    }
    await sleep(150)
    want -= n
  }
  await sleep(100)
  const moved = before - (windowInvCounts(w)[item] || 0)
  if (moved <= 0) {
    const blockers = slots.map(i => w.slots[i]).filter(x => x && x.type !== it.id).map(x => `${x.count} ${x.name}`)
    fail('section_full', blockers.length
      ? `${to} is occupied by ${blockers.join(', ')}; take it out first`
      : `${to} did not accept ${item} (wrong item for this slot or no room)`)
  }
  return { put: item, count: moved, to }
}

// 背包（当前界面里的背包格）还能放下多少个和 x 一模一样的物品。同类但组件不同的堆不算（不会合并），宁少勿多。
// mineflayer 的 putAway / transfer / putSelectedItemRange 在背包放不下时会把光标上的物品直接扔到地上。
function itemStackSig (i) {
  return JSON.stringify([i.nbt ?? null, i.components ?? null])
}
function roomFor(w, x) {
  const sig = itemStackSig(x)
  let n = 0
  for (let i = w.inventoryStart; i < w.inventoryEnd; i++) {
    const y = w.slots[i]
    if (!y) n += x.stackSize
    else if (y.type === x.type && y.count < y.stackSize && itemStackSig(y) === sig) n += y.stackSize - y.count
  }
  return n
}
// 同时放入多组物品（例如村民交易的成品 + 付款槽剩余找零）时，校验背包格是否全部装得下，
// 防止取走成品占掉最后一个空格后，关窗时服务端把付款槽剩余绿宝石直接扔到地上。
function canFitItems (w, items) {
  const sim = []
  for (let i = w.inventoryStart; i < w.inventoryEnd; i++) {
    const y = w.slots[i]
    sim.push(y ? { type: y.type, count: y.count, stackSize: y.stackSize || 64, sig: itemStackSig(y) } : null)
  }
  for (const x of items) {
    if (!x || x.count <= 0) continue
    let left = x.count
    const stackSize = x.stackSize || 64
    const sig = itemStackSig(x)
    for (const slot of sim) {
      if (left <= 0) break
      if (slot && slot.type === x.type && slot.count < slot.stackSize && slot.sig === sig) {
        const add = Math.min(left, slot.stackSize - slot.count)
        slot.count += add
        left -= add
      }
    }
    for (let i = 0; i < sim.length && left > 0; i++) {
      if (!sim[i]) {
        const add = Math.min(left, stackSize)
        sim[i] = { type: x.type, count: add, stackSize, sig }
        left -= add
      }
    }
    if (left > 0) return false
  }
  return true
}

async function opTake(s, w, kind, { from, item, count }) {
  const secs = kind.sections(w)
  if (!secs[from]) fail('bad_section', `section "${from}" not in ${shortType(w.type)}; have: ${Object.keys(secs).join(', ')}`)
  const isOutput = (kind.outputs || []).includes(from)
  const xp0 = s.bot.experience.level
  const before = windowInvCounts(w)
  let left = count ?? Infinity
  let full = false
  // 成品由服务器计算后下发（锻造台、砂轮等），刚放完材料时可能还没到，稍等
  if (isOutput) for (let k = 0; k < 15 && !secs[from].some(i => w.slots[i]); k++) await sleep(100)
  for (const i of secs[from]) {
    if (left <= 0) break
    const cur = w.slots[i]
    if (!cur || (item && cur.name !== item)) continue
    const room = roomFor(w, cur)
    if (isOutput ? room < cur.count : room <= 0) {
      // 取到一部分就算成功（标 inventory_full）；一个都没取到才报错
      if (Object.keys(diffGain(before, windowInvCounts(w))).length) { full = true; break }
      fail('inventory_full', `no room in the inventory for ${cur.count} ${cur.name}; free a slot first (nothing was moved)`, { room, empty_slots: range(w.inventoryStart, w.inventoryEnd).filter(k => !w.slots[k]).length })
    }
    if (isOutput) {
      // 成品槽只能整组取：点一下拿到光标上，再放回背包
      await s.bot.clickWindow(i, 0, 0)
      await sleep(250)
      if (!w.selectedItem) fail('option_unavailable', `server refused to hand out ${cur.name} (not enough xp/payment?)`)
      await s.bot.putSelectedItemRange(w.inventoryStart, w.inventoryEnd, w, null)
      left -= cur.count
    } else {
      const n = Math.min(cur.count, left, room)
      if (n < Math.min(cur.count, left)) full = true
      if (n >= cur.count) await s.bot.putAway(i)
      else await s.bot.transfer({ window: w, itemType: cur.type, metadata: null, sourceStart: i, sourceEnd: i + 1, destStart: w.inventoryStart, destEnd: w.inventoryEnd, count: n })
      left -= n
    }
    await sleep(150)
  }
  const gained = diffGain(before, windowInvCounts(w))
  if (!Object.keys(gained).length) fail(isOutput ? 'no_output' : 'missing_item', `nothing${item ? ' matching ' + item : ''} to take from ${from}`)
  const dxp = s.bot.experience.level - xp0
  return { took: gained, from, ...(full ? { inventory_full: true } : {}), ...(dxp < 0 ? { xp_spent: -dxp } : dxp > 0 ? { xp_gained: dxp } : {}) }
}

async function opSelect(s, w, kind, { option, times = 1 }) {
  if (!kind.select) fail('bad_args', `${shortType(w.type)} has no selectable options`)
  if (!Number.isInteger(option) || option < 0) fail('bad_args', 'option must be a non-negative integer')
  times = strictPositiveInt(times, 'times', 64)
  // 附魔台放入物品后，三个选项要等服务器算完再推过来
  if (w.type === 'minecraft:enchantment') for (let i = 0; i < 20 && !((w.props || {})[option] > 0); i++) await sleep(100)
  const opts = kind.options ? kind.options(s, w, w.props || {}) : null
  if (opts && !opts.length) fail('bad_option', `${shortType(w.type)} has no options right now; put the input items in the same window/act call before select`)
  if (opts && (option < 0 || option >= opts.length)) fail('bad_option', `option ${option} out of range 0..${opts.length - 1}`)
  const o = opts && opts[option]
  if (o && o.available === false) fail('option_unavailable', `option ${option} is not available now`, { option: o })
  // mineflayer 在村民界面点击槽位时会读 window.selectedTrade（平时由它自己的 villager 插件设置）
  if (w.type === 'minecraft:merchant') w.selectedTrade = mineflayerTrade(s, w.trades[option])
  const results = []
  try {
    for (let n = 0; n < times && !s.interruptedBy && s.alive; n++) {
      // 村民：付款槽还够下一次时，服务器会直接把成品放好，不用再选一次
      if (!(w.type === 'minecraft:merchant' && n > 0 && w.slots[2])) {
        const watch = (kind.selectWatch || []).map(i => once(w, `updateSlot:${i}`, 2000))
        kind.select(s, w, option)
        await Promise.all(watch)
        await sleep(200)
      }
      if (w.type === 'minecraft:merchant') {
        // 选交易后服务器自动把付款放进 0/1 号槽，成品出现在 2 号槽，取走才算完成一次
        if (!w.slots[2]) { if (n === 0) fail('option_unavailable', 'trade produced no result (not enough payment?)'); break }
        const t = w.trades && w.trades[option]
        const needed = [w.slots[2]]
        if (w.slots[0]) {
          const rem0 = w.slots[0].count - (t?.cost1?.count || 0)
          if (rem0 > 0) needed.push({ ...w.slots[0], count: rem0 })
        }
        if (w.slots[1]) {
          const rem1 = w.slots[1].count - (t?.cost2?.count || 0)
          if (rem1 > 0) needed.push({ ...w.slots[1], count: rem1 })
        }
        if (!canFitItems(w, needed)) {
          if (results.length > 0) break
          fail('inventory_full', `no room in the inventory for ${w.slots[2].count} ${w.slots[2].name} plus payment change; free a slot first (nothing was moved)`)
        }
        results.push(await opTake(s, w, kind, { from: 'output' }))
        if (t) {
          t.uses++
          if (t.uses >= t.max_uses) t.disabled = true
          w.selectedTrade = mineflayerTrade(s, t)
          if (t.disabled || !hasItems(s, w, [t.cost1, t.cost2].filter(Boolean))) { n = times } // 用完次数或付不起，提前结束
        }
      } else if (w.type === 'minecraft:enchantment') {
        results.push({ enchanted: w.slots[0] && w.slots[0].name, enchantments: w.slots[0] ? itemExtras(w.slots[0]).enchantments || [] : null, xp_level: s.bot.experience.level })
      } else results.push({ selected: option })
    }
  } finally {
    // 交易完（或提前中止/报错）把留在付款槽的物品按背包剩余空间安全退回，避免界面关闭时被服务端扔到地上
    if (w.type === 'minecraft:merchant' && s.bot) {
      for (const i of [0, 1]) {
        const cur = w.slots[i]
        if (!cur) continue
        const room = roomFor(w, cur)
        if (room <= 0) continue
        if (room >= cur.count) await s.bot.putAway(i).catch(() => {})
        else await s.bot.transfer({ window: w, itemType: cur.type, metadata: null, sourceStart: i, sourceEnd: i + 1, destStart: w.inventoryStart, destEnd: w.inventoryEnd, count: room }).catch(() => {})
        await sleep(100)
      }
    }
  }
  return { selected: option, times: results.length, results }
}

const once = (emitter, ev, ms) => new Promise(resolve => {
  const t = setTimeout(() => { emitter.removeListener(ev, h); resolve(null) }, ms)
  const h = (...a) => { clearTimeout(t); resolve(a) }
  emitter.once(ev, h)
})

async function opText(s, w, kind, { value }) {
  if (!kind.text) fail('bad_args', `${shortType(w.type)} has no text input`)
  if (typeof value !== 'string') fail('bad_args', 'value must be a string')
  kind.text(s, w, value.slice(0, 50))
  await once(w, 'updateSlot:2', 1500)
  await sleep(200)
  return { text: value.slice(0, 50) }
}

const WINDOW_OPS = { put: opPut, take: opTake, select: opSelect, text: opText }

// 从结果格 shift-click 取出产物，确认真的进了背包。背包满（又没有能叠加的同种堆）时服务器不动物品，
// 以前会当作成功再请求 64 轮，卡 30 多秒后报 missing_ingredients "could not craft X: null"。
// 工作台界面开着时 bot.inventory 要等关窗才同步，所以数的是当前窗口里背包那几格。
async function takeCraftResult(s, win, id) {
  const count = () => win.slots.slice(win.inventoryStart, win.inventoryEnd).reduce((n, it) => n + (it && it.type === id ? it.count : 0), 0)
  const had = count()
  await s.bot.clickWindow(0, 0, 1)
  for (let i = 0; i < 8; i++) {
    await sleep(i ? 100 : 250)
    if (count() > had) return true
  }
  return false
}

function failInventoryFull(s, name, made) {
  fail('inventory_full', `no room in the inventory for ${name} (free a slot or drop something)`, { gained: made, empty_slots: s.bot.inventory.emptySlotCount(), inventory: invCounts(s.bot) })
}

function missingIngredients(s, recipe) {
  const needs = {}
  for (const d of (recipe.delta || [])) if (d.count < 0) { const n = s.mcData.items[d.id].name; needs[n] = (needs[n] || 0) - d.count }
  return needs
}

async function craftManually(s, it, count, table, known) {
  const before = invCounts(s.bot)[it.name] || 0
  const gridW = table ? 3 : 2
  let full = false
  for (let round = 0; round < 64 && !s.interruptedBy && s.alive && (invCounts(s.bot)[it.name] || 0) - before < count; round++) {
    requireConnected(s)
    const recipe = s.bot.recipesFor(it.id, null, 1, table)[0]
    if (!recipe) break
    const win = table ? await openTable(s, table) : s.bot.inventory
    const gridSize = gridW * gridW
    const invStart = table ? win.inventoryStart : 9
    const invEnd = table ? win.inventoryEnd : 45
    let lastSrc = -1
    try {
      const cells = []
      if (recipe.inShape) recipe.inShape.forEach((row, r) => row.forEach((ing, c) => { if (ing && ing.id !== -1) cells.push([1 + r * gridW + c, ing.id]) }))
      else recipe.ingredients.forEach((ing, i) => cells.push([1 + i, ing.id]))
      for (const [gridSlot, id] of cells) {
        if (s.interruptedBy || !s.alive) break
        const src = win.slots.findIndex((si, i) => i >= invStart && i < invEnd && si && si.type === id)
        if (src < 0) fail('missing_ingredients', `ran out of ${s.mcData.items[id].name}`, { example_recipe_needs: missingIngredients(s, recipe), inventory: invCounts(s.bot) })
        lastSrc = src
        await s.bot.clickWindow(src, 0, 0); await sleep(120)
        await s.bot.clickWindow(gridSlot, 1, 0); await sleep(120)
        await s.bot.clickWindow(src, 0, 0); await sleep(120)
        lastSrc = -1
      }
      if (s.interruptedBy || !s.alive) break
      for (let i = 0; i < 10 && !win.slots[0] && !s.interruptedBy; i++) await sleep(100)
      if (s.interruptedBy || !s.alive) break
      if (!win.slots[0] || win.slots[0].type !== it.id) break
      if (!await takeCraftResult(s, win, it.id)) { full = true; break }
    } finally {
      if (s.bot) {
        // 先把光标上可能悬空的整组材料放回原槽或空位，避免关窗时被服务端扔到地上
        if (win.selectedItem) {
          const fallbackSlot = (lastSrc >= invStart && lastSrc < invEnd && (!win.slots[lastSrc] || win.slots[lastSrc].type === win.selectedItem.type))
            ? lastSrc
            : win.slots.findIndex((si, i) => i >= invStart && i < invEnd && !si)
          if (fallbackSlot >= 0) {
            await s.bot.clickWindow(fallbackSlot, 0, 0).catch(() => {})
            await sleep(80)
          }
          if (win.selectedItem && roomFor(win, win.selectedItem) >= win.selectedItem.count) {
            await s.bot.putSelectedItemRange(invStart, invEnd, win, null).catch(() => {})
            await sleep(80)
          }
        }
        for (let sl = 1; sl <= gridSize; sl++) if (win.slots[sl]) { await s.bot.clickWindow(sl, 0, 1).catch(() => {}); await sleep(80) }
        if (table && s.bot.currentWindow === win) s.bot.closeWindow(win)
      }
    }
  }
  if (!full && !s.interruptedBy && s.alive) await sleepInterruptible(s, 1500)
  const made = (invCounts(s.bot)[it.name] || 0) - before
  if (s.interruptedBy || !s.alive) return made > 0 ? { crafted: it.name, gained: made, used_table: !!table, method: 'manual', inventory: invCounts(s.bot) } : {}
  if (full && made < count) failInventoryFull(s, it.name, made)
  if (made <= 0) fail('missing_ingredients', `could not craft ${it.name}`, { example_recipe_needs: missingIngredients(s, known[0]), inventory: invCounts(s.bot) })
  return { crafted: it.name, gained: made, used_table: !!table, method: 'manual', inventory: invCounts(s.bot) }
}

function autoPlaceSite(s) {
  const me = s.bot.entity.position.floored()
  const cands = []
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 1; dy++) {
    if (Math.abs(dx) + Math.abs(dz) < 2) continue
    const p = me.offset(dx, dy, dz)
    const at = s.bot.blockAt(p); const below = s.bot.blockAt(p.offset(0, -1, 0)); const above = s.bot.blockAt(p.offset(0, 1, 0))
    if (at && below && above && at.boundingBox === 'empty' && !at.name.includes('water') && below.boundingBox === 'block' && !below.name.endsWith('_leaves') && above.boundingBox === 'empty') cands.push(p)
  }
  cands.sort((a, b) => (Math.abs(a.y - me.y) - Math.abs(b.y - me.y)) || (a.distanceTo(me) - b.distanceTo(me)))
  return cands[0]
}

// API handlers - each receives (session, args) and returns result
const api = {
  // ---------- observation ----------
  async status(s) {
    if (s.readiness.guardsWorld && !(s.bot?.entity && s.isReady())) {
      const state = s.readiness.state()
      return { username: s.profile.name, server: s.readiness.server, ready: false, readiness_state: state === 'confirmed' ? 'loading_world' : state }
    }
    if (!s.bot || !s.bot.entity) fail('not_connected', 'bot not connected')
    const b = s.bot
    const e = b.entity
    const p = e.position
    const feet = b.blockAt(p)
    const head = b.blockAt(p.offset(0, 1.62, 0))
    const vehicle = b.vehicle
    return {
      username: b.username, pos: fmt(p), yaw: +e.yaw.toFixed(2),
      // 按每个物理 tick 的实际位移算；骑乘时位置是 driveVehicle 自己逐帧写的，给 null
      ...(b.vehicle || !s.motion ? { speed: null, velocity: null } : s.motion.summary()),
      dimension: b.game.dimension, gamemode: b.game.gameMode,
      health: b.health, food: b.food, saturation: +(b.foodSaturation || 0).toFixed(1),
      xp_level: b.experience.level, xp_progress: +((b.experience && b.experience.progress) || 0).toFixed(3),
      oxygen: b.oxygenLevel, armor_points: armorPoints(b),
      held: itemSummary(b.heldItem), offhand: itemSummary(b.inventory.slots[45]),
      effects: effectList(s),
      on_fire: !!(e.metadata && (e.metadata[0] & 0x01)),
      is_sleeping: !!b.isSleeping,
      in_water: isWaterBlock(feet) || isWaterBlock(head),
      submerged: isWaterBlock(head),
      in_lava: !!feet && feet.name === 'lava',
      in_vehicle: vehicle ? { id: vehicle.id, name: vehicle.name } : null,
      sneaking: !!b.getControlState('sneak'),
      held_controls: s.heldControl ? { keys: s.heldControl.keys, release_in_ms: Math.max(0, s.heldControl.until - Date.now()) } : null,
      jumping: !!b.getControlState('jump'),
      blocking: !!(s.posture.shield && b.inventory.slots[45] && b.inventory.slots[45].name === 'shield'),
      using_item: s.usingItem ? { name: s.usingItem.name, elapsed_ms: Date.now() - s.usingItem.t } : null,
      time_of_day: b.time.timeOfDay, is_day: b.time.isDay,
      raining: b.isRaining, thundering: !!b.thunderState,
      biome: feet && feet.biome && feet.biome.name, on_ground: e.onGround,
      // ready：就绪适配器确认已在目标服务器且存活，可以调用动作接口
      alive: s.alive, ready: !!(s.alive && s.isReady()), busy: s.busy && s.busy.name,
      // server：多后端部署时这个账号被分配到的后端（就绪适配器给出才有）
      ...(s.readiness.server ? { server: s.readiness.server } : {}),
      ...(s.readiness.guardsWorld ? { readiness_state: s.alive ? 'ready' : 'dead' } : {}),
      nearest_hostile: s.nearestHostile(24),
      ...(s.lastDeath ? { last_death: s.lastDeath } : {})
    }
  },
  async inventory(s) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    const slots = s.bot.inventory.slots
    return {
      items: s.bot.inventory.items().map(itemSummary),
      armor: { head: itemSummary(slots[5]), chest: itemSummary(slots[6]), legs: itemSummary(slots[7]), feet: itemSummary(slots[8]) },
      offhand: itemSummary(slots[45]), held: itemSummary(s.bot.heldItem), empty_slots: s.bot.inventory.emptySlotCount()
    }
  },
  async find_blocks(s, { types, radius = 16, limit = 20, properties, mature }) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    if (types !== undefined && types !== null && !Array.isArray(types)) fail('bad_args', 'types must be an array of block names')
    const hasTypes = Array.isArray(types) && types.length > 0
    const maxRadius = hasTypes ? 128 : 64
    radius = Number(radius)
    limit = Number(limit)
    if (!Number.isFinite(radius) || radius < 1) fail('bad_args', `radius must be a number between 1 and ${maxRadius}`)
    if (!Number.isFinite(limit) || limit < 1) fail('bad_args', 'limit must be a positive number')
    radius = Math.min(radius, maxRadius)
    const skip = new Set(['air', 'cave_air', 'void_air'])
    const me = s.bot.entity.position
    if ((properties || mature !== undefined) && !hasTypes) fail('bad_args', 'properties / mature filters require types')
    if (hasTypes) {
      const ids = types.map(n => { const b = s.mcData.blocksByName[n]; if (!b) fail('bad_args', `unknown block ${n}`); return b.id })
      if (properties) checkPropFilter(s, types, properties)
      if (mature !== undefined && !types.some(n => CROP_AGE_PROP[n])) fail('bad_args', `mature filter only applies to crops: ${Object.keys(CROP_AGE_PROP).join(', ')}`)
      const idSet = new Set(ids)
      const stateBlock = s.mcData.blocksByStateId
      const found = []
      for (const [x, y, z] of await scanExposed(s, radius, v => { const b = stateBlock[v]; return !!b && idSet.has(b.id) }, 10000)) {
        const p = new Vec3(x, y, z)
        const b = s.bot.blockAt(p)
        if (!b) continue
        const props = blockProps(b)
        if (properties && Object.entries(properties).some(([k, v]) => String(props[k]) !== String(v))) continue
        const crop = cropInfo(s, b, props)
        if (mature !== undefined && crop.mature !== !!mature) continue
        found.push({ name: b.name, pos: [p.x, p.y, p.z], dist: +p.distanceTo(me).toFixed(1), properties: props, ...crop })
      }
      found.sort((a, b) => a.dist - b.dist)
      return { total: found.length, blocks: found.slice(0, limit) }
    }
    const stateBlock = s.mcData.blocksByStateId
    const pts = await scanExposed(s, radius, v => { const b = stateBlock[v]; return !!b && !skip.has(b.name) }, 4000)
    const summary = {}
    for (const [x, y, z, d, v] of pts) {
      const n = stateBlock[v].name
      const rec = summary[n] || (summary[n] = { count: 0, nearest: null, rawDist: Infinity })
      rec.count++
      if (d < rec.rawDist) { rec.rawDist = d; rec.nearest = [x, y, z] }
    }
    const blocks = Object.fromEntries(
      Object.entries(summary)
        .sort((a, b) => a[1].rawDist - b[1].rawDist)
        .map(([n, rec]) => [n, { count: rec.count, nearest: rec.nearest, dist: +rec.rawDist.toFixed(1) }])
    )
    return { radius, scanned: pts.length, blocks }
  },
  async get_entities(s, { radius = 32, types }) {
    if (!s.bot || !s.bot.entity) fail('not_connected', 'bot not connected')
    if (types !== undefined && types !== null && !Array.isArray(types)) fail('bad_args', 'types must be an array of entity names or types')
    const hasTypes = Array.isArray(types) && types.length > 0
    radius = Number(radius)
    if (!Number.isFinite(radius) || radius <= 0) fail('bad_args', 'radius must be a positive number')
    const me = s.bot.entity.position
    return {
      entities: Object.values(s.bot.entities)
        .filter(e => e !== s.bot.entity && e.position.distanceTo(me) <= radius)
        .filter(e => !hasTypes || types.includes(e.name) || types.includes(e.type))
        .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
        .slice(0, 40)
        .map(e => {
          const o = { id: e.id, type: e.type, name: e.username || e.name, pos: fmt(e.position), dist: +e.position.distanceTo(me).toFixed(1) }
          if (e.name === 'item') { const d = e.getDroppedItem(); if (d) o.item = `${d.name}x${d.count}` }
          if (e.health !== undefined && e.type !== 'object') o.health = e.health
          return o
        })
    }
  },
  async events(s, { since = 0, limit = 50 } = {}) {
    // GET 查询串进来的是字符串，POST 体里是数字，统一按数字校验
    since = Number(since)
    limit = Number(limit)
    if (!Number.isFinite(since) || since < 0) fail('bad_args', 'since must be a non-negative number')
    if (!Number.isFinite(limit) || limit < 1 || limit > 500) fail('bad_args', 'limit must be between 1 and 500')
    const all = s.events.filter(e => e.seq > since)
    // 取"最早的 N 条"而不是最新的 N 条：配合 last_seq 轮询才不会漏事件
    const events = all.slice(0, limit)
    const lastSeq = events.length ? events[events.length - 1].seq : s.seq
    return { since, last_seq: lastSeq, total: all.length, has_more: all.length > events.length, events }
  },
  async advancements(s, { status = 'all', include_recipes = false, namespace, ids, include_criteria = true } = {}) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    if (!s.isReady()) fail('wrong_server', 'bot is not ready on the target server')
    if (!s.advancementsReady) fail('not_ready', 'advancement data has not arrived yet')
    if (!['all', 'completed', 'in_progress', 'not_started'].includes(status)) fail('bad_args', 'status must be all, completed, in_progress, or not_started')
    if (namespace !== undefined && (typeof namespace !== 'string' || !namespace.length)) fail('bad_args', 'namespace must be a non-empty string')
    if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) fail('bad_args', 'ids must be an array of strings')
    const idFilter = ids && new Set(ids)
    const hiddenRecipes = [...s.advancementDefinitions.values()].filter(def => def.recipe).length
    const base = [...s.advancementDefinitions.values()]
      .filter(def => include_recipes || !def.recipe)
      .filter(def => !namespace || def.id.startsWith(namespace + ':'))
      .filter(def => !idFilter || idFilter.has(def.id))
      .map(def => advancementResult(def, s.advancementProgress.get(def.id), include_criteria !== false))
      .sort((a, b) => a.id.localeCompare(b.id))
    const counts = { completed: 0, in_progress: 0, not_started: 0 }
    for (const a of base) counts[a.status]++
    return {
      ready: true,
      updated_at: s.advancementsUpdatedAt,
      packets_received: s.advancementPackets,
      summary: {
        total: base.length,
        ...counts,
        recipes_included: !!include_recipes,
        recipes_hidden: include_recipes ? 0 : hiddenRecipes
      },
      advancements: status === 'all' ? base : base.filter(a => a.status === status)
    }
  },
  async get_block(s, { x, y, z }) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    // 严格校验坐标：拒绝 undefined / null / "" / boolean / NaN，避免静默转成 0 或误报 not_loaded
    const bx = strictCoordinate(x, 'x', 'get_block')
    const by = strictCoordinate(y, 'y', 'get_block')
    const bz = strictCoordinate(z, 'z', 'get_block')
    const b = s.bot.blockAt(new Vec3(bx, by, bz).floored())
    if (!b) fail('not_loaded', 'chunk not loaded')
    const props = blockProps(b)
    return { name: b.name, pos: [Math.floor(bx), Math.floor(by), Math.floor(bz)], properties: props, ...cropInfo(s, b, props), diggable: b.diggable, hardness: b.hardness, harvest_tool_ok: s.bot.canDigBlock(b) }
  },

  // ---------- actions ----------
  async move_to(s, { x, y, z, range, entity_id, timeout = 60000, allow_partial = false }) {
    const bot = requireConnected(s)
    const dimensionBefore = bot.game.dimension
    const hasRange = range !== undefined && range !== null
    if (hasRange) {
      range = Number(range)
      if (!Number.isFinite(range) || range < 0) fail('bad_args', 'range must be a non-negative number')
    }
    timeout = Number(timeout)
    if (!Number.isFinite(timeout) || timeout <= 0) fail('bad_args', 'timeout must be a positive number')
    if (typeof allow_partial !== 'boolean') fail('bad_args', 'allow_partial must be a boolean')
    if (entity_id === undefined) {
      x = movementCoordinate(x, 'x')
      z = movementCoordinate(z, 'z')
      if (y != null && !bot.vehicle) y = movementCoordinate(y, 'y')
    }
    // 骑着东西时不能走，只能掌舵：同一个接口自动切到载具模式（y 忽略）
    if (bot.vehicle) {
      const target = entity_id !== undefined ? bot.entities[entity_id] : null
      if (entity_id !== undefined && !target) fail('no_such_entity', `entity ${entity_id} not visible`)
      const tx = target ? target.position.x : x
      const tz = target ? target.position.z : z
      const out = await driveVehicle(s, tx, tz, Math.max(hasRange ? range : 1, 1.5), timeout)
      requireConnected(s, bot)
      return { ...out, pos: fmt(bot.entity.position), drove: true }
    }

    let aimX, aimY = null, aimZ, bx, by = null, bz, hasY, effRange, isItem = false
    if (entity_id !== undefined) {
      const e = bot.entities[entity_id]
      if (!e) fail('no_such_entity', `entity ${entity_id} not visible`)
      isItem = e.name === 'item'
      effRange = hasRange ? range : (isItem ? 0.5 : 2)
      aimX = e.position.x; aimY = e.position.y; aimZ = e.position.z
      bx = Math.floor(aimX); by = Math.floor(aimY); bz = Math.floor(aimZ)
      hasY = true
    } else {
      effRange = hasRange ? range : 1
      aimX = Number.isInteger(x) ? x + 0.5 : x
      aimZ = Number.isInteger(z) ? z + 0.5 : z
      bx = Math.floor(x); bz = Math.floor(z)
      hasY = y !== undefined && y !== null
      if (hasY) { aimY = y; by = Math.floor(y) }
    }

    const distTo = p => hasY
      ? Math.hypot(p.x - aimX, p.y - aimY, p.z - aimZ)
      : Math.hypot(p.x - aimX, p.z - aimZ)
    const exact = effRange < 1
    const alignTol = Math.max(effRange, 0.15)
    const p0 = bot.entity.position
    const inTargetBlock = Math.floor(p0.x) === bx && Math.floor(p0.z) === bz && (!hasY || Math.abs(p0.y - by) <= 0.55)
    const alreadyAt = exact
      ? (inTargetBlock && Math.hypot(p0.x - aimX, p0.z - aimZ) <= alignTol)
      : (distTo(p0) <= effRange)
    if (alreadyAt) return { pos: fmt(p0), dist: +distTo(p0).toFixed(2) }

    const isFullSolid = b => !!b && b.boundingBox === 'block' && b.name !== 'ladder' && b.name !== 'vine' && (!Array.isArray(b.shapes) || b.shapes.length === 0 || b.shapes.some(sh => sh[4] >= 1))
    const t0 = Date.now()
    let pathRes = null
    try {
      if (exact && !allow_partial && hasY && typeof bot.blockAt === 'function') {
        const tb = bot.blockAt(new Vec3(bx, by, bz))
        if (isFullSolid(tb)) {
          fail('path_not_found', `target block (${bx}, ${by}, ${bz}) is solid (${tb.name}); use range >= 1 or aim above it`, {
            pos: fmt(p0), dist_left: +distTo(p0).toFixed(1), ms: 0, target_solid: true
          })
        }
      }
      if (!(exact && inTargetBlock)) {
        const goal = hasY
          ? (exact ? new goals.GoalBlock(bx, by, bz) : new goals.GoalNear(bx, by, bz, effRange))
          : (exact ? new goals.GoalXZ(bx, bz) : new goals.GoalNearXZ(bx, bz, effRange))
        pathRes = await gotoWatched(s, goal, timeout, { allowPartial: allow_partial })
      }
      if (exact && !(pathRes && pathRes.partial)) {
        await alignToPoint(s, aimX, aimZ, { tol: alignTol, stopWhen: isItem ? () => !bot.entities[entity_id] : null })
      }
    } catch (e) {
      // Entering an End portal changes dimension immediately. Pathfinder then
      // rejects its old-world goal, even though the requested movement worked.
      requireConnected(s, bot)
      if (bot.game.dimension !== dimensionBefore) {
        return { pos: fmt(bot.entity.position), dimension_changed: { from: dimensionBefore, to: bot.game.dimension } }
      }
      const from = bot.entity.position
      const diag = { pos: fmt(from), dist_left: +distTo(from).toFixed(1), ms: Date.now() - t0 }
      if (hasY && typeof bot.blockAt === 'function') {
        const tb = bot.blockAt(new Vec3(bx, by, bz))
        if (!tb) diag.target_unloaded = true
        else if (exact && tb.boundingBox === 'block') diag.target_solid = true
      } else if (!hasY && bot.world && typeof bot.world.getColumn === 'function') {
        if (!bot.world.getColumn(bx >> 4, bz >> 4)) diag.target_unloaded = true
      }
      if (e instanceof ApiError) {
        e.extra = { ...(e.extra || {}), ...diag }
        throw e
      }
      fail('path_not_found', e.message, diag)
    }
    requireConnected(s, bot)
    const pf = bot.entity.position
    return {
      pos: fmt(pf),
      dist: +distTo(pf).toFixed(2),
      ...(pathRes && pathRes.partial ? { partial: true } : {})
    }
  },
  async dig(s, { x, y, z, collect = true }) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    const p = new Vec3(
      strictCoordinate(x, 'x', 'dig'),
      strictCoordinate(y, 'y', 'dig'),
      strictCoordinate(z, 'z', 'dig')
    ).floored()
    const block = s.bot.blockAt(p)
    if (!block) fail('not_loaded', 'chunk not loaded')
    if (block.name.endsWith('air') || block.boundingBox === 'empty' && !block.name.includes('grass') && !block.name.includes('flower')) {
      if (block.name.endsWith('air')) fail('nothing_to_dig', `block at ${p} is ${block.name}`)
    }
    if (!block.diggable) fail('undiggable', `${block.name} is not diggable`)
    await goNear(s, p, 3.5, 60000, 5.0)
    const best = selectBestHarvestTool(s.bot, block)
    const tool = best && /_(pickaxe|axe|shovel|hoe|sword)$|^shears$/.test(best.name) ? best : null
    if (tool) await s.bot.equip(tool, 'hand')
    // 空手挖：背包没有空格时 mineflayer 的 unequip('hand') 会把手上整组扔到地上（实测 64 钻石），这时就拿着它挖
    else if (s.bot.heldItem && s.bot.inventory.emptySlotCount() > 0) await s.bot.unequip('hand')
    if (!s.bot.canDigBlock(block)) fail('out_of_reach', `cannot reach ${block.name} at ${p}`, { pos: fmt(s.bot.entity.position) })
    const harvestable = !block.harvestTools || Object.keys(block.harvestTools).some(id => s.bot.inventory.items().some(i => i.type === +id))
    const before = invCounts(s.bot)
    for (let i = 0; i < 20 && !s.bot.entity.onGround; i++) await sleep(50)
    // mineflayer 挖完会先把本地方块改成空气（客户端预测），服务端拒绝时只回 ack、不发方块更新，
    // 原版客户端靠 ack 回滚预测，mineflayer 不回滚 —— 以前这里读本地缓存会把"没挖掉"报成成功。
    // 现在只认服务端发来的这一格的 block_change / multi_block_change。
    const watch = watchServerBlock(s.bot, p)
    const eye = s.bot.entity.position.offset(0, s.bot.entity.eyeHeight || 1.62, 0)
    const reachDist = +eye.distanceTo(block.position.offset(0.5, 0.5, 0.5)).toFixed(2)
    const t0 = Date.now()
    let after
    try {
      await withTimeout(s.bot.dig(block, true), 30000, 'dig').catch(e => {
        if (s.bot && s.bot.targetDigBlock) { try { s.bot.stopDigging() } catch {} }
        if (!s.interruptedBy) throw e
      })
      if (s.interruptedBy) return {}
      // 服务端判定挖得"太快"时会延后补完（还要几 tick），再加上来回延迟
      const ping = (s.bot.player && s.bot.player.ping) || 0
      const deadline = Date.now() + Math.min(6000, 1500 + 3 * ping)
      while (Date.now() < deadline && (watch.state === null || watch.state === block.stateId)) await sleep(25)
      after = watch.state
    } finally {
      if (s.bot && s.bot.targetDigBlock) { try { s.bot.stopDigging() } catch {} }
      watch.stop()
    }
    const digMs = Date.now() - t0
    if (after === null || after === block.stateId) {
      // 把本地的预测撤回成服务端的真实状态，后续 get_block / find_blocks 才不会被骗
      try { s.bot._updateBlockState(block.position, block.stateId) } catch (e) {}
      const diag = { pos: fmt(s.bot.entity.position), eye_dist: reachDist, on_ground: !!s.bot.entity.onGround, ping_ms: s.bot.player ? s.bot.player.ping : null }
      if (after === block.stateId) fail('protected_region', `server reverted the dig of ${block.name} (protection, game mode or plugin)`, diag)
      fail('dig_unconfirmed', `server did not confirm breaking ${block.name}; it is still there (usually: server thinks the bot is too far away / position out of sync)`, diag)
    }
    await sleep(100)
    if (collect) await collectDrops(s, p)
    const gained = {}
    for (const [k, v] of Object.entries(invCounts(s.bot))) if (v > (before[k] || 0)) gained[k] = v - (before[k] || 0)
    return { dug: block.name, dig_ms: digMs, tool: tool ? tool.name : 'hand', gained, ...(harvestable ? {} : { warning: 'no proper tool: block drops nothing' }) }
  },
  async place(s, { item, x, y, z }) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    if (x === undefined && y === undefined && z === undefined) {
      const site = autoPlaceSite(s)
      if (!site) fail('no_support', 'no free spot with solid ground within 3 blocks')
      ;({ x, y, z } = site)
    }
    const target = new Vec3(
      strictCoordinate(x, 'x', 'place'),
      strictCoordinate(y, 'y', 'place'),
      strictCoordinate(z, 'z', 'place')
    ).floored()
    x = target.x; y = target.y; z = target.z
    const cur = s.bot.blockAt(target)
    if (cur && cur.boundingBox !== 'empty') fail('occupied', `${cur.name} already at target`)
    const it = findItem(s, item)
    // 睡莲 / 蛙卵只能放在水面上：没有"贴着实心方块放"这回事，按视线对着下面的水用
    if (item === 'lily_pad' || item === 'frogspawn') {
      const water = waterAimTarget(s, target, item)
      if (!water) fail('no_support', `${item} must be placed on a water source (the block below the target)`)
      await goNear(s, water, 3, 60000, 4.5)
      await s.bot.equip(it, 'hand')
      const r = await useBucket(s, water, item)
      const now = s.bot.blockAt(target)
      if (!now || now.name !== item) fail('place_failed', `server did not place ${item}`, r)
      return { placed: now.name, pos: [x, y, z], sneaked: false }
    }
    const faces = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].map(a => new Vec3(...a))
    let ref = null; let face = null
    for (const f of faces) {
      const r = s.bot.blockAt(target.plus(f))
      if (r && r.boundingBox === 'block') { ref = r; face = f.scaled(-1); break }
    }
    if (!ref) fail('no_support', 'no solid neighbour block to place against')
    await goNear(s, target, 3.5, 60000, 5.0)
    if (s.bot.entity.position.floored().equals(target) || s.bot.entity.position.floored().offset(0, 1, 0).equals(target)) fail('blocked_by_self', 'bot is standing in target cell')
    await s.bot.equip(it, 'hand')
    // 放置瞬间潜行：对着箱子/工作台/熔炉/床这类可交互方块右键时，只有潜行才会真的"放置"而不是打开界面。
    // 这是平台该替 agent 处理的机制，不暴露成参数。
    s.bot.setControlState('sneak', true)
    try {
      try {
        await s.bot.placeBlock(ref, face)
      } catch (e) {
        await sleep(300)
        const now = s.bot.blockAt(target)
        if (!now || now.boundingBox === 'empty') {
          if (s.bot.currentWindow) {
            s.bot.closeWindow(s.bot.currentWindow)
            fail('use_window_api', `placing against ${ref.name} opened a GUI; use a different neighbour face or window/*`, { target: [x, y, z], ref: ref.name })
          }
          fail('place_failed', e.message)
        }
      }
    } finally {
      if (s.bot) { try { s.bot.setControlState('sneak', !!s.posture.sneak) } catch {} }
    }
    await sleep(250)
    const now = s.bot.blockAt(target)
    if (!now || now.name === 'air') fail('protected_region', 'server reverted the placement')
    return { placed: now.name, pos: [x, y, z], sneaked: true }
  },
  // 右键一个目标：方块（门/拉杆/床/耕地/骨粉/打火石/桶）或实体（上船/上马/喂食/剪毛/挤奶/拴绳）
  async interact(s, { x, y, z, entity_id, item }) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    if (entity_id !== undefined) return await interactEntity(s, entity_id, item)
    const p = new Vec3(
      strictCoordinate(x, 'x', 'interact'),
      strictCoordinate(y, 'y', 'interact'),
      strictCoordinate(z, 'z', 'interact')
    ).floored()
    const block = s.bot.blockAt(p)
    if (!block) fail('not_loaded', 'chunk not loaded')
    await goNear(s, p, 3)
    if (!item && block.name.endsWith('_bed')) {
      // 睡着时再点一次床就是起床
      if (s.bot.isSleeping) return await leaveBed(s)
      const night = !s.bot.time.isDay || !!s.bot.thunderState
      if (night) {
        try { await s.bot.sleep(block); return { slept: true } } catch (e) { /* 入睡失败也要把右键包发出去 */ }
      }
      // 白天（或入睡失败）仍然发一次原生右键：至少能把重生点绑到床上，
      // 而不是本地 sleep 校验直接 cannot_sleep 一个包都不发。
      await s.bot.activateBlock(block)
      await sleep(300)
      // mineflayer 的"白天"判断比原版宽（原版 12542 起就能睡），服务端可能已经让 bot 躺下了
      if (s.bot.isSleeping) return { slept: true }
      return { slept: false, interacted: true, daytime: !night }
    }
    if (item) await s.bot.equip(findItem(s, item), 'hand')
    // 炼药锅的装 / 舀是方块交互（右键方块包），其他桶都走视线判定
    if (item && /bucket$/.test(item) && item !== 'milk_bucket' && !/cauldron$/.test(block.name)) return await useBucket(s, p, item)
    const waterAt = item && waterAimTarget(s, p, item)
    if (waterAt) return await useBucket(s, waterAt, item)
    const above = p.offset(0, 1, 0)
    const upBefore = s.bot.blockAt(above)
    const invBefore = invCounts(s.bot)
    const windowBefore = s.bot.currentWindow
    await s.bot.activateBlock(block)
    await sleep(400)
    if (s.bot.currentWindow && s.bot.currentWindow !== windowBefore) {
      const title = s.bot.currentWindow.type
      s.bot.closeWindow(s.bot.currentWindow)
      fail('use_window_api', `${block.name} opens a GUI (${title}); use window/view or window/act`)
    }
    const aft = s.bot.blockAt(p)
    const upAfter = s.bot.blockAt(above)
    const used = {}
    for (const [k, v] of Object.entries(invBefore)) { const d = v - (invCounts(s.bot)[k] || 0); if (d > 0) used[k] = d }
    const changed = !aft || aft.stateId !== block.stateId || (upAfter && upBefore && upAfter.stateId !== upBefore.stateId)
    const props = aft ? blockProps(aft) : null
    return {
      block: block.name, before: blockProps(block),
      after: aft ? { name: aft.name, properties: props, ...cropInfo(s, aft, props) } : null,
      ...(upAfter && upBefore && upAfter.stateId !== upBefore.stateId ? { above: { before: upBefore.name, after: upAfter.name, properties: blockProps(upAfter) } } : {}),
      changed, ...(Object.keys(used).length ? { used } : {})
    }
  },
  // 攻击：按手持物品的原版攻速挥击（空手 250ms、剑 625ms、斧 1000ms…），
  // max_hits 用于"打一下就走"（风筝苦力怕、单次敲船/矿车）；
  // chase=false 用于原地站桩挥击（1x2 窄矿道/门洞近战防身，不开 GoalFollow 乱跑）；
  // feedback=true 开启逐次挥击回执 hit_log、stop_reason 与 attack_hit 事件（默认 false 保持旧版返回完全兼容）。
  async attack(s, { entity_id, timeout, max_hits, interval_ms, chase = true, feedback = false }) {
    const bot = requireConnected(s)
    const e = bot.entities[entity_id]
    if (!e) fail('no_such_entity', `entity ${entity_id} not visible`)
    if (max_hits !== undefined && (!Number.isInteger(max_hits) || max_hits < 1)) fail('bad_args', 'max_hits must be a positive integer')
    if (interval_ms !== undefined && (!Number.isFinite(interval_ms) || interval_ms < 50 || interval_ms > 5000)) fail('bad_args', 'interval_ms must be between 50 and 5000')
    if (typeof chase !== 'boolean') fail('bad_args', 'chase must be a boolean')
    if (typeof feedback !== 'boolean') fail('bad_args', 'feedback must be a boolean')
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 50 || timeout > 60000)) fail('bad_args', 'timeout must be between 50 and 60000')
    const effTimeout = timeout === undefined ? (chase ? 20000 : 1500) : timeout
    const weapon = bot.inventory.items().filter(i => /_sword$|_axe$/.test(i.name)).sort((a, b) => weaponScore(b) - weaponScore(a))[0]
    if (weapon) await bot.equip(weapon, 'hand')
    requireConnected(s, bot)
    const interval = interval_ms ?? attackIntervalMs(bot.heldItem)
    const t0 = Date.now(); let hits = 0
    const hit_log = feedback ? [] : null
    let stop_reason = null
    let blocking_block = null
    if (chase) bot.pathfinder.setGoal(new goals.GoalFollow(e, 1.5), true)
    try {
      while (s.bot === bot && bot.entities[entity_id] && e.isValid && Date.now() - t0 < effTimeout && !s.interruptedBy) {
        requireConnected(s, bot)
        const dist = e.position.distanceTo(bot.entity.position)
        if (dist < 3.2) {
          const entityHeight = e.height || 1.8
          const halfWidth = (e.width || 0.6) * 0.5
          const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
          const isBlocked = (blk, aim, aimDist) => {
            if (!blk || !blk.intersect || blk.boundingBox === 'empty') return false
            const dir = aimDist > 1e-6 ? aim.minus(eye).scaled(1 / aimDist) : null
            const boxT = dir ? rayBox(eye, dir, e.position.offset(-halfWidth, 0, -halfWidth), e.position.offset(halfWidth, entityHeight, halfWidth)) : null
            const reachLimit = boxT !== null ? boxT : Math.max(0, aimDist - halfWidth)
            return eye.distanceTo(blk.intersect) < reachLimit - 1e-3
          }
          const upperAim = e.position.offset(0, entityHeight * 0.8, 0)
          await bot.lookAt(upperAim, true)
          requireConnected(s, bot)
          if (!bot.entities[entity_id] || !e.isValid || s.interruptedBy) break
          let occluded = false
          if (!chase || feedback) {
            const upperDist = eye.distanceTo(upperAim)
            const upperBlk = typeof bot.blockAtCursor === 'function' ? bot.blockAtCursor(upperDist) : null
            if (isBlocked(upperBlk, upperAim, upperDist)) {
              const midAim = e.position.offset(0, entityHeight * 0.5, 0)
              await bot.lookAt(midAim, true)
              requireConnected(s, bot)
              if (!bot.entities[entity_id] || !e.isValid || s.interruptedBy) break
              const midDist = eye.distanceTo(midAim)
              const midBlk = typeof bot.blockAtCursor === 'function' ? bot.blockAtCursor(midDist) : null
              if (isBlocked(midBlk, midAim, midDist)) {
                occluded = true
                if (!chase) {
                  const blk = midBlk || upperBlk
                  blocking_block = { name: blk.name, pos: blk.position ? [blk.position.x, blk.position.y, blk.position.z] : null }
                  stop_reason = 'blocked_by_wall'
                  break
                }
              }
            }
          }
          bot.attack(e); hits++
          if (feedback) {
            const hitDist = e.position.distanceTo(bot.entity.position)
            const rec = {
              hit: hits,
              t_ms: Date.now() - t0,
              entity_id: e.id ?? entity_id,
              dist: +hitDist.toFixed(2),
              target_pos: [+e.position.x.toFixed(2), +e.position.y.toFixed(2), +e.position.z.toFixed(2)],
              bot_hp: bot.health !== undefined ? +bot.health.toFixed(1) : null,
              ...(occluded ? { occluded: true } : {}),
            }
            hit_log.push(rec)
            if (typeof s.pushEvent === 'function') s.pushEvent('attack_hit', rec)
          }
          if (max_hits && hits >= max_hits) {
            stop_reason = 'max_hits'
            break
          }
        }
        const rem = effTimeout - (Date.now() - t0)
        if (rem <= 0) break
        const waitMs = (dist < 3.2 || chase) ? interval : Math.min(interval, 100)
        await sleep(Math.min(waitMs, rem))
      }
    } finally {
      if (chase && bot.pathfinder) bot.pathfinder.setGoal(null)
    }
    requireConnected(s, bot)
    const killed = !bot.entities[entity_id] || !e.isValid
    if (!stop_reason) {
      if (killed) stop_reason = 'killed'
      else if (s.interruptedBy) stop_reason = 'interrupted'
      else if (!chase && hits === 0) stop_reason = 'out_of_reach'
      else stop_reason = 'timeout'
    }
    if (killed && chase) await collectDrops(s, e.position, 5)
    requireConnected(s, bot)
    const base = { killed, hits, interval_ms: interval, ms: Date.now() - t0, inventory: invCounts(bot) }
    if (!feedback && chase) return base
    return {
      ...base,
      ...(feedback ? { hit_log } : {}),
      stop_reason,
      ...(blocking_block ? { blocking_block } : {}),
    }
  },
  // Fire a bow, crossbow or trident at a visible entity or an explicit point.
  // The point form is useful for targets such as target blocks and buttons.
  async shoot(s, { entity_id, x, y, z, weapon, charge_ms }) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    const entity = entity_id === undefined ? null : s.bot.entities[entity_id]
    if (entity_id !== undefined && !entity) fail('no_such_entity', `entity ${entity_id} not visible`)
    if (!entity && ![x, y, z].every(Number.isFinite)) fail('bad_args', 'provide entity_id or numeric x, y and z')

    const available = s.bot.inventory.items().filter(i => PROJECTILE_PHYSICS[i.name])
    if (weapon !== undefined && !PROJECTILE_PHYSICS[weapon]) fail('bad_args', 'weapon must be bow, crossbow or trident')
    const item = weapon ? findItem(s, weapon) : available.find(i => i.name === 'bow') || available.find(i => i.name === 'crossbow') || available[0]
    if (!item) fail('missing_item', 'no bow, crossbow or trident in inventory', { inventory: invCounts(s.bot) })
    weapon = item.name

    if (weapon === 'bow' && !hasArrow(s.bot)) fail('missing_ammo', 'bow needs an arrow')
    if (weapon === 'crossbow' && !crossbowLoaded(item) && !hasArrow(s.bot) && !s.bot.inventory.items().some(i => i.name === 'firework_rocket')) {
      fail('missing_ammo', 'crossbow needs an arrow or firework rocket')
    }
    charge_ms = charge_ms === undefined ? PROJECTILE_PHYSICS[weapon].charge_ms : Number(charge_ms)
    if (!Number.isFinite(charge_ms) || charge_ms < 200 || charge_ms > 5000) fail('bad_args', 'charge_ms must be between 200 and 5000')

    const targetPoint = () => entity
      ? entity.position.offset(0, Math.max(0.35, (entity.height || 1.8) * 0.55), 0)
      : new Vec3(x, y, z)
    let physics = { ...PROJECTILE_PHYSICS[weapon] }
    if (weapon === 'bow') {
      const t = Math.min(charge_ms / 1000, 1)
      const power = Math.min((t * t + 2 * t) / 3, 1)
      physics.speed *= power
      if (power < 0.1) fail('bad_args', 'bow charge is too short to fire')
    }

    s.bot.pathfinder.setGoal(null)
    s.bot.clearControlStates()
    await s.bot.equip(item, 'hand')
    let aim = projectileAim(s.bot, targetPoint(), physics, entity && entity.velocity)
    if (aim.miss > 4) fail('out_of_range', 'no usable projectile trajectory found', { predicted_miss: +aim.miss.toFixed(2) })
    await s.bot.look(aim.yaw, aim.pitch, true)

    const before = invCounts(s.bot)
    const knownEntities = new Set(Object.keys(s.bot.entities))
    const healthBefore = entity && Number.isFinite(entity.health) ? entity.health : null
    const shootBot = s.bot
    try {
      if (weapon === 'crossbow') {
        if (!crossbowLoaded(shootBot.heldItem)) {
          shootBot.activateItem()
          const ok = await sleepInterruptible(s, charge_ms, shootBot)
          try { shootBot.deactivateItem() } catch {}
          if (!ok) return {}
          if (!await sleepInterruptible(s, 200, shootBot)) return {}
        }
        requireConnected(s, shootBot)
        if (s.interruptedBy || !s.alive) return {}
        aim = projectileAim(shootBot, targetPoint(), physics, entity && entity.velocity)
        await shootBot.look(aim.yaw, aim.pitch, true)
        requireConnected(s, shootBot)
        if (s.interruptedBy || !s.alive) return {}
        shootBot.activateItem()
        await sleepInterruptible(s, 150, shootBot)
        try { shootBot.deactivateItem() } catch {}
      } else {
        shootBot.activateItem()
        const ok = await sleepInterruptible(s, charge_ms, shootBot)
        if (!ok) return {}
        requireConnected(s, shootBot)
        aim = projectileAim(shootBot, targetPoint(), physics, entity && entity.velocity)
        await shootBot.look(aim.yaw, aim.pitch, true)
        requireConnected(s, shootBot)
        if (s.interruptedBy || !s.alive) return {}
        shootBot.deactivateItem()
      }
    } finally {
      if (s.bot === shootBot && shootBot._client?.state === 'play') {
        try { shootBot.deactivateItem() } catch {}
      }
    }
    if (s.interruptedBy || !s.alive) return {}
    await sleepInterruptible(s, 500, shootBot)
    if (s.interruptedBy || !s.alive) return {}

    const projectiles = Object.entries(s.bot.entities)
      .filter(([id, e]) => !knownEntities.has(id) && /arrow|trident|firework_rocket/.test(e.name || ''))
      .map(([, e]) => ({ id: e.id, name: e.name, pos: fmt(e.position) }))
    const after = invCounts(s.bot)
    const used = {}
    for (const [name, count] of Object.entries(before)) if (count > (after[name] || 0)) used[name] = count - (after[name] || 0)
    const healthAfter = entity && entity.isValid && Number.isFinite(entity.health) ? entity.health : null
    return {
      fired: true,
      weapon,
      target: fmt(targetPoint()),
      dist: +s.bot.entity.position.offset(0, 1.52, 0).distanceTo(targetPoint()).toFixed(2),
      charge_ms,
      aim: { flight_ticks: aim.ticks, elevation_degrees: +(aim.pitch * 180 / Math.PI).toFixed(2), predicted_miss: +aim.miss.toFixed(2) },
      projectiles,
      ...(Object.keys(used).length ? { used } : {}),
      ...(healthBefore !== null ? { target_health_before: healthBefore, target_health_after: healthAfter } : {})
    }
  },
  async craft(s, { item, count = 1 }) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    const it = s.mcData.itemsByName[item]
    if (!it) fail('bad_args', `unknown item ${item}`)
    count = strictPositiveInt(count, 'count')
    const known = s.bot.recipesAll(it.id, null, true)
    if (!known.length) fail('no_recipe', `${item} has no crafting recipe`)
    const entries = [...s.bot.recipeBook.entries()].filter(([, r]) =>
      ['crafting_shaped', 'crafting_shapeless'].includes(r.display?.type) &&
      r.display?.data?.result?.data?.itemId === it.id
    )
    const needsTable = !s.bot.recipesAll(it.id, null, null).length
    let table = null
    if (needsTable) {
      table = nearestBlockOf(s, ['crafting_table'], 32)
      if (!table) fail('need_crafting_table', `${item} needs a crafting table within 32 blocks`)
      await goNear(s, table.position, 3)
    }
    if (!entries.length) return await craftManually(s, it, count, table, known)
    const before = invCounts(s.bot)[item] || 0
    let made = 0
    let lastErr = null
    let full = false
    for (let round = 0; made < count && round < 64 && !full && !s.interruptedBy && s.alive; round++) {
      let gotOne = false
      for (const [displayId, r] of entries) {
        if (s.interruptedBy || !s.alive) break
        const win = table ? await openTable(s, table) : null
        const windowId = win ? win.id : 0
        const resultSlots = () => (win || s.bot.inventory).slots[0]
        try {
          s.bot._client.write('craft_recipe_request', { windowId, recipeId: displayId, makeAll: false })
          for (let i = 0; i < 10 && !resultSlots() && !s.interruptedBy; i++) await sleep(100)
          if (s.interruptedBy || !s.alive) break
          const res = resultSlots()
          if (res && res.type === it.id) {
            if (await takeCraftResult(s, win || s.bot.inventory, it.id)) gotOne = true
            else full = true
          } else lastErr = 'server placed no result'
        } finally {
          if (s.bot) {
            if (win && s.bot.currentWindow === win) s.bot.closeWindow(win)
            else if (!win) for (let sl = 1; sl <= 4; sl++) if (s.bot.inventory.slots[sl]) await s.bot.clickWindow(sl, 0, 1).catch(() => {})
          }
          await sleep(150)
        }
        if (gotOne || full) break
      }
      made = (invCounts(s.bot)[item] || 0) - before
      if (!gotOne) break
    }
    if (s.interruptedBy || !s.alive) return made > 0 ? { crafted: item, gained: made, used_table: !!table, inventory: invCounts(s.bot) } : {}
    if (full) failInventoryFull(s, item, made)
    if (made <= 0) {
      const r = known[0]
      const needs = {}
      for (const d of (r.delta || [])) if (d.count < 0) { const n = s.mcData.items[d.id].name; needs[n] = (needs[n] || 0) - d.count }
      fail('missing_ingredients', `could not craft ${item}: ${lastErr}`, { example_recipe_needs: needs, inventory: invCounts(s.bot) })
    }
    return { crafted: item, gained: made, used_table: !!table, inventory: invCounts(s.bot) }
  },
  // 打开界面看一眼就关（只读，不占动作锁以外的状态）
  async window_view(s, args) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    const w = await openTarget(s, windowTarget(args))
    try {
      return describeWindow(s, w)
    } finally {
      w.cleanup()
      if (s.bot && s.bot.currentWindow === w) s.bot.closeWindow(w)
      await sleep(300)
    }
  },
  // 打开界面 -> 按顺序执行 ops -> 关闭；某步失败就停，返回已完成的步骤和当前界面
  async window_act(s, args) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    const ops = args && args.ops
    if (!Array.isArray(ops) || !ops.length) fail('bad_args', 'ops must be a non-empty array')
    for (const [i, o] of ops.entries()) if (!o || !WINDOW_OPS[o.op]) fail('bad_args', `ops[${i}].op must be one of ${Object.keys(WINDOW_OPS).join(', ')}`)
    const w = await openTarget(s, windowTarget(args))
    const kind = windowKind(w)
    const done = []
    try {
      for (const [i, o] of ops.entries()) {
        if (s.interruptedBy) fail('interrupted', `stopped because of ${s.interruptedBy}`)
        if (s.bot.currentWindow !== w) fail('window_closed', 'the server closed the GUI')
        try {
          done.push({ op: o.op, ...(await WINDOW_OPS[o.op](s, w, kind, o)) })
        } catch (e) {
          if (!(e instanceof ApiError)) e = new ApiError('window_op_failed', e.message)
          e.extra = { ...(e.extra || {}), failed_op: i, done, window: s.bot && s.bot.currentWindow === w ? describeWindow(s, w) : null }
          throw e
        }
      }
      return { done, window: describeWindow(s, w) }
    } finally {
      w.cleanup()
      if (s.bot && s.bot.currentWindow === w) s.bot.closeWindow(w)
      await sleep(500)
    }
  },
  async equip(s, { item, slot = 'hand' }) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    await s.bot.equip(findItem(s, item), slot)
    return { held: itemSummary(s.bot.heldItem) }
  },
  // 空放使用一件物品：吃/喝、投掷、举盾、抛竿钓鱼、望远镜、放下船/矿车。
  // 吸收原来的 /consume：吃和喝只是"用物品"的一个分支。
  async use_item(s, { item, target, ms = 1000, timeout = 30000, source }) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    if (!item || typeof item !== 'string') fail('bad_args', 'item required')
    const it = findItem(s, item)
    const dest = source === 'off-hand' ? 'off-hand' : 'hand'
    const held = () => (dest === 'off-hand' ? s.bot.inventory.slots[45] : s.bot.heldItem)

    // 需要瞄准的东西（望远镜、喷溅药水、末影之眼）先转头；放船/矿车时这个点同时是摆放位置
    let point = null
    if (target !== undefined) {
      if (target && target.entity_id !== undefined) {
        const t = s.bot.entities[target.entity_id]
        if (!t) fail('no_such_entity', `entity ${target.entity_id} not visible`)
        point = t.position.offset(0, (t.height || 1.8) * 0.6, 0)
      } else if (target && [target.x, target.y, target.z].every(Number.isFinite)) {
        point = new Vec3(target.x, target.y, target.z)
      } else if (target && Array.isArray(target.pos) && target.pos.length === 3) {
        const [tx, ty, tz] = target.pos.map(Number)
        point = new Vec3(tx, ty, tz)
      } else fail('bad_args', 'target must be {entity_id} or {x,y,z} or {pos}')
      await s.bot.lookAt(point, true)
    }

    if (isVehicleItem(item)) return await placeEntityFromItem(s, item, it, point)

    // 盾牌：必须副手，举起来保持 ms
    if (item === 'shield') {
      if (!s.bot.inventory.slots[45] || s.bot.inventory.slots[45].name !== 'shield') await s.bot.equip(it, 'off-hand')
      const hold = Math.max(0, Math.min(Number(ms) || 1000, 10000))
      const t0 = Date.now()
      s.usingItem = { name: 'shield', t: t0 }
      try {
        s.bot.activateItem(true)
        await sleepInterruptible(s, hold)
      } finally {
        if (s.bot && s.bot._client?.state === 'play') { try { s.bot.deactivateItem() } catch {} }
        s.usingItem = null
      }
      return { used: { name: 'shield', count: 0 }, blocked_ms: Math.min(hold, Date.now() - t0) }
    }

    if (!held() || held().name !== item) await s.bot.equip(it, dest)

    // 投掷类
    if (THROWABLE.has(item)) {
      const before = s.bot.entity.position.clone()
      const countBefore = (held() && held().count) || 0
      const knownEntities = new Set(Object.keys(s.bot.entities))
      s.usingItem = { name: item, t: Date.now() }
      try {
        s.bot.activateItem(dest === 'off-hand')
        await sleepInterruptible(s, 200)
      } finally {
        if (s.bot && s.bot._client?.state === 'play') { try { s.bot.deactivateItem() } catch {} }
        s.usingItem = null
      }
      if (!await sleepInterruptible(s, item === 'ender_pearl' ? 1500 : 400)) return { used: { name: item, count: 1 }, thrown: true }
      const left = held() && held().name === item ? held().count : 0
      const out = { used: { name: item, count: Math.max(1, countBefore - left) }, thrown: true }
      if (item === 'ender_pearl') {
        out.teleported = s.bot.entity.position.distanceTo(before) > 1
        out.pos = fmt(s.bot.entity.position)
      }
      if (item === 'ender_eye') {
        // 末影之眼会被服务端当成实体下发，等它出现再读飞行方向
        let eye = null
        for (let i = 0; i < 20 && !eye && !s.interruptedBy && s.alive; i++) {
          eye = Object.values(s.bot.entities)
            .filter(x => !knownEntities.has(String(x.id)) && x !== s.bot.entity)
            .sort((a, b) => a.position.distanceTo(s.bot.entity.position) - b.position.distanceTo(s.bot.entity.position))[0]
          if (!eye) await sleep(100)
        }
        if (eye) {
          const dx = eye.position.x - s.bot.entity.position.x
          const dz = eye.position.z - s.bot.entity.position.z
          out.projectile = eye.name
          out.landed_at = fmt(eye.position)
          out.eye_vector = [+dx.toFixed(1), +dz.toFixed(1)]
          // MC yaw：0 = 正南(+Z)，90 = 正西(-X)
          out.bearing_deg = Math.round(((Math.atan2(-dx, dz) * 180 / Math.PI) + 360) % 360)
        }
      }
      return out
    }

    // 钓鱼：抛竿 → 看浮标下沉 → 收竿。不用 bot.fish()：它靠 fishing 粒子包判断咬钩，
    // 粒子类型 id 在 1.21.11 上对不上，会一直等到超时。
    // 咬钩判定的两个坑（真机日志里 4 次"收竿却什么都没钓到"全是误判）：
    //  ① mineflayer 不插值实体位置，两个位置包之间浮标坐标不变，飞行途中就会被当成"稳定"；
    //  ② 8 秒内没稳定时旧代码拿抛竿瞬间（手的高度）当基准，浮标一落水就被判成咬钩。
    // 所以只在浮标确实入水后才开始判定（基准取最近 1 s 的最高点）；误判或没落进水就自动重抛。
    if (item === 'fishing_rod') {
      const invBefore = invCounts(s.bot)
      const t0 = Date.now()
      const maxWait = Math.max(5000, Math.min(Number(timeout) || 30000, 60000))
      const offhand = dest === 'off-hand'
      const wet = p => [0, -0.3].some(dy => {
        const b = s.bot.blockAt(p.offset(0, dy, 0))
        return !!b && (b.name === 'water' || b.name === 'bubble_column' || (b.getProperties && b.getProperties().waterlogged === true))
      })
      const caughtNow = () => {
        const after = invCounts(s.bot), out = {}
        for (const [k, v] of Object.entries(after)) if (v > (invBefore[k] || 0)) out[k] = v - (invBefore[k] || 0)
        return out
      }
      const reel = async () => {
        if (!s.bot) return
        s.bot.activateItem(offhand)   // 收竿
        if (!await sleepInterruptible(s, 1500)) {
          if (s.bot && s.bot._client?.state === 'play') { try { s.bot.deactivateItem() } catch {} }
          return
        }
        try { s.bot.deactivateItem() } catch {}
        await sleepInterruptible(s, 1200)
      }
      s.usingItem = { name: 'fishing_rod', t: t0 }
      let casts = 0, falseBites = 0, lastInfo = {}
      try {
        while (Date.now() - t0 < maxWait - 3000 && !s.interruptedBy && s.alive) {
          requireConnected(s)
          casts++
          const beforeIds = new Set(Object.values(s.bot.entities).map(e => e.id))
          s.bot.activateItem(offhand)
          let bobber = null
          for (let i = 0; i < 40 && !bobber && !s.interruptedBy && s.alive; i++) {
            await sleep(100)
            if (!s.bot) break
            bobber = Object.values(s.bot.entities).find(e => !beforeIds.has(e.id) && /bobber/.test(e.name || ''))
          }
          if (s.interruptedBy || !s.alive) {
            if (bobber && s.bot) { try { s.bot.activateItem(offhand) } catch {} }
            break
          }
          if (!bobber) {
            try { s.bot.deactivateItem() } catch {}
            if (casts === 1) fail('cannot_use', 'no fishing bobber appeared; aim at a water block with target')
            break
          }
          // 浮标在小水池里会一直上下晃，等它"完全静止"可能永远等不到，而每次重抛都会重置原版的
          // 5–30 s 咬钩计时。所以只要求"连续 0.5 s 在水里"，之后拿最近 1 s 的最高点做基准：
          // 晃动幅度远小于 0.25，咬钩的下拽远大于它。
          const castAt = Date.now()
          let wetRun = 0, bite = false, refY = null
          const recent = []
          while (Date.now() - t0 < maxWait && !s.interruptedBy && s.alive) {
            await sleep(100)
            if (!s.bot || !s.bot.entities[bobber.id]) break
            const y = bobber.position.y
            if (wetRun < 5) {
              wetRun = wet(bobber.position) ? wetRun + 1 : 0
              if (wetRun < 5 && Date.now() - castAt > 6000) break   // 没落进水（打在岸上 / 挂在方块上）
              continue
            }
            if (recent.length >= 3) {
              refY = Math.max(...recent)
              if (y < refY - 0.25) { bite = true; break }
            }
            recent.push(y)
            if (recent.length > 10) recent.shift()
          }
          lastInfo = { bobber_y: +bobber.position.y.toFixed(2), base_y: refY === null ? null : +refY.toFixed(2), in_water: s.bot ? wet(bobber.position) : false }
          await reel()
          if (s.interruptedBy || !s.alive) break
          const caught = caughtNow()
          if (Object.keys(caught).length) {
            return { used: { name: 'fishing_rod', count: 0 }, caught, wait_ms: Date.now() - t0, casts, false_bites: falseBites }
          }
          if (bite) falseBites++
        }
      } finally {
        if (s.bot && s.bot._client?.state === 'play') { try { s.bot.deactivateItem() } catch {} }
        s.usingItem = null
      }
      if (s.interruptedBy || !s.alive) return {}
      fail('timeout', `nothing caught within ${maxWait}ms`, { casts, false_bites: falseBites, waited_ms: Date.now() - t0, ...lastInfo })
    }

    // 望远镜：保持 ms，配合 target 看向目标
    if (item === 'spyglass') {
      const hold = Math.max(100, Math.min(Number(ms) || 800, 5000))
      const t0 = Date.now()
      s.usingItem = { name: 'spyglass', t: t0 }
      try {
        s.bot.activateItem(dest === 'off-hand')
        await sleepInterruptible(s, hold)
      } finally {
        if (s.bot && s.bot._client?.state === 'play') { try { s.bot.deactivateItem() } catch {} }
        s.usingItem = null
      }
      return { used: { name: 'spyglass', count: 0 }, observed_ms: Math.min(hold, Date.now() - t0), ...(target && target.entity_id !== undefined ? { target: target.entity_id } : {}) }
    }

    if (item === 'goat_horn') {
      s.usingItem = { name: 'goat_horn', t: Date.now() }
      try {
        s.bot.activateItem(dest === 'off-hand')
        await sleepInterruptible(s, 1200)
      } finally {
        if (s.bot && s.bot._client?.state === 'play') { try { s.bot.deactivateItem() } catch {} }
        s.usingItem = null
      }
      return { used: { name: 'goat_horn', count: 0 } }
    }

    // 吃 / 喝（食物、药水、牛奶桶、蜂蜜瓶）
    const food = s.mcData.foodsByName && s.mcData.foodsByName[item]
    const drinkable = !!food || ['potion', 'milk_bucket', 'honey_bottle', 'ominous_bottle'].includes(item)
    if (drinkable) {
      if (food && s.bot.food >= 20 && !['golden_apple', 'enchanted_golden_apple', 'chorus_fruit'].includes(item)) {
        fail('not_hungry', 'food is full; this item can only be eaten when hungry', { food: s.bot.food })
      }
      const before = held() ? { name: held().name, count: held().count } : null
      const healthBefore = s.bot.health
      const foodBefore = s.bot.food
      const t0 = Date.now()
      const eatLimit = Math.min(Number(timeout) || 8000, 8000)
      let done = false
      s.usingItem = { name: item, t: t0 }
      try {
        s.bot.activateItem(dest === 'off-hand')
        while (Date.now() - t0 < eatLimit && !s.interruptedBy && s.alive) {
          requireConnected(s)
          await sleep(100)
          if (s.interruptedBy || !s.alive || !s.bot) break
          const cur = held()
          if (!before) { done = true; break }
          if (!cur || cur.name !== before.name || cur.count < before.count) { done = true; break }
        }
      } finally {
        if (s.bot && s.bot._client?.state === 'play') { try { s.bot.deactivateItem() } catch {} }
        s.usingItem = null
      }
      if (!done && (s.interruptedBy || !s.alive)) return {}
      if (!done) {
        fail('timeout', `could not finish using ${item}`, {
          held_before: before,
          held_now: held() ? { name: held().name, count: held().count } : null,
          using_held: !!s.bot.usingHeldItem,
          food: s.bot.food,
          effects: effectList(s)
        })
      }
      await sleepInterruptible(s, 300)
      return {
        used: { name: item, count: 1 },
        food_before: foodBefore, food: s.bot.food,
        health_before: healthBefore, health: s.bot.health,
        effects: effectList(s)
      }
    }

    // 打火石、水桶这类必须对着方块用的东西，引导到 /interact
    if (/bucket$|flint_and_steel$|_seeds$|bone_meal$|_hoe$|^glass_bottle$|^lily_pad$|^frogspawn$/.test(item)) {
      fail('need_block_target', `${item} must be used on a block; call /interact with x,y,z and this item`)
    }
    fail('cannot_use', `${item} has no known air-use behaviour`)
  },

  // 持久姿态：潜行 + 举盾 + 持续跳跃（水里 = 自动踩水浮面）。全量设置（没写的字段就是 false），不占动作锁。
  async posture(s, { sneak, shield, jump }) {
    if (!s.bot || !s.bot.entity) fail('not_connected', 'bot not connected')
    if (sneak !== undefined && typeof sneak !== 'boolean') fail('bad_args', 'sneak must be a boolean')
    if (shield !== undefined && typeof shield !== 'boolean') fail('bad_args', 'shield must be a boolean')
    if (jump !== undefined && typeof jump !== 'boolean') fail('bad_args', 'jump must be a boolean')
    const wantSneak = sneak === true
    const wantShield = shield === true
    const wantJump = jump === true

    if (wantShield && !(s.bot.inventory.slots[45] && s.bot.inventory.slots[45].name === 'shield')) {
      const it = s.bot.inventory.items().find(i => i.name === 'shield')
      if (!it) fail('missing_item', 'no shield in inventory', { inventory: invCounts(s.bot) })
      await s.bot.equip(it, 'off-hand')
    }
    s.requireBackendAction()
    if (wantShield !== s.posture.shield) {
      if (wantShield) s.bot.activateItem(true)
      else try { s.bot.deactivateItem() } catch {}
      s.posture.shield = wantShield
    }
    if (wantSneak !== s.posture.sneak) {
      s.bot.setControlState('sneak', wantSneak)
      s.posture.sneak = wantSneak
    }
    if (wantJump !== s.posture.jump) {
      s.bot.setControlState('jump', wantJump)
      s.posture.jump = wantJump
    }
    // 潜行 / 跳跃随下一个物理 tick（50 ms）发出，举盾的 use_item 是立即发的；以前固定等 150 ms，战斗里每次切姿态白白多 100 ms
    await sleep(55)
    s.requireBackendAction()
    return {
      sneaking: !!s.bot.getControlState('sneak'),
      jumping: !!s.bot.getControlState('jump'),
      blocking: !!(s.posture.shield && s.bot.inventory.slots[45] && s.bot.inventory.slots[45].name === 'shield'),
      offhand: itemSummary(s.bot.inventory.slots[45])
    }
  },

  // 下船 / 下马 / 下矿车
  async dismount(s) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    if (!s.bot.vehicle) fail('not_in_vehicle', 'bot is not riding anything')
    const vehicle = s.bot.vehicle
    // 1.21.9+ 的协议里已经没有 player_command 这个包了（旧版 stop_riding 走它）。
    // 写一个不存在的包名时 protodef 不会报错，而是静默产出"只有 id 0x00、没有 body"
    // 的帧，服务端会把它当成 accept_teleportation 去解码并失败掉线：
    //   Failed to decode packet 'serverbound/minecraft:accept_teleportation'
    // 现在下车只走 player_input：jump 探一次，再按一下 Shift。
    try {
      for (let i = 0; i < 2 && s.bot.vehicle; i++) {
        s.bot.dismount()
        await sleep(300)
      }
    } catch (e) {
      s.log('dismount failed', e.message)
    }
    if (s.bot.vehicle) {
      // 1.21 的按键状态走 player_input（不是 player_command），下船就是按住 Shift。
      // 直接发包而不走 setControlState，避免"当前状态已经是 sneak 就直接 return 不发包"。
      try {
        for (let i = 0; i < 8 && s.bot.vehicle; i++) {
          s.bot._client.write('player_input', { inputs: { shift: true } })
          await sleep(100)
        }
        s.bot._client.write('player_input', { inputs: {} })
      } catch (e) {
        s.log('player_input sneak failed', e.message)
      }
      await sleep(250)
    }
    if (s.bot.vehicle) {
      s.bot.setControlState('sneak', true)
      await sleep(300)
      s.bot.setControlState('sneak', !!s.posture.sneak)
    }
    for (let i = 0; i < 25 && s.bot.vehicle; i++) await sleep(200)
    if (s.bot.vehicle) {
      // 载具实体被撞坏/移除时，服务端不会再发下车包，mineflayer 的 bot.vehicle 会一直是旧的
      const v = s.bot.entities[vehicle.id]
      if (!v || v.position.distanceTo(s.bot.entity.position) > 4) {
        s.log('DISMISS stale vehicle', vehicle.name)
        s.bot.vehicle = null
        s.bot.emit('dismount', vehicle)
        if (s.bot._client && s.bot._client.state === 'play') {
          s.bot._client.emit('position', { teleportId: -1, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: { x: true, y: true, z: true, yaw: true, pitch: true, dx: false, dy: false, dz: false } })
        }
      }
    }
    if (s.bot.vehicle) fail('dismount_failed', `still riding ${vehicle.name}`)
    return { dismounted: true, vehicle: { id: vehicle.id, name: vehicle.name }, pos: fmt(s.bot.entity.position) }
  },
  async drop(s, { item, count }) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    const it = findItem(s, item)
    await s.bot.toss(it.type, null, count ?? invCounts(s.bot)[item])
    return { inventory: invCounts(s.bot) }
  },
  async chat(s, { message }) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    if (typeof message !== 'string' || !message.length) fail('bad_args', 'message required')
    // 文档承诺：禁止命令、最长 100 字符、1 条/秒。之前只截断到 256 且不限速，
    // 于是 /tp、/give 之类的命令能直接捅到服务端（agent 可以借此绕过 API 的能力边界）。
    if (message.trimStart().startsWith('/')) fail('bad_args', "chat messages must not start with '/' (commands are not allowed)")
    if (message.length > 100) fail('bad_args', `message must be at most 100 characters (got ${message.length})`)
    const now = Date.now()
    if (s.lastChatAt && now - s.lastChatAt < 1000) {
      fail('rate_limited', `chat is limited to 1 message per second (retry in ${1000 - (now - s.lastChatAt)}ms)`)
    }
    s.lastChatAt = now
    s.bot.chat(message)
    return { sent: true }
  },
  // 不经过 pathfinder 的原生键位控制：受控时长内按住指定方向/跳跃，可选在此期间按左键（hit）。
  // 用于脱离船体碰撞箱、水中上浮、助跑跳沟、原地跳配合 place 垫高、跳劈暴击、朝固定方向挥砍
  // 这类 A* / attack 处理不了的中间态。
  async control(s, { forward, back, left, right, jump, sneak, sprint, yaw, pitch, ms, hit, hit_interval_ms, wait }) {
    if (!s.bot || !s.bot.entity) fail('not_connected', 'bot not connected')
    if (wait !== undefined && typeof wait !== 'boolean') fail('bad_args', 'wait must be a boolean')
    const keys = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']
    const want = {}
    for (const k of keys) {
      const v = { forward, back, left, right, jump, sneak, sprint }[k]
      if (v !== undefined && typeof v !== 'boolean') fail('bad_args', `${k} must be a boolean`)
      want[k] = v === true
    }
    let hits = 0
    if (hit !== undefined && hit !== false) {
      hits = hit === true ? 1 : Number(hit)
      if (!Number.isInteger(hits) || hits < 1 || hits > 20) fail('bad_args', 'hit must be true or an integer between 1 and 20')
    }
    if (!keys.some(k => want[k]) && !hits) {
      // wait:false 且什么键都不按：立刻松开之前留下的按键
      if (wait === false && yaw === undefined && pitch === undefined) {
        const had = s.heldControl ? s.heldControl.keys : []
        s.releaseHeld()
        return { held: [], released: had, pos: fmt(s.bot.entity.position), on_ground: !!s.bot.entity.onGround }
      }
      if (wait !== false) fail('bad_args', 'set at least one of forward/back/left/right/jump/sneak/sprint or hit')
    }
    let interval = 0
    if (hits) {
      interval = hit_interval_ms === undefined ? attackIntervalMs(s.bot.heldItem) : Number(hit_interval_ms)
      if (!Number.isFinite(interval) || interval < 50 || interval > 5000) fail('bad_args', 'hit_interval_ms must be between 50 and 5000')
    } else if (hit_interval_ms !== undefined) fail('bad_args', 'hit_interval_ms needs hit')
    // 只给 hit 不给 ms：时长刚好够挥完 hits 下
    const needMs = hits ? (hits - 1) * interval + 50 : 0
    ms = ms === undefined ? Math.max(hits ? needMs : 300, 50) : Number(ms)
    if (!Number.isFinite(ms) || ms < 50 || ms > 3000) fail('bad_args', 'ms must be between 50 and 3000')
    if (hits && ms < needMs) fail('bad_args', `${hits} hits at ${interval}ms need ms >= ${needMs}`, { required_ms: needMs })
    if (yaw !== undefined || pitch !== undefined) {
      const ny = Number(yaw ?? s.bot.entity.yaw)
      const np = Number(pitch ?? s.bot.entity.pitch)
      if (!Number.isFinite(ny) || !Number.isFinite(np)) fail('bad_args', 'yaw/pitch must be finite numbers (radians)')
      await s.bot.look(ny, np, true)
    }
    s.releaseHeld()
    if (wait === false) {
      // 不等：按下就返回，ms 后自动松开；下一个 control 会立刻接管（实时操控用）
      const held = keys.filter(k => want[k])
      const h = { keys: held, until: Date.now() + ms, timer: null, hitTimers: [] }
      s.heldControl = h
      for (const k of held) s.bot.setControlState(k, true)
      const swings = hits ? [{ t_ms: 0, ...leftClick(s) }] : []
      for (let i = 1; i < hits; i++) {
        h.hitTimers.push(setTimeout(() => { if (s.heldControl === h && s.bot) { try { leftClick(s) } catch {} } }, i * interval))
      }
      h.timer = setTimeout(() => { if (s.heldControl === h) s.releaseHeld() }, ms)
      return {
        held, release_in_ms: ms,
        pos: fmt(s.bot.entity.position),
        on_ground: !!s.bot.entity.onGround,
        in_water: !!s.bot.entity.isInWater,
        yaw: +s.bot.entity.yaw.toFixed(2),
        pitch: +s.bot.entity.pitch.toFixed(2),
        ...(hits ? { hits: swings, scheduled_hits: hits - 1, hit_interval_ms: interval, held_item: s.bot.heldItem ? s.bot.heldItem.name : null } : {})
      }
    }
    const before = s.bot.entity.position.clone()
    const t0 = Date.now()
    const swings = []
    let nextHitAt = t0
    for (const k of keys) if (want[k]) s.bot.setControlState(k, true)
    try {
      while (Date.now() - t0 < ms && !s.interruptedBy) {
        if (swings.length < hits && Date.now() >= nextHitAt) {
          swings.push({ t_ms: Date.now() - t0, ...leftClick(s) })
          nextHitAt += interval
        }
        await sleep(Math.max(5, Math.min(50, (swings.length < hits ? nextHitAt : t0 + ms) - Date.now())))
      }
    } finally {
      for (const k of keys) { try { s.bot.setControlState(k, false) } catch {} }
      s.applyPosture()
    }
    const after = s.bot.entity.position
    return {
      ms: Date.now() - t0,
      pos: fmt(after),
      moved: +before.distanceTo(after).toFixed(2),
      on_ground: !!s.bot.entity.onGround,
      in_water: !!s.bot.entity.isInWater,
      yaw: +s.bot.entity.yaw.toFixed(2),
      pitch: +s.bot.entity.pitch.toFixed(2),
      ...(hits ? { hits: swings, hit_interval_ms: interval, held: s.bot.heldItem ? s.bot.heldItem.name : null } : {}),
      ...(s.interruptedBy ? { interrupted_by: s.interruptedBy } : {})
    }
  },

  // 主动转向：给 yaw/pitch（弧度，mineflayer 约定 0 朝 -Z），或给坐标/实体自动算。
  async look(s, { yaw, pitch, x, y, z, entity_id }) {
    if (!s.bot || !s.bot.entity) fail('not_connected', 'bot not connected')
    const eye = s.bot.entity.position.offset(0, s.bot.entity.eyeHeight || 1.62, 0)
    let ty = yaw
    let tp = pitch
    if (entity_id !== undefined) {
      const e = s.bot.entities[entity_id]
      if (!e) fail('no_such_entity', `entity ${entity_id} not visible`)
      const d = e.position.offset(0, (e.height || 1.8) * 0.8, 0).minus(eye)
      ty = Math.atan2(-d.x, -d.z)
      tp = Math.atan2(d.y, Math.hypot(d.x, d.z))
    } else if (x !== undefined || y !== undefined || z !== undefined) {
      if (![x, y, z].every(v => v !== undefined && Number.isFinite(Number(v)))) fail('bad_args', 'x, y, z must be finite numbers')
      const d = new Vec3(Number(x), Number(y), Number(z)).minus(eye)
      ty = Math.atan2(-d.x, -d.z)
      tp = Math.atan2(d.y, Math.hypot(d.x, d.z))
    }
    if (ty === undefined && tp === undefined) fail('bad_args', 'provide yaw/pitch, x/y/z or entity_id')
    const ny = Number(ty ?? s.bot.entity.yaw)
    const np = Number(tp ?? s.bot.entity.pitch)
    if (!Number.isFinite(ny) || !Number.isFinite(np)) fail('bad_args', 'yaw/pitch must be finite numbers')
    await s.bot.look(ny, np, true)
    s.requireBackendAction()
    return { yaw: +s.bot.entity.yaw.toFixed(3), pitch: +s.bot.entity.pitch.toFixed(3) }
  },

  // 打断正在执行的动作，并等它真正退出、动作锁释放后再返回（最多 5 s），
  // 这样紧接着发的下一个动作不会撞 busy。被停掉的动作返回 interrupted（cause: "stop"），
  // 有部分结果的动作照常 ok:true 并带 interrupted_by: "stop"。
  async stop(s) {
    if (!s.bot) return { stopped: false }
    const running = s.busy
    s.releaseHeld()
    if (running) s.interruptedBy = 'stop'
    s.bot.pathfinder.setGoal(null)
    try { s.bot.stopDigging() } catch {}
    s.bot.clearControlStates()
    try { s.bot.deactivateItem() } catch {}
    s.applyPosture()
    if (!running) return { stopped: true, action: null }
    const t0 = Date.now()
    while (s.busy === running && Date.now() - t0 < 5000) await sleep(20)
    return { stopped: true, action: running.name, released: s.busy !== running, wait_ms: Date.now() - t0 }
  },
  // Connection management
  async connect(s) {
    if (s.bot) {
      if (!s.isReady()) {
        // 连着但还没就绪（典型：代理把人留在了大厅）——让适配器有机会补救
        const extra = s.readiness.onConnectWhileNotReady ? s.readiness.onConnectWhileNotReady() : {}
        return { ok: true, already_connected: true, ready: false, ...(extra || {}) }
      }
      return { ok: true, already_connected: true, ready: true }
    }
    s.connect()
    return { ok: true, reconnect: true }
  },
  async disconnect(s) {
    s.reconnectPending = false
    if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null }
    if (s.bot) s.bot.quit()
    return { ok: true }
  }
}

// minecraft-data 1.21.11 tags 108 pickaxe blocks (obsidian, ancient_debris, ores, etc.)
// with material='incorrect_for_wooden_tool', whose tool-speed map lacks stone/iron/diamond/netherite
// pickaxes. Mineflayer therefore computes hand-speed digTime (e.g. 75s for obsidian -> 30s timeout,
// 45s for ancient_debris -> 30s timeout, 6.75s for deepslate ores). Restore 'mineable/pickaxe'.
function patchBrokenPickaxeMaterials(reg) {
  if (!reg || !reg.materials || !reg.materials['mineable/pickaxe']) return 0
  let patched = 0
  const seen = new Set()
  for (const list of [reg.blocksByName, reg.blocks, reg.blocksArray]) {
    if (!list) continue
    const vals = Array.isArray(list) ? list : Object.values(list)
    for (const b of vals) {
      if (!b || seen.has(b)) continue
      seen.add(b)
      if (typeof b.material === 'string' && b.material.startsWith('incorrect_for_')) {
        b.material = 'mineable/pickaxe'
        patched++
      }
    }
  }
  return patched
}

// 判断 bot 脚下碰撞箱覆盖的局部区块是否已加载（最多 1~4 个区块），用于在 5x5 区块到齐前提前恢复重力。
function hasLocalPhysicsChunks(bot) {
  if (!bot || bot._client?.state !== 'play' || !bot.entity?.position || !bot.world) return false
  const pos = bot.entity.position
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return false
  if (typeof bot.world.getColumn === 'function') {
    const r = (bot.physics && Number.isFinite(bot.physics.playerHalfWidth) ? bot.physics.playerHalfWidth : 0.3) + 0.05
    const minCx = Math.floor(pos.x - r) >> 4
    const maxCx = Math.floor(pos.x + r) >> 4
    const minCz = Math.floor(pos.z - r) >> 4
    const maxCz = Math.floor(pos.z + r) >> 4
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        if (!bot.world.getColumn(cx, cz)) return false
      }
    }
  }
  return typeof bot.blockAt === 'function' ? bot.blockAt(pos, false) != null : true
}

// window_view 会走路并打开界面，要占动作锁，所以不放进只读集合
const READONLY = new Set(['status', 'inventory', 'find_blocks', 'get_entities', 'events', 'advancements', 'get_block', 'stop', 'connect', 'disconnect', 'posture', 'look'])

module.exports = { configure, Session, sessions, api, READONLY, ApiError, fail, fmt, log, sleep, patchBrokenPickaxeMaterials, scanExposed, createSafeGoto, createMovements, selectBestHarvestTool, weaponScore, hasLocalPhysicsChunks }
