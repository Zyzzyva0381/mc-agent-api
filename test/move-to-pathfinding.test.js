const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')
const mcData = require('minecraft-data')('1.21.11')
const { goals } = require('mineflayer-pathfinder')
const { api, createSafeGoto, createMovements } = require('../src/session')

function mockBot(pos = [0, 64, 0]) {
  const bot = new EventEmitter()
  bot.registry = mcData
  bot.game = { dimension: 'overworld', minY: -64, height: 384 }
  bot.entity = { position: new Vec3(pos[0], pos[1], pos[2]), onGround: true, velocity: new Vec3(0, 0, 0), eyeHeight: 1.62 }
  bot.entities = {}
  bot.vehicle = null
  bot.world = { getColumn: () => ({}) }
  bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' })
  bot.controlState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  bot.lookCalls = []
  bot.look = (yaw, pitch) => { bot.lookCalls.push({ yaw, pitch }) }
  bot.setControlState = (k, v) => { bot.controlState[k] = v }
  bot.clearControlStates = () => { for (const k of Object.keys(bot.controlState)) bot.controlState[k] = false }

  let stateGoal = null
  let moving = false
  let movements = { allowParkour: true, allowSprinting: true }
  bot.pathfinder = {
    get goal() { return stateGoal },
    get movements() { return movements },
    setMovements(m) { movements = m; bot.emit('path_reset', 'movements_updated') },
    setGoal(g) { stateGoal = g; bot.emit('goal_updated', g, false) },
    isMoving: () => moving,
    isMining: () => false,
    isBuilding: () => false,
    _setMoving(v) { moving = v }
  }
  bot.pathfinder.goto = createSafeGoto(bot)
  return bot
}

test('createSafeGoto rejects noPath and timeout even when results.path is empty, and clears goal', async () => {
  for (const status of ['noPath', 'timeout']) {
    const bot = mockBot([0.5, 64, 0.5])
    const goal = new goals.GoalBlock(10, 64, 0)
    const p = bot.pathfinder.goto(goal)
    const results = { status, path: [] }
    bot.emit('path_update', results)
    await assert.rejects(p, err => err.name === (status === 'noPath' ? 'NoPath' : 'Timeout'))
    assert.equal(bot.pathfinder.goal, null, `goal must be cleared after ${status}`)
  }
})

test('createSafeGoto clears non-empty path on noPath reject so monitorMovement cannot step 1 tick', async () => {
  const bot = mockBot([0.5, 64, 0.5])
  const goal = new goals.GoalBlock(10, 64, 0)
  const p = bot.pathfinder.goto(goal)
  const results = { status: 'noPath', path: [new Vec3(1.5, 64, 0.5), new Vec3(2.5, 64, 0.5)] }
  bot.emit('path_update', results)
  assert.equal(results.path.length, 0, 'results.path should be emptied synchronously on reject')
  await assert.rejects(p, { name: 'NoPath' })
  assert.equal(bot.pathfinder.goal, null)
})

test('createSafeGoto ignores partial empty path instead of false-resolving or leaking ghost goal', async () => {
  const bot = mockBot([0.5, 64, 0.5])
  const goal = new goals.GoalBlock(10, 64, 0)
  let settled = false
  const p = bot.pathfinder.goto(goal).then(v => { settled = true; return v })
  bot.emit('path_update', { status: 'partial', path: [] })
  await new Promise(r => setTimeout(r, 25))
  assert.equal(settled, false, 'partial with empty path must NOT resolve early')
  assert.equal(bot.pathfinder.goal, goal)
  bot.entity.position.set(10.5, 64, 0.5)
  bot.emit('goal_reached', goal)
  const res = await p
  assert.deepEqual(res, { reached: true, partial: false })
  assert.equal(bot.pathfinder.goal, null)
})

test('createSafeGoto allowPartial walks partial path to completion and still rejects empty noPath', async () => {
  const bot = mockBot([0.5, 64, 0.5])
  const goal = new goals.GoalBlock(50, 64, 0)
  const p = bot.pathfinder.goto(goal, { allowPartial: true })
  bot.emit('path_update', { status: 'noPath', path: [new Vec3(5.5, 64, 0.5), new Vec3(10.5, 64, 0.5)] })
  bot.pathfinder._setMoving(true)
  bot.emit('physicsTick')
  bot.emit('physicsTick')
  bot.entity.position.set(10.5, 64, 0.5)
  bot.pathfinder._setMoving(false)
  bot.emit('physicsTick')
  const res = await p
  assert.deepEqual(res, { reached: false, partial: true, reason: 'noPath' })
  assert.equal(bot.pathfinder.goal, null)

  // Empty noPath still rejects even with allowPartial: true
  const p2 = bot.pathfinder.goto(goal, { allowPartial: true })
  bot.emit('path_update', { status: 'noPath', path: [] })
  await assert.rejects(p2, { name: 'NoPath' })
})

test('move_to range=0 does not skip from adjacent block, uses GoalBlock, and micro-aligns precisely', async () => {
  // Standing at x=99.6 (block 99), targeting block 100 with range=0.
  // Old goNear returned immediately because distance to corner (100,64,200) was 0.4 <= 0.5!
  const bot = mockBot([99.6, 64, 200.5])
  const seenGoals = []
  bot.pathfinder.goto = async goal => {
    seenGoals.push(goal)
    // Simulate pathfinder stopping 0.32 blocks short of center (100.5, 200.5)
    bot.entity.position.set(100.18, 64, 200.5)
    return { reached: true, partial: false }
  }
  // Simulate physics stepping along bot's yaw while forward is held
  const origSetControl = bot.setControlState
  let steerTimer = null
  bot.setControlState = (k, v) => {
    origSetControl(k, v)
    if (k === 'forward' && v && !steerTimer) {
      steerTimer = setInterval(() => {
        if (!bot.controlState.forward) return
        const lastLook = bot.lookCalls.at(-1)
        const step = bot.controlState.sneak ? 0.065 : 0.2
        bot.entity.position.x += -Math.sin(lastLook.yaw) * step
        bot.entity.position.z += -Math.cos(lastLook.yaw) * step
      }, 45)
    }
    if (k === 'forward' && !v && steerTimer) { clearInterval(steerTimer); steerTimer = null }
  }
  bot.clearControlStates = () => {
    for (const k of Object.keys(bot.controlState)) bot.controlState[k] = false
    if (steerTimer) { clearInterval(steerTimer); steerTimer = null }
  }

  const res = await api.move_to({ bot, alive: true }, { x: 100, y: 64, z: 200, range: 0 })
  assert.equal(seenGoals.length, 1)
  assert.ok(seenGoals[0] instanceof goals.GoalBlock, 'range=0 with y must use GoalBlock')
  assert.equal(seenGoals[0].x, 100)
  assert.equal(seenGoals[0].y, 64)
  assert.equal(seenGoals[0].z, 200)
  assert.ok(res.dist <= 0.15, `expected aligned dist <= 0.15, got ${res.dist}`)
  assert.equal(Math.floor(bot.entity.position.x), 100)
})

test('move_to entity_id defaults item to range 0.5, mob to range 2, and honors explicit small range', async () => {
  const bot = mockBot([0.5, 64, 0.5])
  bot.entities = {
    10: { id: 10, name: 'item', position: new Vec3(5.3, 64, 0.5) },
    20: { id: 20, name: 'villager', position: new Vec3(10.5, 64, 0.5) }
  }
  const seen = []
  bot.pathfinder.goto = async goal => {
    seen.push(goal)
    return { reached: true, partial: false }
  }
  // Disable real movement timer for this unit check
  bot.look = undefined

  await api.move_to({ bot, alive: true }, { entity_id: 10 })
  assert.ok(seen[0] instanceof goals.GoalBlock, 'dropped item without range should use exact block goal (range=0.5)')

  await api.move_to({ bot, alive: true }, { entity_id: 20 })
  assert.ok(seen[1] instanceof goals.GoalNear && seen[1].rangeSq === 4, 'mob without range should default to range=2')

  await api.move_to({ bot, alive: true }, { entity_id: 20, range: 0 })
  assert.ok(seen[2] instanceof goals.GoalBlock, 'explicit range=0 on entity_id must not be overridden to 2')

  await api.move_to({ bot, alive: true }, { entity_id: 20, range: 1 })
  assert.ok(seen[3] instanceof goals.GoalNear && seen[3].rangeSq === 1, 'explicit range=1 on entity_id must be honored')
})

test('move_to retries without parkour/sprint after 2 stuck resets and restores movements afterward', async () => {
  const bot = mockBot([0.5, 64, 0.5])
  let movUpdates = 0
  const origSetMov = bot.pathfinder.setMovements.bind(bot.pathfinder)
  bot.pathfinder.setMovements = m => { movUpdates++; origSetMov(m) }
  const seenWhileRunning = []
  const origGoto = bot.pathfinder.goto
  bot.pathfinder.goto = async (goal, opts) => {
    const p = origGoto(goal, opts)
    bot.emit('path_reset', 'stuck')
    bot.emit('path_reset', 'stuck')
    seenWhileRunning.push({ parkour: bot.pathfinder.movements.allowParkour, sprint: bot.pathfinder.movements.allowSprinting })
    bot.entity.position.set(10.5, 64, 0.5)
    bot.emit('goal_reached', goal)
    return p
  }

  const res = await api.move_to({ bot, alive: true }, { x: 10, y: 64, z: 0 })
  assert.equal(movUpdates, 1)
  assert.deepEqual(seenWhileRunning[0], { parkour: false, sprint: false })
  assert.equal(bot.pathfinder.movements.allowParkour, true, 'allowParkour should be restored after move_to')
  assert.equal(bot.pathfinder.movements.allowSprinting, true, 'allowSprinting should be restored after move_to')
  assert.equal(res.dist, 0)
})

test('move_to validates range/allow_partial and attaches target_solid / target_unloaded diagnostics', async () => {
  const bot = mockBot([0.5, 64, 0.5])
  await assert.rejects(api.move_to({ bot }, { x: 5, z: 0, range: -1 }), { code: 'bad_args' })
  await assert.rejects(api.move_to({ bot }, { x: 5, z: 0, allow_partial: 'yes' }), { code: 'bad_args' })
  await assert.rejects(api.move_to({ bot }, { x: 5, z: 0, timeout: 0 }), { code: 'bad_args' })

  // Solid target with range=0 -> error.extra.target_solid === true
  bot.blockAt = () => ({ name: 'stone', boundingBox: 'block' })
  const pSolid = api.move_to({ bot }, { x: 5, y: 64, z: 0, range: 0 })
  bot.emit('path_update', { status: 'noPath', path: [] })
  await assert.rejects(pSolid, err => err.code === 'path_not_found' && err.extra.target_solid === true && err.extra.dist_left > 4)

  // Unloaded chunk -> error.extra.target_unloaded === true
  bot.blockAt = () => null
  const pUnloaded = api.move_to({ bot }, { x: 500, y: 64, z: 0 })
  bot.emit('path_update', { status: 'noPath', path: [] })
  await assert.rejects(pUnloaded, err => err.code === 'path_not_found' && err.extra.target_unloaded === true)
})

test('createMovements avoids hazardous blocks like cactus, sweet_berry_bush, magma_block, and campfire', () => {
  const bot = mockBot()
  const m = createMovements(bot)
  for (const name of ['sweet_berry_bush', 'cactus', 'magma_block', 'campfire', 'soul_campfire', 'powder_snow']) {
    assert.ok(m.blocksToAvoid.has(mcData.blocksByName[name].id), `expected ${name} in blocksToAvoid`)
  }
  assert.equal(m.canDig, false)
  assert.equal(m.allow1by1towers, false)
  assert.deepEqual(m.scafoldingBlocks, [])
})
