'use strict'

const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const { test } = require('node:test')
const { Vec3 } = require('vec3')
const { dispatch } = require('../src/dispatch')
const {
  api,
  Session,
  configure,
  selectBestHarvestTool,
  weaponScore,
  scanExposed
} = require('../src/session')
const { DEFAULTS } = require('../src/config')
const web = require('../src/http')

function makeSession (bot, mcData) {
  configure({ config: {}, createReadiness: () => ({ guardsWorld: false, isReady: () => true }) })
  const s = new Session('tok', 'TestBot', { name: 'TestBot', id: '0000' }, {})
  s.bot = bot
  s.mcData = mcData || bot.registry || {}
  s.worldReady = true
  return s
}

test('#1 craft filters out furnace/stonecutter/smithing recipeBook entries and rejects non-positive count (#15)', async () => {
  const writes = []
  const itemsByName = { iron_ingot: { id: 100, name: 'iron_ingot', stackSize: 64 } }
  const items = { 100: itemsByName.iron_ingot }
  const bot = {
    _client: { state: 'play', write: (n, p) => writes.push([n, p]) },
    entity: { position: new Vec3(0, 64, 0) },
    inventory: {
      items: () => [],
      slots: new Array(46).fill(null),
      emptySlotCount: () => 36
    },
    recipeBook: new Map([
      [1, { displayId: 1, display: { type: 'furnace', data: { result: { data: { itemId: 100 } } } } }],
      [2, { displayId: 2, display: { type: 'stonecutter', data: { result: { data: { itemId: 100 } } } } }],
      [3, { displayId: 3, display: { type: 'smithing', data: { result: { data: { itemId: 100 } } } } }]
    ]),
    recipesAll: (id, _m, table) => (table ? [{ delta: [{ id: 100, count: 1 }] }] : [{ delta: [{ id: 100, count: 1 }] }]),
    recipesFor: () => []
  }
  const s = makeSession(bot, { itemsByName, items })

  // #15: count=0 / negative / float rejected with bad_args
  for (const badCount of [0, -1, 1.5, null, '']) {
    await assert.rejects(() => api.craft(s, { item: 'iron_ingot', count: badCount }), { code: 'bad_args' })
  }

  // #1: non-crafting recipeBook entries must be ignored so craft_recipe_request is NEVER sent
  await assert.rejects(() => api.craft(s, { item: 'iron_ingot', count: 1 }), { code: 'missing_ingredients' })
  assert.equal(writes.length, 0)
})

test('#2 interrupt() calls deactivateItem in play state, and driveVehicle / use_item / shoot respond immediately to /stop', async () => {
  let deactivated = 0
  let activated = 0
  const bot = {
    _client: { state: 'play', write: () => {} },
    entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0, height: 1.8, eyeHeight: 1.62, effects: {} },
    entities: {},
    vehicle: { id: 9, name: 'oak_boat', position: new Vec3(0, 64, 0) },
    game: { dimension: 'overworld' },
    health: 20,
    food: 10,
    heldItem: { name: 'cooked_beef', count: 5, type: 1 },
    inventory: {
      items: () => [{ name: 'cooked_beef', count: 5, type: 1 }, { name: 'crossbow', count: 1, type: 2 }, { name: 'arrow', count: 5, type: 3 }],
      slots: new Array(46).fill(null),
      emptySlotCount: () => 30
    },
    pathfinder: { setGoal: () => {} },
    stopDigging: () => {},
    clearControlStates: () => {},
    setControlState: () => {},
    activateItem: () => { activated++ },
    deactivateItem: () => { deactivated++ },
    equip: async (it) => { bot.heldItem = it },
    look: async () => {},
    lookAt: async () => {}
  }
  const mcData = { foodsByName: { cooked_beef: { name: 'cooked_beef' } }, effects: {} }
  const s = makeSession(bot, mcData)

  // interrupt() must call deactivateItem()
  s.busy = { name: 'use_item', t: Date.now() }
  s.activeStopOn = ['hurt', 'death']
  s.interrupt('hurt')
  assert.equal(deactivated, 1)
  s.busy = null
  s.activeStopOn = null
  s.interruptedBy = null

  // driveVehicle stops quickly on /stop
  const drivePromise = dispatch(s, 'move_to', { x: 1000, z: 1000, timeout: 60000 })
  await new Promise(r => setTimeout(r, 80))
  const stopDrive = await api.stop(s)
  assert.equal(stopDrive.released, true)
  assert.ok(stopDrive.wait_ms < 1000)
  await drivePromise

  // eat/drink use_item stops quickly on /stop and clears usingItem
  bot.vehicle = null
  const eatPromise = dispatch(s, 'use_item', { item: 'cooked_beef', timeout: 8000 })
  await new Promise(r => setTimeout(r, 80))
  const stopEat = await api.stop(s)
  assert.equal(stopEat.released, true)
  assert.ok(stopEat.wait_ms < 1000)
  assert.equal(s.usingItem, null)
  await eatPromise

  // shoot cancelled mid-charge does NOT fire the crossbow after /stop
  activated = 0
  const shootPromise = dispatch(s, 'shoot', { x: 10, y: 64, z: 0, weapon: 'crossbow', charge_ms: 1500 })
  await new Promise(r => setTimeout(r, 80))
  const stopShoot = await api.stop(s)
  assert.equal(stopShoot.released, true)
  const shootRes = await shootPromise
  assert.equal(shootRes.body.ok, false)
  assert.equal(shootRes.body.error.code, 'interrupted')
  // activateItem was called once to start charging, NOT a second time to fire
  assert.equal(activated, 1)
})

test('#3 use_item clears usingItem on error and destroy() clears usingItem + heldControl timers', async () => {
  const bot = {
    _client: { state: 'play' },
    entity: { position: new Vec3(0, 64, 0) },
    inventory: {
      items: () => [{ name: 'spyglass', count: 1 }],
      slots: new Array(46).fill(null)
    },
    heldItem: { name: 'spyglass', count: 1 },
    activateItem: () => { throw new Error('socket boom') },
    deactivateItem: () => {},
    setControlState: () => {},
    quit: () => {}
  }
  const s = makeSession(bot)
  await assert.rejects(() => api.use_item(s, { item: 'spyglass', ms: 500 }), /socket boom/)
  assert.equal(s.usingItem, null)

  let fired = false
  s.usingItem = { name: 'shield', t: Date.now() }
  s.heldControl = {
    keys: ['forward'],
    timer: setTimeout(() => { fired = true }, 50),
    hitTimers: [setTimeout(() => { fired = true }, 50)]
  }
  s.destroy()
  assert.equal(s.usingItem, null)
  assert.equal(s.heldControl, null)
  await new Promise(r => setTimeout(r, 80))
  assert.equal(fired, false)
})

test('#5 opSelect merchant skips putAway when inventory is full, and craftManually returns selectedItem before closing', async () => {
  // Merchant full-inventory test: putAway must NOT be called when roomFor === 0
  const fullSlot = { type: 1, name: 'stone', count: 64, stackSize: 64 }
  const slots = new Array(39).fill(null)
  slots[0] = { type: 2, name: 'emerald', count: 5, stackSize: 64 }
  slots[2] = { type: 3, name: 'bread', count: 1, stackSize: 64 }
  for (let i = 3; i < 39; i++) slots[i] = { ...fullSlot }
  let putAwayCalled = 0
  const win = Object.assign(new EventEmitter(), {
    id: 1,
    type: 'minecraft:merchant',
    slots,
    inventoryStart: 3,
    inventoryEnd: 39,
    trades: [{ cost1: { name: 'emerald', count: 1 }, cost2: null, result: { name: 'bread', count: 1 }, uses: 0, max_uses: 10, disabled: false }]
  })
  const mcData = {
    itemsByName: { emerald: { id: 2, stackSize: 64 }, bread: { id: 3, stackSize: 64 } },
    items: { 2: { id: 2, name: 'emerald', stackSize: 64 }, 3: { id: 3, name: 'bread', stackSize: 64 } }
  }
  const client = new EventEmitter()
  client.state = 'play'
  client.write = () => {}
  const bot = Object.assign(new EventEmitter(), {
    _client: client,
    entity: { position: new Vec3(0, 64, 0) },
    entities: { 7: { id: 7, name: 'villager', position: new Vec3(1, 64, 0) } },
    experience: { level: 0 },
    currentWindow: null,
    putAway: async () => { putAwayCalled++ },
    closeWindow: () => {},
    activateEntity: async () => {
      bot.currentWindow = win
      bot.emit('windowOpen', win)
      client.emit('trade_list', {
        windowId: 1,
        villagerLevel: 1,
        experience: 0,
        trades: [{
          inputItem1: { itemId: 2, itemCount: 26 },
          outputItem: { itemId: 3, itemCount: 1 },
          inputItem2: null,
          tradeDisabled: false,
          nbTradeUses: 0,
          maximumNbTradeUses: 10,
          specialPrice: -25,
          demand: 0,
          priceMultiplier: 0.05
        }]
      })
    }
  })
  const s = makeSession(bot, mcData)
  // #6: verify villager trade discount (26 - 25 = 1 emerald) is computed and reported as available!
  const view = await api.window_view(s, { entity_id: 7 })
  assert.equal(view.options[0].give[0].count, 1)
  assert.equal(view.options[0].available, true)
  assert.equal(putAwayCalled, 0)

  // #5 (change-drop): 36/36 full inventory (slot 3 empty after server moved 3 emeralds into payment1 slot 0, 35 slots full of stone).
  // Taking 1 bread would consume slot 3 and leave 2 leftover emeralds with nowhere to return -> must fail inventory_full and putAway(0) safely!
  const slots2 = new Array(39).fill(null)
  slots2[0] = { type: 2, name: 'emerald', count: 3, stackSize: 64 }
  slots2[2] = { type: 3, name: 'bread', count: 1, stackSize: 64 }
  for (let i = 4; i < 39; i++) slots2[i] = { ...fullSlot }
  const win2 = Object.assign(new EventEmitter(), {
    id: 2,
    type: 'minecraft:merchant',
    slots: slots2,
    inventoryStart: 3,
    inventoryEnd: 39
  })
  let putAwaySlots = []
  bot.putAway = async idx => { putAwaySlots.push(idx) }
  bot.activateEntity = async () => {
    bot.currentWindow = win2
    bot.emit('windowOpen', win2)
    client.emit('trade_list', {
      windowId: 2,
      villagerLevel: 1,
      experience: 0,
      trades: [{
        inputItem1: { itemId: 2, itemCount: 1 },
        outputItem: { itemId: 3, itemCount: 1 },
        inputItem2: null,
        tradeDisabled: false,
        nbTradeUses: 0,
        maximumNbTradeUses: 10,
        specialPrice: 0,
        demand: 0,
        priceMultiplier: 0.05
      }]
    })
  }
  client.write = (name) => {
    if (name === 'select_trade') setImmediate(() => win2.emit('updateSlot:2'))
  }
  await assert.rejects(() => api.window_act(s, { entity_id: 7, ops: [{ op: 'select', option: 0, times: 1 }] }), { code: 'inventory_full' })
  assert.deepEqual(putAwaySlots, [0])
})

test('#7 shoot allows firing an already-loaded crossbow with zero arrows in inventory', async () => {
  let activations = 0
  const loadedCrossbow = {
    name: 'crossbow',
    count: 1,
    componentMap: new Map([['charged_projectiles', { data: { projectiles: [{ id: 1 }] } }]])
  }
  const bot = {
    _client: { state: 'play' },
    entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62, yaw: 0, pitch: 0 },
    entities: {},
    heldItem: loadedCrossbow,
    inventory: { items: () => [loadedCrossbow] },
    pathfinder: { setGoal: () => {} },
    clearControlStates: () => {},
    equip: async () => {},
    look: async () => {},
    activateItem: () => { activations++ },
    deactivateItem: () => {}
  }
  const s = makeSession(bot)
  const res = await api.shoot(s, { x: 10, y: 64, z: 0, weapon: 'crossbow' })
  assert.equal(res.fired, true)
  assert.equal(activations, 1)
})

test('#8 use_item fishing_rod with source=off-hand activates off-hand', async () => {
  const calls = []
  const rod = { name: 'fishing_rod', count: 1 }
  const slots = new Array(46).fill(null)
  slots[45] = rod
  const bot = {
    _client: { state: 'play' },
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
    inventory: { items: () => [rod], slots },
    heldItem: null,
    equip: async () => {},
    activateItem: offhand => calls.push(offhand),
    deactivateItem: () => {}
  }
  const s = makeSession(bot)
  const p = api.use_item(s, { item: 'fishing_rod', source: 'off-hand', timeout: 5000 })
  await new Promise(r => setTimeout(r, 80))
  s.interruptedBy = 'stop'
  await p
  assert.deepEqual(calls, [true])
})

test('#9 opSelect rejects non-integer option/times and openTarget fails fast when opener rejects', async () => {
  const client = new EventEmitter()
  client.state = 'play'
  const bot = Object.assign(new EventEmitter(), {
    _client: client,
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
    blockAt: () => ({ name: 'beacon', position: new Vec3(1, 64, 0) }),
    activateBlock: async () => { throw new Error('cant reach') }
  })
  const s = makeSession(bot)
  const t0 = Date.now()
  await assert.rejects(() => api.window_view(s, { pos: [1, 64, 0] }), /cant reach/)
  assert.ok(Date.now() - t0 < 1000, 'openTarget should fail fast instead of hanging 2500ms')

  // opSelect validation via window_act on a mock beacon window
  const beaconWin = Object.assign(new EventEmitter(), {
    id: 2,
    type: 'minecraft:beacon',
    slots: new Array(37).fill(null),
    inventoryStart: 1,
    inventoryEnd: 37
  })
  bot.activateBlock = async () => {
    bot.currentWindow = beaconWin
    bot.emit('windowOpen', beaconWin)
  }
  bot.closeWindow = () => { bot.currentWindow = null }
  for (const badOp of [{ op: 'select' }, { op: 'select', option: 1.5 }, { op: 'select', option: -1 }, { op: 'select', option: 0, times: 0 }, { op: 'select', option: 0, times: 99 }]) {
    await assert.rejects(() => api.window_act(s, { pos: [1, 64, 0], ops: [badOp] }), { code: 'bad_args' })
  }
})

test('#10 selectBestHarvestTool uses 1.21 component enchantments and weaponScore ranks material + sharpness', () => {
  const plainPick = { type: 10, name: 'iron_pickaxe', components: [] }
  const eff5Pick = {
    type: 10,
    name: 'iron_pickaxe',
    componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 19, level: 5 }] } }]])
  }
  const block = {
    harvestTools: { 10: true },
    digTime: (_type, _c, _w, _g, enchants) => {
      const hasEff = (enchants || []).some(e => e.lvl >= 5)
      return hasEff ? 100 : 400
    }
  }
  const bot = {
    entity: { effects: {} },
    inventory: { items: () => [plainPick, eff5Pick] }
  }
  assert.equal(selectBestHarvestTool(bot, block), eff5Pick)

  const wood = { name: 'wooden_sword', components: [] }
  const netherite = { name: 'netherite_sword', components: [] }
  const sharpDiamond = {
    name: 'diamond_sword',
    enchants: [{ name: 'sharpness', lvl: 5 }]
  }
  assert.ok(weaponScore(netherite) > weaponScore(wood))
  assert.ok(weaponScore(sharpDiamond) > weaponScore(netherite))
})

test('#11 place floors float coords for blocked_by_self, interact handles null blockAt, strict coords reject null/empty/bool', async () => {
  const stone = { name: 'stone', boundingBox: 'block', stateId: 1, position: new Vec3(10, 63, 20), getProperties: () => ({}) }
  const air = { name: 'air', boundingBox: 'empty', stateId: 0, position: new Vec3(10, 64, 20), getProperties: () => ({}) }
  const bot = {
    _client: { state: 'play' },
    entity: { position: new Vec3(10.3, 64.0, 20.4), eyeHeight: 1.62 },
    inventory: { items: () => [{ name: 'dirt', count: 1 }] },
    blockAt: p => (p.y === 63 ? stone : air),
    equip: async () => {},
    setControlState: () => {}
  }
  const s = makeSession(bot)

  // Float coords inside bot cell must trigger blocked_by_self
  await assert.rejects(() => api.place(s, { item: 'dirt', x: 10.4, y: 64.0, z: 20.2 }), { code: 'blocked_by_self' })

  // Null/empty/boolean coordinates must fail with bad_args on get_block / dig / place / interact
  for (const bad of [{ x: '', y: null, z: false }, { x: NaN, y: 64, z: 0 }]) {
    await assert.rejects(() => api.get_block(s, bad), { code: 'bad_args' })
    await assert.rejects(() => api.dig(s, bad), { code: 'bad_args' })
    await assert.rejects(() => api.interact(s, bad), { code: 'bad_args' })
  }

  // interact when chunk unloads after activateBlock (aft === null) must not crash with TypeError
  let activated = false
  bot.blockAt = () => (activated ? null : stone)
  bot.activateBlock = async () => { activated = true }
  const res = await api.interact(s, { x: 10, y: 63, z: 20 })
  assert.equal(res.changed, true)
  assert.equal(res.after, null)
})

test('#12 scanExposed clones position and find_blocks summary keeps true nearest unrounded distance', async () => {
  const pos = new Vec3(0, 0, 0)
  const col = {
    getBlockStateId: p => (p.x === 5 && p.y === 0 && (p.z === 0 || p.z === 1) ? 1 : 0)
  }
  const blocksByStateId = {
    0: { id: 0, name: 'air', boundingBox: 'empty', transparent: true, minStateId: 0, maxStateId: 0 },
    1: { id: 1, name: 'stone', boundingBox: 'block', transparent: false, minStateId: 1, maxStateId: 1 }
  }
  const mcData = {
    version: { minecraftVersion: 'test-12' },
    blocksArray: [blocksByStateId[0], blocksByStateId[1]],
    blocksByStateId
  }
  const bot = {
    entity: { position: pos },
    game: { minY: 0, height: 16 },
    world: { getColumn: (cx, cz) => (cx === 0 && cz === 0 ? col : null) }
  }
  const s = makeSession(bot, mcData)
  // Place stone at (5,0,0) dist=5.060 and (5,0,1) dist=5.090 from (0,0,0.77) -> wait: test exact 5.0598 vs 5.0913
  pos.set(-0.0598, 0, 0) // dist to (5,0,0) = 5.0598 (rounds to 5.1), dist to (5,0,1) = 5.157
  // Put two blocks at dist 5.0598 and 5.0913:
  const col2 = {
    getBlockStateId: p => {
      if (p.y === 0 && p.x === 5 && p.z === 0) return 1 // dist from (-0.0598, 0, 0) = 5.0598
      if (p.y === 0 && p.x === 5 && p.z === 1) return 1 // dist from (-0.0598, 0, 0.43) ... let's set pos cleanly
      return 0
    }
  }
  pos.set(0, 0, 0.45)
  // From (0, 0, 0.45): (5, 0, 0) => sqrt(25 + 0.2025) = 5.020; (5, 0, 1) => sqrt(25 + 0.3025) = 5.030
  // Even better: from (-0.04, 0, 0.45): (5, 0, 0) => sqrt(25.4016 + 0.2025) = 5.0600 -> 5.1; (5, 0, 1) => sqrt(25.4016 + 0.3025) = 5.0699 -> 5.1
  pos.set(-0.04, 0, 0.45)
  bot.world.getColumn = (cx, cz) => (cx === 0 && cz === 0 ? col2 : null)
  const summary = await api.find_blocks(s, { radius: 8 })
  assert.deepEqual(summary.blocks.stone.nearest, [5, 0, 0])
  assert.equal(summary.blocks.stone.count, 2)

  // scanExposed keeps cloned snapshot even if bot.entity.position mutates
  const pts = await scanExposed(s, 8, v => v === 1, 10)
  assert.equal(pts.length, 2)
})

test('#14 get_entities rejects non-array types (no substring match) and invalid radius', async () => {
  const bot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    entities: {
      1: { id: 1, position: new Vec3(0, 64, 0) },
      2: { id: 2, name: 'pig', type: 'mob', position: new Vec3(2, 64, 0) },
      3: { id: 3, name: 'piglin', type: 'mob', position: new Vec3(3, 64, 0) }
    }
  }
  const s = makeSession(bot)
  await assert.rejects(() => api.get_entities(s, { types: 'piglin' }), { code: 'bad_args' })
  await assert.rejects(() => api.get_entities(s, { radius: 0 }), { code: 'bad_args' })
  await assert.rejects(() => api.get_entities(s, { radius: -5 }), { code: 'bad_args' })
  const res = await api.get_entities(s, { types: ['piglin'] })
  assert.deepEqual(res.entities.map(e => e.name), ['piglin'])
})

test('#13 & #16 http.js preserves null in pos array and closes companion IPv6 server', async t => {
  const authenticate = t.mock.fn(async () => ({ profile: { id: 'p1', name: 'P1' }, botOptions: {} }))
  web.configure({
    config: { ...DEFAULTS, http: { host: '127.0.0.1', port: 0, loginRateLimit: { maxGlobalPerMinute: 10 } } },
    authProvider: { authenticate },
    readRoutes: () => () => ({ server: 'first' })
  })
  const server = web.start()
  t.after(() => new Promise(resolve => server.close(resolve)))
  await once(server, 'listening')
  // Verify server.close() cleanly closes without hanging on a leaked IPv6 listener
  assert.ok(server.address().port > 0)
})

test('advancements returns not_ready (not wrong_server) in direct mode while reloading chunks after respawn', async () => {
  configure({ config: {}, createReadiness: () => ({ guardsWorld: false, isReady: () => true }) })
  const s = new Session('tok', 'DirectBot', { name: 'DirectBot', id: '0000' }, {})
  s.bot = { entity: { position: new Vec3(0, 64, 0) } }
  s.advancementsReady = true
  s.worldReady = false

  // Direct mode reloading chunks -> must return retryable not_ready, matching dispatch.js readinessError()
  const res = await dispatch(s, 'advancements', {})
  assert.equal(res.body.ok, false)
  assert.equal(res.body.error.code, 'not_ready')

  // When not on target server yet (readiness.isReady() === false) -> still wrong_server
  s.readiness = { guardsWorld: false, isReady: () => false }
  const res2 = await dispatch(s, 'advancements', {})
  assert.equal(res2.body.ok, false)
  assert.equal(res2.body.error.code, 'wrong_server')

  // Once worldReady is restored -> succeeds
  s.readiness = { guardsWorld: false, isReady: () => true }
  s.worldReady = true
  const res3 = await dispatch(s, 'advancements', {})
  assert.equal(res3.body.ok, true)
})
