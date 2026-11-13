'use strict'
// 核心引擎：每个登录对应一个独立的 mineflayer bot（Session），以及全部观察 / 动作接口（api）。
// 与具体服务器耦合的部分都在适配器里：认证见 src/auth/，就绪判定见 src/readiness/。
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

const sleep = ms => new Promise(r => setTimeout(r, ms))
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

class Session {
  constructor(token, username, profile, botOptions) {
    this.token = token
    this.username = username
    this.profile = profile
    // 认证适配器给出的 mineflayer.createBot 参数（username / auth / session / sessionServer ...）
    this.botOptions = botOptions
    this.createdAt = Date.now()
    this.bot = null
    this.mcData = null
    this.busy = null
    this.alive = true
    this.lastDeath = null
    this.deathLoopCooldownUntil = 0
    this.activeStopOn = null
    this.interruptedBy = null
    this.events = []
    this.seq = 0
    this.recentDeaths = []
    this.advancementDefinitions = new Map()
    this.advancementProgress = new Map()
    this.advancementsReady = false
    this.advancementPackets = 0
    this.advancementsUpdatedAt = null
    // 持久姿态（不占动作锁）：潜行 + 举盾。全量设置语义，见 api.posture
    this.posture = { sneak: false, shield: false, jump: false }
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
    this.events.push({ seq: ++this.seq, t: Date.now(), type, ...data })
    if (this.events.length > 500) this.events.shift()
  }

  interrupt(cause) {
    if (!this.busy || !this.activeStopOn || !this.activeStopOn.includes(cause)) return
    if (this.interruptedBy && cause !== 'death') return
    this.interruptedBy = cause
    if (!this.bot) return
    this.bot.pathfinder.setGoal(null)
    try { this.bot.stopDigging() } catch {}
    this.bot.clearControlStates()
    this.applyPosture()
  }

  nearestHostile(radius) {
    if (!this.bot) return null
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
    try { b.setControlState('sneak', !!this.posture.sneak) } catch {}
    try { b.setControlState('jump', !!this.posture.jump) } catch {}
    if (this.posture.shield) { try { b.activateItem(true) } catch {} }
  }

  clearPosture() {
    this.posture.sneak = false
    this.posture.shield = false
    this.posture.jump = false
    if (!this.bot) return
    try { this.bot.setControlState('sneak', false) } catch {}
    try { this.bot.setControlState('jump', false) } catch {}
  }

  connect() {
    const s = this
    s.advancementDefinitions.clear()
    s.advancementProgress.clear()
    s.advancementsReady = false
    s.advancementPackets = 0
    s.advancementsUpdatedAt = null
    s.worldReady = false
    s.worldGen = 0
    s.lastEntitySpawnAt = 0
    s.bot = mineflayer.createBot({
      host: config.minecraft.host, port: config.minecraft.port, version: config.minecraft.version,
      profilesFolder: false, checkTimeoutInterval: 30000,
      ...s.botOptions
    })
    s.bot.loadPlugin(pathfinder)
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
    let playOutPackets = new Set()
    try {
      const proto = require('minecraft-data')(s.bot.version || config.minecraft.version).protocol
      const cont = proto.play.toServer.types.packet
      const mapperField = cont[1].find(f => f.type && Array.isArray(f.type) && f.type[0] === 'mapper') || cont[1][0]
      playOutPackets = new Set(Object.values(mapperField.type[1].mappings))
    } catch (e) {
      s.log('packet table unavailable, outbound name guard disabled:', e.message)
    }
    const clientWrite = s.bot._client.write.bind(s.bot._client)
    s.bot._client.write = (name, params) => {
      const client = s.bot._client
      if (client.state === 'play' && !playOutPackets.has(name)) {
        s.log('SKIP unknown outbound packet ' + name + ' (not in ' + (s.bot && s.bot.version) + ' play.toServer)')
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
    s.bot._client.on('recipe_book_add', p => { for (const e of p.entries) s.bot.recipeBook.set(e.recipe.displayId, e.recipe) })
    // Mineflayer itself does not expose advancements, but minecraft-protocol fully parses this packet.
    // The packet is a full reset on login/server switch, followed by incremental definition/progress updates.
    s.bot._client.on('advancements', p => {
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
    s.bot.on('spawn', () => setTimeout(() => {
      if (!s.bot) return
      if (s.bot.vehicle) { const v = s.bot.vehicle; s.bot.vehicle = null; s.bot.emit('dismount', v); s.log('WATCHDOG cleared phantom vehicle', v.name) }
      const p = s.bot.entity.position
      s.bot._client.emit('position', { teleportId: -1, x: p.x, y: p.y, z: p.z, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: { x: false, y: false, z: false, yaw: true, pitch: true, dx: false, dy: false, dz: false } })
    }, 4000))
    s.bot.once('spawn', () => {
      s.bot.physics.playerHalfWidth = 0.3001
      s.mcData = require('minecraft-data')(s.bot.version)
      const m = new Movements(s.bot)
      m.canDig = false
      m.allow1by1towers = false
      m.allowSprinting = true
      m.scafoldingBlocks = []
      m.allowParkour = true
      s.bot.pathfinder.setMovements(m)
      s.bot.pathfinder.thinkTimeout = 15000
      s.bot.pathfinder.tickTimeout = 40
      s.log('SPAWN', fmt(s.bot.entity.position))
    })
    // 刚进服时区块还没下发，物理会把 bot 判成悬空而一路下坠（服务端也认），
    // 掉进虚空或摔死。等区块到齐再开启物理。
    s.bot.once('spawn', async () => {
      s.bot.physicsEnabled = false
      try {
        await withTimeout(s.bot.waitForChunksToLoad(), 8000, 'chunk load')
      } catch (e) {
        s.log('CHUNKS wait failed:', e.message)
      }
      if (!s.bot) return
      s.bot.physicsEnabled = true
      s.log('PHYSICS enabled after chunks')
    })
    // ready 还要等周围的区块和实体到齐：服务端先发区块、再陆续发实体，
    // 以前 ready 一变 true 就调 get_entities 常常拿到 []。每次（重新）进入一个后端世界都重新等：
    // 区块到齐（最多 8 s）后，再等到 600 ms 内没有新实体出现（最多再 3 s）。
    s.bot.on('entitySpawn', () => { s.lastEntitySpawnAt = Date.now() })
    s.bot.on('login', () => { s.worldReady = false; s.worldGen++ })
    s.bot.on('spawn', async () => {
      if (s.worldReady) return
      const bot = s.bot
      const gen = s.worldGen
      const t0 = Date.now()
      try { await withTimeout(bot.waitForChunksToLoad(), 8000, 'chunk load') } catch (e) {}
      const t1 = Date.now()
      await sleep(300)
      while (Date.now() - t1 < 3000 && Date.now() - s.lastEntitySpawnAt < 600) await sleep(100)
      if (s.bot !== bot || gen !== s.worldGen || s.worldReady) return
      s.worldReady = true
      s.log('WORLD ready after', Date.now() - t0, 'ms, entities', Object.keys(bot.entities).length - 1)
    })
    // 被别的实体挤开：原版里这是客户端自己算的（服务端只推生物，不推玩家），
    // prismarine-physics 没实现，bot 就成了推不动的柱子。照原版 Entity.push 每 tick 加一点水平速度。
    const NOT_PUSHABLE = new Set(['item', 'experience_orb', 'marker', 'area_effect_cloud',
      'item_frame', 'glow_item_frame', 'painting', 'leash_knot', 'end_crystal', 'evoker_fangs', 'lightning_bolt',
      'block_display', 'item_display', 'text_display', 'interaction', 'falling_block', 'tnt', 'fishing_bobber'])
    const LIVING_TYPES = new Set(['player', 'mob', 'hostile', 'passive', 'animal', 'ambient', 'water_creature', 'living'])
    const pushable = e => !NOT_PUSHABLE.has(e.name) && (LIVING_TYPES.has(e.type) || /boat|raft|minecart/.test(e.name || ''))
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
    s.bot.on('spawn', () => s.pushEvent('spawn', { pos: fmt(s.bot.entity.position) }))
    s.bot.on('messagestr', (m, pos) => {
      if (pos === 'game_info') return
      const text = m.replace(/\s+/g, ' ').trim()
      if (s.lastDeath && !s.lastDeath.cause && Date.now() - s.lastDeath.t < 3000 && text.startsWith(s.bot.username + ' ')) s.lastDeath.cause = text
      s.pushEvent('chat', { text: text.slice(0, 300) })
    })
    const DEATH_LOOP_WINDOW = 60000
    const DEATH_LOOP_THRESHOLD = 3
    const DEATH_LOOP_COOLDOWN = 5 * 60 * 1000
    s.bot.on('death', () => {
      s.lastDeath = { pos: fmt(s.bot.entity.position), t: Date.now(), dropped_items_at: fmt(s.bot.entity.position) }
      s.pushEvent('death', s.lastDeath); s.alive = false; s.interrupt('death')
      s.clearPosture()
      const now = Date.now()
      s.recentDeaths.push(now)
      while (s.recentDeaths.length && s.recentDeaths[0] < now - DEATH_LOOP_WINDOW) s.recentDeaths.shift()
      if (s.recentDeaths.length >= DEATH_LOOP_THRESHOLD) {
        s.log('DEATH_LOOP detected:', s.recentDeaths.length, 'deaths in', DEATH_LOOP_WINDOW / 1000, 's')
        s.deathLoopCooldownUntil = now + DEATH_LOOP_COOLDOWN
        s.pushEvent('death_loop', { deaths: s.recentDeaths.length, cooldown_until: s.deathLoopCooldownUntil })
        s.recentDeaths.length = 0
        s.bot.quit('death loop protection')
      }
    })
    s.bot.on('spawn', () => { s.alive = true })
    let lastHealth = 20
    // 服务端每次扣血前发 damage_event（1.19.4+），带 damage_type 注册表下标和来源实体（id+1，0 = 无）。
    // 记下来挂到 hurt 事件上，免得"被零星伤害打断"时无从查起。
    let lastDamage = null
    s.bot._client.on('damage_event', p => {
      if (!s.bot || !s.bot.entity || p.entityId !== s.bot.entity.id) return
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
      s.log('END', r)
      s.pushEvent('disconnected', { reason: r })
      s.bot = null
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

// pathfinder 卡在实体碰撞箱（例如船顶）或未加载区块时会一声不响地原地转圈，
// 以前 move_to 会一直占着动作锁直到客户端 HTTP 超时。这里按位移做看门狗。
async function gotoWatched(s, goal, timeout, stallMs = 8000) {
  const bot = s.bot
  let last = bot.entity.position.clone()
  let lastMoveAt = Date.now()
  const sampler = setInterval(() => {
    if (!bot.entity) return
    const p = bot.entity.position
    if (p.distanceTo(last) > 0.35) { last = p.clone(); lastMoveAt = Date.now() }
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
  try {
    return await withTimeout(Promise.race([bot.pathfinder.goto(goal), stalled]), timeout, 'pathfinding')
  } finally {
    clearInterval(sampler)
    if (watchdog) clearInterval(watchdog)
  }
}

async function goNear(s, pos, range, timeout = 60000) {
  if (s.bot.entity.position.distanceTo(pos) <= range + 0.5) return
  let resets = 0
  const onReset = r => { if (r === 'place_error' || r === 'dig_error') resets++ }
  s.bot.on('path_reset', onReset)
  try {
    await gotoWatched(s, new goals.GoalNear(pos.x, pos.y, pos.z, range), timeout)
  } catch (e) {
    s.bot.pathfinder.setGoal(null)
    if (!s.bot) fail('disconnected', 'bot disconnected during action')
    if (e instanceof ApiError) { e.extra = { pos: fmt(s.bot.entity.position), dist_left: +s.bot.entity.position.distanceTo(pos).toFixed(1), resets }; throw e }
    fail('path_not_found', e.message, { from: fmt(s.bot.entity.position), to: fmt(pos) })
  } finally { if (s.bot) s.bot.removeListener('path_reset', onReset) }
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
  while (Date.now() - t0 < timeout) {
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
  await sleep(400)
  for (let k = 0; k < 4; k++) {
    const drop = Object.values(s.bot.entities)
      .filter(e => e.name === 'item' && e.position.distanceTo(near) < radius)
      .sort((a, b) => a.position.distanceTo(s.bot.entity.position) - b.position.distanceTo(s.bot.entity.position))[0]
    if (!drop) return
    try { await goNear(s, drop.position, 0.5, 8000) } catch { return }
    await sleep(300)
  }
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

function nearestBlockOf(s, names, maxDistance = 32) {
  const ids = names.map(n => s.mcData.blocksByName[n]?.id).filter(x => x !== undefined)
  return s.bot.findBlock({ matching: ids, maxDistance })
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
    what = e.name
    opener = () => s.bot.activateEntity(e)
  } else {
    let block
    if (target.pos) {
      const [x, y, z] = target.pos
      block = s.bot.blockAt(new Vec3(x, y, z))
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
    trades = p.trades.map(t => ({
      raw: t,
      cost1: tradeItem(s, t.inputItem1), cost2: t.inputItem2 ? tradeItem(s, t.inputItem2) : null,
      result: itemSummaryNotch(s, t.outputItem), disabled: t.tradeDisabled, uses: t.nbTradeUses, max_uses: t.maximumNbTradeUses,
      special_price: t.specialPrice, demand: t.demand, multiplier: t.priceMultiplier
    }))
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
    const t = setTimeout(() => { s.bot.removeListener('windowOpen', ok); reject(new ApiError('no_window', `${what} did not open a GUI`)) }, 2500)
    const ok = w => { clearTimeout(t); resolve(w) }
    s.bot.once('windowOpen', ok)
  })
  try {
    opener()
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
  const have = windowInvCounts(w)[item] || 0
  if (!have) fail('missing_item', `no ${item} in inventory`, { inventory: windowInvCounts(w) })
  let want = Math.min(count ?? have, have)
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
      if (moved >= (count ?? 1)) break
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

async function opTake(s, w, kind, { from, item, count }) {
  const secs = kind.sections(w)
  if (!secs[from]) fail('bad_section', `section "${from}" not in ${shortType(w.type)}; have: ${Object.keys(secs).join(', ')}`)
  const isOutput = (kind.outputs || []).includes(from)
  const xp0 = s.bot.experience.level
  const before = windowInvCounts(w)
  let left = count ?? Infinity
  // 成品由服务器计算后下发（锻造台、砂轮等），刚放完材料时可能还没到，稍等
  if (isOutput) for (let k = 0; k < 15 && !secs[from].some(i => w.slots[i]); k++) await sleep(100)
  for (const i of secs[from]) {
    if (left <= 0) break
    const cur = w.slots[i]
    if (!cur || (item && cur.name !== item)) continue
    if (isOutput) {
      // 成品槽只能整组取：点一下拿到光标上，再放回背包
      await s.bot.clickWindow(i, 0, 0)
      await sleep(250)
      if (!w.selectedItem) fail('option_unavailable', `server refused to hand out ${cur.name} (not enough xp/payment?)`)
      await s.bot.putSelectedItemRange(w.inventoryStart, w.inventoryEnd, w, null)
      left -= cur.count
    } else {
      const n = Math.min(cur.count, left)
      if (n >= cur.count) await s.bot.putAway(i)
      else await s.bot.transfer({ window: w, itemType: cur.type, metadata: null, sourceStart: i, sourceEnd: i + 1, destStart: w.inventoryStart, destEnd: w.inventoryEnd, count: n })
      left -= n
    }
    await sleep(150)
  }
  const after = windowInvCounts(w)
  const gained = {}
  for (const [k, v] of Object.entries(after)) if (v > (before[k] || 0)) gained[k] = v - (before[k] || 0)
  if (!Object.keys(gained).length) fail(isOutput ? 'no_output' : 'missing_item', `nothing${item ? ' matching ' + item : ''} to take from ${from}`)
  const dxp = s.bot.experience.level - xp0
  return { took: gained, from, ...(dxp < 0 ? { xp_spent: -dxp } : dxp > 0 ? { xp_gained: dxp } : {}) }
}

async function opSelect(s, w, kind, { option, times = 1 }) {
  if (!kind.select) fail('bad_args', `${shortType(w.type)} has no selectable options`)
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
  for (let n = 0; n < times; n++) {
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
      results.push(await opTake(s, w, kind, { from: 'output' }))
      if (w.trades && w.trades[option]) {
        const t = w.trades[option]
        t.uses++
        if (t.uses >= t.max_uses) t.disabled = true
        w.selectedTrade = mineflayerTrade(s, t)
        if (t.disabled || !hasItems(s, w, [t.cost1, t.cost2].filter(Boolean))) { n = times } // 用完次数或付不起，提前结束
      }
    } else if (w.type === 'minecraft:enchantment') {
      results.push({ enchanted: w.slots[0] && w.slots[0].name, enchantments: w.slots[0] ? itemExtras(w.slots[0]).enchantments || [] : null, xp_level: s.bot.experience.level })
    } else results.push({ selected: option })
  }
  // 交易完把留在付款槽的物品退回背包，避免界面关闭时掉出
  if (w.type === 'minecraft:merchant') for (const i of [0, 1]) if (w.slots[i]) { await s.bot.putAway(i).catch(() => {}); await sleep(100) }
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

function missingIngredients(s, recipe) {
  const needs = {}
  for (const d of (recipe.delta || [])) if (d.count < 0) { const n = s.mcData.items[d.id].name; needs[n] = (needs[n] || 0) - d.count }
  return needs
}

async function craftManually(s, it, count, table, known) {
  const before = invCounts(s.bot)[it.name] || 0
  const gridW = table ? 3 : 2
  for (let round = 0; round < 64 && (invCounts(s.bot)[it.name] || 0) - before < count; round++) {
    const recipe = s.bot.recipesFor(it.id, null, 1, table)[0]
    if (!recipe) break
    const win = table ? await s.bot.openBlock(table) : s.bot.inventory
    const gridSize = gridW * gridW
    const invStart = table ? win.inventoryStart : 9
    try {
      const cells = []
      if (recipe.inShape) recipe.inShape.forEach((row, r) => row.forEach((ing, c) => { if (ing && ing.id !== -1) cells.push([1 + r * gridW + c, ing.id]) }))
      else recipe.ingredients.forEach((ing, i) => cells.push([1 + i, ing.id]))
      for (const [gridSlot, id] of cells) {
        const src = win.slots.findIndex((si, i) => i >= invStart && si && si.type === id)
        if (src < 0) fail('missing_ingredients', `ran out of ${s.mcData.items[id].name}`, { example_recipe_needs: missingIngredients(s, recipe), inventory: invCounts(s.bot) })
        await s.bot.clickWindow(src, 0, 0); await sleep(120)
        await s.bot.clickWindow(gridSlot, 1, 0); await sleep(120)
        await s.bot.clickWindow(src, 0, 0); await sleep(120)
      }
      for (let i = 0; i < 10 && !win.slots[0]; i++) await sleep(100)
      if (!win.slots[0] || win.slots[0].type !== it.id) break
      await s.bot.clickWindow(0, 0, 1); await sleep(300)
    } finally {
      for (let sl = 1; sl <= gridSize; sl++) if (win.slots[sl]) { await s.bot.clickWindow(sl, 0, 1).catch(() => {}); await sleep(80) }
      if (table) s.bot.closeWindow(win)
    }
  }
  await sleep(1500)
  const made = (invCounts(s.bot)[it.name] || 0) - before
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
    if (!s.bot || !s.bot.entity) fail('not_connected', 'bot not connected')
    const b = s.bot
    const e = b.entity
    const p = e.position
    const feet = b.blockAt(p)
    const head = b.blockAt(p.offset(0, 1.62, 0))
    const vehicle = b.vehicle
    return {
      username: b.username, pos: fmt(p), yaw: +e.yaw.toFixed(2),
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
      jumping: !!b.getControlState('jump'),
      blocking: !!(s.posture.shield && b.inventory.slots[45] && b.inventory.slots[45].name === 'shield'),
      using_item: s.usingItem ? { name: s.usingItem.name, elapsed_ms: Date.now() - s.usingItem.t } : null,
      time_of_day: b.time.timeOfDay, is_day: b.time.isDay,
      raining: b.isRaining, thundering: !!b.thunderState,
      biome: feet && feet.biome && feet.biome.name, on_ground: e.onGround,
      // ready：就绪适配器确认已在目标服务器且存活，可以调用动作接口
      alive: s.alive, ready: !!(s.alive && s.isReady()), busy: s.busy && s.busy.name,
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
    radius = Number(radius)
    limit = Number(limit)
    if (!Number.isFinite(radius) || radius < 1) fail('bad_args', 'radius must be a number between 1 and 64')
    if (!Number.isFinite(limit) || limit < 1) fail('bad_args', 'limit must be a positive number')
    radius = Math.min(radius, 64)
    const skip = new Set(['air', 'cave_air', 'void_air'])
    const me = s.bot.entity.position
    if ((properties || mature !== undefined) && !(types && types.length)) fail('bad_args', 'properties / mature filters require types')
    if (types && types.length) {
      const ids = types.map(n => { const b = s.mcData.blocksByName[n]; if (!b) fail('bad_args', `unknown block ${n}`); return b.id })
      if (properties) checkPropFilter(s, types, properties)
      if (mature !== undefined && !types.some(n => CROP_AGE_PROP[n])) fail('bad_args', `mature filter only applies to crops: ${Object.keys(CROP_AGE_PROP).join(', ')}`)
      const found = []
      for (const p of s.bot.findBlocks({ matching: ids, maxDistance: radius, count: 10000 })) {
        if (!isExposed(s, p)) continue
        const b = s.bot.blockAt(p)
        const props = blockProps(b)
        if (properties && Object.entries(properties).some(([k, v]) => String(props[k]) !== String(v))) continue
        const crop = cropInfo(s, b, props)
        if (mature !== undefined && crop.mature !== !!mature) continue
        found.push({ name: b.name, pos: [p.x, p.y, p.z], dist: +p.distanceTo(me).toFixed(1), properties: props, ...crop })
      }
      found.sort((a, b) => a.dist - b.dist)
      return { total: found.length, blocks: found.slice(0, limit) }
    }
    const pts = s.bot.findBlocks({ matching: b => b && !skip.has(b.name), useExtraInfo: p => isExposed(s, p), maxDistance: radius, count: 4000 })
    const summary = {}
    for (const p of pts) {
      const n = s.bot.blockAt(p).name
      const d = p.distanceTo(me)
      const rec = summary[n] || (summary[n] = { count: 0, nearest: null, dist: 1e9 })
      rec.count++
      if (d < rec.dist) { rec.dist = +d.toFixed(1); rec.nearest = [p.x, p.y, p.z] }
    }
    return { radius, scanned: pts.length, blocks: Object.fromEntries(Object.entries(summary).sort((a, b) => a[1].dist - b[1].dist)) }
  },
  async get_entities(s, { radius = 32, types }) {
    if (!s.bot || !s.bot.entity) fail('not_connected', 'bot not connected')
    const me = s.bot.entity.position
    return {
      entities: Object.values(s.bot.entities)
        .filter(e => e !== s.bot.entity && e.position.distanceTo(me) <= radius)
        .filter(e => !types || types.includes(e.name) || types.includes(e.type))
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
    // 之前直接把 undefined/NaN 丢给 blockAt，结果 null 被报成 not_loaded，误导调用方
    const nums = [x, y, z].map(Number)
    if (nums.some(n => !Number.isFinite(n))) fail('bad_args', 'x, y, z must be finite numbers (or pass pos:[x,y,z])')
    const [bx, by, bz] = nums
    const b = s.bot.blockAt(new Vec3(bx, by, bz))
    if (!b) fail('not_loaded', 'chunk not loaded')
    const props = blockProps(b)
    return { name: b.name, pos: [bx, by, bz], properties: props, ...cropInfo(s, b, props), diggable: b.diggable, hardness: b.hardness, harvest_tool_ok: s.bot.canDigBlock(b) }
  },

  // ---------- actions ----------
  async move_to(s, { x, y, z, range = 1, entity_id, timeout = 60000 }) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    const dimensionBefore = s.bot.game.dimension
    // 骑着东西时不能走，只能掌舵：同一个接口自动切到载具模式（y 忽略）
    if (s.bot.vehicle) {
      const target = entity_id !== undefined ? s.bot.entities[entity_id] : null
      if (entity_id !== undefined && !target) fail('no_such_entity', `entity ${entity_id} not visible`)
      const tx = target ? target.position.x : x
      const tz = target ? target.position.z : z
      if (tx === undefined || tz === undefined) fail('bad_args', 'vehicle mode needs x/z or entity_id')
      const out = await driveVehicle(s, tx, tz, Math.max(range, 1.5), timeout)
      return { ...out, pos: fmt(s.bot.entity.position), drove: true }
    }
    try {
      if (entity_id !== undefined) {
        const e = s.bot.entities[entity_id]
        if (!e) fail('no_such_entity', `entity ${entity_id} not visible`)
        await goNear(s, e.position, Math.max(range, 2), timeout)
      } else if (y === undefined || y === null) {
        const t0 = Date.now()
        try {
          await gotoWatched(s, new goals.GoalNearXZ(x, z, range), timeout)
        } catch (e) {
          s.bot.pathfinder.setGoal(null)
          if (e instanceof ApiError) throw e
          fail('path_not_found', e.message, { pos: fmt(s.bot.entity.position), ms: Date.now() - t0 })
        }
      } else {
        await goNear(s, new Vec3(x, y ?? s.bot.entity.position.y, z), range, timeout)
      }
    } catch (e) {
      // Entering an End portal changes dimension immediately. Pathfinder then
      // rejects its old-world goal, even though the requested movement worked.
      if (s.bot && s.bot.game.dimension !== dimensionBefore) {
        s.bot.pathfinder.setGoal(null)
        return { pos: fmt(s.bot.entity.position), dimension_changed: { from: dimensionBefore, to: s.bot.game.dimension } }
      }
      throw e
    }
    return { pos: fmt(s.bot.entity.position) }
  },
  async dig(s, { x, y, z, collect = true }) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    const p = new Vec3(x, y, z)
    const block = s.bot.blockAt(p)
    if (!block) fail('not_loaded', 'chunk not loaded')
    if (block.name.endsWith('air') || block.boundingBox === 'empty' && !block.name.includes('grass') && !block.name.includes('flower')) {
      if (block.name.endsWith('air')) fail('nothing_to_dig', `block at ${p} is ${block.name}`)
    }
    if (!block.diggable) fail('undiggable', `${block.name} is not diggable`)
    await goNear(s, p, 3.5)
    const best = s.bot.pathfinder.bestHarvestTool(block)
    const tool = best && /_(pickaxe|axe|shovel|hoe|sword)$|^shears$/.test(best.name) ? best : null
    if (tool) await s.bot.equip(tool, 'hand')
    else if (s.bot.heldItem) await s.bot.unequip('hand')
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
      await withTimeout(s.bot.dig(block, true), 30000, 'dig').catch(e => { if (!s.interruptedBy) throw e })
      if (s.interruptedBy) return {}
      // 服务端判定挖得"太快"时会延后补完（还要几 tick），再加上来回延迟
      const ping = (s.bot.player && s.bot.player.ping) || 0
      const deadline = Date.now() + Math.min(6000, 1500 + 3 * ping)
      while (Date.now() < deadline && (watch.state === null || watch.state === block.stateId)) await sleep(25)
      after = watch.state
    } finally {
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
    if (x === undefined) {
      const site = autoPlaceSite(s)
      if (!site) fail('no_support', 'no free spot with solid ground within 3 blocks')
      ;({ x, y, z } = site)
    }
    const target = new Vec3(x, y, z)
    const cur = s.bot.blockAt(target)
    if (cur && cur.boundingBox !== 'empty') fail('occupied', `${cur.name} already at target`)
    const it = findItem(s, item)
    const faces = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].map(a => new Vec3(...a))
    let ref = null; let face = null
    for (const f of faces) {
      const r = s.bot.blockAt(target.plus(f))
      if (r && r.boundingBox === 'block') { ref = r; face = f.scaled(-1); break }
    }
    if (!ref) fail('no_support', 'no solid neighbour block to place against')
    await goNear(s, target, 3.5)
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
      s.bot.setControlState('sneak', !!s.posture.sneak)
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
    const p = new Vec3(x, y, z)
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
    const changed = aft.stateId !== block.stateId || (upAfter && upBefore && upAfter.stateId !== upBefore.stateId)
    const props = blockProps(aft)
    return {
      block: block.name, before: blockProps(block),
      after: { name: aft.name, properties: props, ...cropInfo(s, aft, props) },
      ...(upAfter && upBefore && upAfter.stateId !== upBefore.stateId ? { above: { before: upBefore.name, after: upAfter.name, properties: blockProps(upAfter) } } : {}),
      changed, ...(Object.keys(used).length ? { used } : {})
    }
  },
  // 攻击：按手持物品的原版攻速挥击（空手 250ms、剑 625ms、斧 1000ms…），
  // max_hits 用于"打一下就走"（风筝苦力怕、单次敲船/矿车）。
  async attack(s, { entity_id, timeout = 20000, max_hits, interval_ms }) {
    if (!s.bot) fail('not_connected', 'bot not connected')
    const e = s.bot.entities[entity_id]
    if (!e) fail('no_such_entity', `entity ${entity_id} not visible`)
    if (max_hits !== undefined && (!Number.isInteger(max_hits) || max_hits < 1)) fail('bad_args', 'max_hits must be a positive integer')
    if (interval_ms !== undefined && (!Number.isFinite(interval_ms) || interval_ms < 50 || interval_ms > 5000)) fail('bad_args', 'interval_ms must be between 50 and 5000')
    const weapon = s.bot.inventory.items().filter(i => /_sword$|_axe$/.test(i.name)).sort((a, b) => (b.name.includes('sword') - a.name.includes('sword')))[0]
    if (weapon) await s.bot.equip(weapon, 'hand')
    const interval = interval_ms ?? attackIntervalMs(s.bot.heldItem)
    const t0 = Date.now(); let hits = 0
    s.bot.pathfinder.setGoal(new goals.GoalFollow(e, 1.5), true)
    try {
      while (s.bot && s.bot.entities[entity_id] && e.isValid && Date.now() - t0 < timeout && !s.interruptedBy) {
        if (e.position.distanceTo(s.bot.entity.position) < 3.2) {
          await s.bot.lookAt(e.position.offset(0, e.height * 0.8, 0), true)
          s.bot.attack(e); hits++
          if (max_hits && hits >= max_hits) break
        }
        await sleep(interval)
      }
    } finally { s.bot.pathfinder.setGoal(null) }
    const killed = !s.bot.entities[entity_id] || !e.isValid
    if (killed) await collectDrops(s, e.position, 5)
    return { killed, hits, interval_ms: interval, ms: Date.now() - t0, inventory: invCounts(s.bot) }
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
    if (weapon === 'crossbow' && !hasArrow(s.bot) && !s.bot.inventory.items().some(i => i.name === 'firework_rocket')) {
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
    try {
      if (weapon === 'crossbow') {
        if (!crossbowLoaded(s.bot.heldItem)) {
          s.bot.activateItem()
          await sleep(charge_ms)
          s.bot.deactivateItem()
          await sleep(200)
        }
        aim = projectileAim(s.bot, targetPoint(), physics, entity && entity.velocity)
        await s.bot.look(aim.yaw, aim.pitch, true)
        s.bot.activateItem()
        await sleep(150)
        s.bot.deactivateItem()
      } else {
        s.bot.activateItem()
        await sleep(charge_ms)
        aim = projectileAim(s.bot, targetPoint(), physics, entity && entity.velocity)
        await s.bot.look(aim.yaw, aim.pitch, true)
        s.bot.deactivateItem()
      }
    } finally {
      try { s.bot.deactivateItem() } catch {}
    }
    await sleep(500)

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
    const known = s.bot.recipesAll(it.id, null, true)
    if (!known.length) fail('no_recipe', `${item} has no crafting recipe`)
    const entries = [...s.bot.recipeBook.entries()].filter(([, r]) => r.display?.data?.result?.data?.itemId === it.id)
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
    for (let round = 0; made < count && round < 64; round++) {
      let gotOne = false
      for (const [displayId, r] of entries) {
        const win = table ? await s.bot.openBlock(table) : null
        const windowId = win ? win.id : 0
        const resultSlots = () => (win || s.bot.inventory).slots[0]
        try {
          s.bot._client.write('craft_recipe_request', { windowId, recipeId: displayId, makeAll: false })
          for (let i = 0; i < 10 && !resultSlots(); i++) await sleep(100)
          const res = resultSlots()
          if (res && res.type === it.id) {
            await s.bot.clickWindow(0, 0, 1)
            await sleep(250)
            gotOne = true
          } else lastErr = 'server placed no result'
        } finally {
          if (win) s.bot.closeWindow(win)
          else for (let sl = 1; sl <= 4; sl++) if (s.bot.inventory.slots[sl]) await s.bot.clickWindow(sl, 0, 1).catch(() => {})
          await sleep(150)
        }
        if (gotOne) break
      }
      made = (invCounts(s.bot)[item] || 0) - before
      if (!gotOne) break
    }
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
          e.extra = { ...(e.extra || {}), failed_op: i, done, window: s.bot.currentWindow === w ? describeWindow(s, w) : null }
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
      s.usingItem = { name: 'shield', t: Date.now() }
      s.bot.activateItem(true)
      await sleep(hold)
      try { s.bot.deactivateItem() } catch {}
      s.usingItem = null
      return { used: { name: 'shield', count: 0 }, blocked_ms: hold }
    }

    if (!held() || held().name !== item) await s.bot.equip(it, dest)

    // 投掷类
    if (THROWABLE.has(item)) {
      const before = s.bot.entity.position.clone()
      const countBefore = (held() && held().count) || 0
      const knownEntities = new Set(Object.keys(s.bot.entities))
      s.usingItem = { name: item, t: Date.now() }
      s.bot.activateItem(dest === 'off-hand')
      await sleep(200)
      try { s.bot.deactivateItem() } catch {}
      s.usingItem = null
      await sleep(item === 'ender_pearl' ? 1500 : 400)
      const left = held() && held().name === item ? held().count : 0
      const out = { used: { name: item, count: Math.max(1, countBefore - left) }, thrown: true }
      if (item === 'ender_pearl') {
        out.teleported = s.bot.entity.position.distanceTo(before) > 1
        out.pos = fmt(s.bot.entity.position)
      }
      if (item === 'ender_eye') {
        // 末影之眼会被服务端当成实体下发，等它出现再读飞行方向
        let eye = null
        for (let i = 0; i < 20 && !eye; i++) {
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
        s.bot.activateItem(false)   // 收竿
        await sleep(1500)
        try { s.bot.deactivateItem() } catch {}
        await sleep(1200)
      }
      s.usingItem = { name: 'fishing_rod', t: t0 }
      let casts = 0, falseBites = 0, lastInfo = {}
      try {
        while (Date.now() - t0 < maxWait - 3000 && !s.interruptedBy) {
          casts++
          const beforeIds = new Set(Object.values(s.bot.entities).map(e => e.id))
          s.bot.activateItem(false)
          let bobber = null
          for (let i = 0; i < 40 && !bobber; i++) {
            await sleep(100)
            bobber = Object.values(s.bot.entities).find(e => !beforeIds.has(e.id) && /bobber/.test(e.name || ''))
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
          while (Date.now() - t0 < maxWait) {
            await sleep(100)
            if (!s.bot.entities[bobber.id]) break
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
          lastInfo = { bobber_y: +bobber.position.y.toFixed(2), base_y: refY === null ? null : +refY.toFixed(2), in_water: wet(bobber.position) }
          await reel()
          const caught = caughtNow()
          if (Object.keys(caught).length) {
            return { used: { name: 'fishing_rod', count: 0 }, caught, wait_ms: Date.now() - t0, casts, false_bites: falseBites }
          }
          if (bite) falseBites++
        }
      } finally {
        try { s.bot.deactivateItem() } catch {}
        s.usingItem = null
      }
      fail('timeout', s.interruptedBy ? `nothing caught before the ${s.interruptedBy} interruption (${Date.now() - t0}ms)` : `nothing caught within ${maxWait}ms`, { casts, false_bites: falseBites, waited_ms: Date.now() - t0, ...lastInfo })
    }

    // 望远镜：保持 ms，配合 target 看向目标
    if (item === 'spyglass') {
      const hold = Math.max(100, Math.min(Number(ms) || 800, 5000))
      s.usingItem = { name: 'spyglass', t: Date.now() }
      s.bot.activateItem(dest === 'off-hand')
      await sleep(hold)
      try { s.bot.deactivateItem() } catch {}
      s.usingItem = null
      return { used: { name: 'spyglass', count: 0 }, observed_ms: hold, ...(target && target.entity_id !== undefined ? { target: target.entity_id } : {}) }
    }

    if (item === 'goat_horn') {
      s.usingItem = { name: 'goat_horn', t: Date.now() }
      s.bot.activateItem(dest === 'off-hand')
      await sleep(1200)
      try { s.bot.deactivateItem() } catch {}
      s.usingItem = null
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
      s.usingItem = { name: item, t: Date.now() }
      s.bot.activateItem(dest === 'off-hand')
      const t0 = Date.now()
      let done = false
      while (Date.now() - t0 < Math.min(Number(timeout) || 8000, 8000)) {
        await sleep(100)
        const cur = held()
        if (!before) { done = true; break }
        if (!cur || cur.name !== before.name || cur.count < before.count) { done = true; break }
      }
      try { s.bot.deactivateItem() } catch {}
      s.usingItem = null
      if (!done) {
        fail('timeout', `could not finish using ${item}`, {
          held_before: before,
          held_now: held() ? { name: held().name, count: held().count } : null,
          using_held: !!s.bot.usingHeldItem,
          food: s.bot.food,
          effects: effectList(s)
        })
      }
      await sleep(300)
      return {
        used: { name: item, count: 1 },
        food_before: foodBefore, food: s.bot.food,
        health_before: healthBefore, health: s.bot.health,
        effects: effectList(s)
      }
    }

    // 打火石、水桶这类必须对着方块用的东西，引导到 /interact
    if (/bucket$|flint_and_steel$|_seeds$|bone_meal$|_hoe$/.test(item)) {
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
    await sleep(150)
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
  async control(s, { forward, back, left, right, jump, sneak, sprint, yaw, pitch, ms, hit, hit_interval_ms }) {
    if (!s.bot || !s.bot.entity) fail('not_connected', 'bot not connected')
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
    if (!keys.some(k => want[k]) && !hits) fail('bad_args', 'set at least one of forward/back/left/right/jump/sneak/sprint or hit')
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
    return { yaw: +s.bot.entity.yaw.toFixed(3), pitch: +s.bot.entity.pitch.toFixed(3) }
  },

  async stop(s) {
    if (!s.bot) return { stopped: false }
    s.bot.pathfinder.setGoal(null)
    s.bot.stopDigging()
    s.bot.clearControlStates()
    try { s.bot.deactivateItem() } catch {}
    s.applyPosture()
    return { stopped: true }
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
    if (Date.now() < s.deathLoopCooldownUntil) {
      const remaining = Math.ceil((s.deathLoopCooldownUntil - Date.now()) / 1000)
      fail('death_loop_cooldown', `bot is in death loop cooldown, ${remaining}s remaining`)
    }
    s.connect()
    return { ok: true, reconnect: true }
  },
  async disconnect(s) {
    if (s.bot) s.bot.quit()
    return { ok: true }
  }
}

// window_view 会走路并打开界面，要占动作锁，所以不放进只读集合
const READONLY = new Set(['status', 'inventory', 'find_blocks', 'get_entities', 'events', 'advancements', 'get_block', 'stop', 'connect', 'disconnect', 'posture', 'look'])

module.exports = { configure, Session, sessions, api, READONLY, ApiError, fail, fmt, log, sleep }
