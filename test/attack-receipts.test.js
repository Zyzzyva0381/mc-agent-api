'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { Vec3 } = require('vec3')
const { api } = require('../src/session')

function makeSession({ targetPos, blockAtCursor = () => null }) {
  let goalCalls = 0
  let attacks = 0
  const events = []
  const lookTargets = []
  const cursorDists = []
  const bot = {
    health: 18.4,
    heldItem: { name: 'iron_sword' },
    entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 },
    entities: {
      42: { id: 42, name: 'zombie', isValid: true, height: 1.95, position: targetPos },
    },
    inventory: { items: () => [{ name: 'iron_sword', count: 1 }] },
    equip: async () => {},
    lookAt: async (pos) => { lookTargets.push(pos.clone()) },
    attack: () => { attacks++ },
    blockAtCursor: (maxDist) => {
      cursorDists.push(maxDist)
      return blockAtCursor(maxDist, lookTargets[lookTargets.length - 1])
    },
    pathfinder: { setGoal: () => { goalCalls++ } },
  }
  const s = {
    bot,
    interruptedBy: null,
    pushEvent: (type, data) => events.push({ type, data }),
  }
  return { s, bot, getGoalCalls: () => goalCalls, getAttacks: () => attacks, events, lookTargets, cursorDists }
}

test('attack with chase=false and feedback=true stands ground, records hit_log, and emits attack_hit', async () => {
  const { s, getGoalCalls, getAttacks, events } = makeSession({ targetPos: new Vec3(1.8, 64, 0) })
  const res = await api.attack(s, { entity_id: 42, max_hits: 2, interval_ms: 50, chase: false, feedback: true })
  assert.equal(getGoalCalls(), 0)
  assert.equal(getAttacks(), 2)
  assert.equal(res.hits, 2)
  assert.equal(res.stop_reason, 'max_hits')
  assert.equal(res.hit_log.length, 2)
  assert.equal(res.hit_log[0].hit, 1)
  assert.equal(res.hit_log[0].entity_id, 42)
  assert.equal(res.hit_log[0].bot_hp, 18.4)
  assert.equal(events.filter(e => e.type === 'attack_hit').length, 2)
})

test('attack with chase=false respects timeout window and returns out_of_reach without pathfinding', async () => {
  const { s, getGoalCalls, getAttacks } = makeSession({ targetPos: new Vec3(6, 64, 0) })
  const res = await api.attack(s, { entity_id: 42, max_hits: 1, timeout: 120, chase: false })
  assert.equal(getGoalCalls(), 0)
  assert.equal(getAttacks(), 0)
  assert.equal(res.hits, 0)
  assert.equal(res.stop_reason, 'out_of_reach')
  assert.ok(res.ms >= 100 && res.ms < 1000)
})

test('attack with chase=false returns blocked_by_wall when solid block occludes target', async () => {
  const { s, getAttacks } = makeSession({
    targetPos: new Vec3(2.2, 64, 0),
    blockAtCursor: () => ({ name: 'stone', boundingBox: 'block', position: new Vec3(1, 65, 0), intersect: new Vec3(1.0, 65.62, 0) }),
  })
  const res = await api.attack(s, { entity_id: 42, max_hits: 1, chase: false })
  assert.equal(getAttacks(), 0)
  assert.equal(res.hits, 0)
  assert.equal(res.stop_reason, 'blocked_by_wall')
  assert.deepEqual(res.blocking_block, { name: 'stone', pos: [1, 65, 0] })
})

test('legacy attack call without chase/feedback preserves exact legacy response and GoalFollow behavior', async () => {
  const { s, getGoalCalls, getAttacks, events } = makeSession({ targetPos: new Vec3(1.8, 64, 0) })
  const res = await api.attack(s, { entity_id: 42, max_hits: 1, interval_ms: 50 })
  assert.equal(getGoalCalls(), 2) // setGoal(GoalFollow) + setGoal(null) in finally
  assert.equal(getAttacks(), 1)
  assert.equal(res.hits, 1)
  assert.equal(res.hit_log, undefined)
  assert.equal(res.stop_reason, undefined)
  assert.equal(events.filter(e => e.type === 'attack_hit').length, 0)
})

test('attack falls back to 0.5-height ray when 0.8-height ray is occluded and aligns aim/distance', async () => {
  const targetPos = new Vec3(2.2, 64, 0)
  const eye = new Vec3(0, 65.62, 0)
  const { s, getAttacks, lookTargets, cursorDists } = makeSession({
    targetPos,
    blockAtCursor: (_maxDist, aim) => {
      // Only block the upper (0.8 * height) ray, leaving mid (0.5 * height) clear
      if (aim && aim.y > 65.3) {
        return { name: 'stone_slab', boundingBox: 'block', position: new Vec3(1, 65, 0), intersect: new Vec3(1.0, 65.58, 0) }
      }
      return null
    },
  })
  const res = await api.attack(s, { entity_id: 42, max_hits: 1, interval_ms: 50, chase: false, feedback: true })
  assert.equal(getAttacks(), 1)
  assert.equal(res.hits, 1)
  assert.equal(res.stop_reason, 'max_hits')
  assert.equal(res.hit_log[0].occluded, undefined)
  assert.equal(lookTargets.length, 2)
  assert.equal(cursorDists.length, 2)
  assert.ok(Math.abs(cursorDists[0] - eye.distanceTo(lookTargets[0])) < 1e-6)
  assert.ok(Math.abs(cursorDists[1] - eye.distanceTo(lookTargets[1])) < 1e-6)
})

test('attack with chase=true and feedback=true keeps GoalFollow and records occluded swing receipts', async () => {
  const { s, getGoalCalls, getAttacks, events } = makeSession({
    targetPos: new Vec3(2.2, 64, 0),
    blockAtCursor: () => ({ name: 'stone', boundingBox: 'block', position: new Vec3(1, 65, 0), intersect: new Vec3(1.0, 65.62, 0) }),
  })
  const res = await api.attack(s, { entity_id: 42, max_hits: 1, interval_ms: 50, chase: true, feedback: true })
  assert.equal(getGoalCalls(), 2)
  assert.equal(getAttacks(), 1)
  assert.equal(res.hits, 1)
  assert.equal(res.stop_reason, 'max_hits')
  assert.equal(res.hit_log.length, 1)
  assert.equal(res.hit_log[0].occluded, true)
  assert.equal(events.filter(e => e.type === 'attack_hit').length, 1)
  assert.equal(events[0].data.occluded, true)
})

test('attack rejects invalid chase, feedback, and timeout arguments with bad_args', async () => {
  const { s } = makeSession({ targetPos: new Vec3(1.8, 64, 0) })
  await assert.rejects(
    () => api.attack(s, { entity_id: 42, chase: 'false' }),
    err => err && err.code === 'bad_args',
  )
  await assert.rejects(
    () => api.attack(s, { entity_id: 42, feedback: 1 }),
    err => err && err.code === 'bad_args',
  )
  await assert.rejects(
    () => api.attack(s, { entity_id: 42, chase: false, timeout: 10 }),
    err => err && err.code === 'bad_args',
  )
  await assert.rejects(
    () => api.attack(s, { entity_id: 42, chase: false, timeout: 99999 }),
    err => err && err.code === 'bad_args',
  )
  await assert.rejects(
    () => api.attack(s, { entity_id: 42, chase: false, timeout: Number.NaN }),
    err => err && err.code === 'bad_args',
  )
  await assert.rejects(
    () => api.attack(s, { entity_id: 42, chase: false, timeout: '500' }),
    err => err && err.code === 'bad_args',
  )
  await assert.rejects(
    () => api.attack(s, { entity_id: 42, chase: false, timeout: null }),
    err => err && err.code === 'bad_args',
  )
})

test('attack does not falsely flag a wall behind the target hitbox as occluded', async () => {
  // Target stands at x=2.0 (AABB x in [1.7, 2.3]); wall behind target is at x=2.5
  const { s, getAttacks } = makeSession({
    targetPos: new Vec3(2.0, 64, 0),
    blockAtCursor: () => ({ name: 'stone', boundingBox: 'block', position: new Vec3(2, 65, 0), intersect: new Vec3(2.5, 65.58, 0) }),
  })
  const res = await api.attack(s, { entity_id: 42, max_hits: 1, interval_ms: 50, chase: false, feedback: true })
  assert.equal(getAttacks(), 1)
  assert.equal(res.hits, 1)
  assert.equal(res.stop_reason, 'max_hits')
  assert.equal(res.hit_log[0].occluded, undefined)
})

test('attack stops cleanly without phantom swing if target vanishes during lookAt', async () => {
  const { s, bot, getAttacks, events } = makeSession({ targetPos: new Vec3(1.8, 64, 0) })
  bot.lookAt = async () => { delete bot.entities[42] }
  const res = await api.attack(s, { entity_id: 42, max_hits: 1, chase: false, feedback: true })
  assert.equal(getAttacks(), 0)
  assert.equal(res.hits, 0)
  assert.equal(res.killed, true)
  assert.equal(res.stop_reason, 'killed')
  assert.equal(res.hit_log.length, 0)
  assert.equal(events.filter(e => e.type === 'attack_hit').length, 0)
})

function makeWeaponSession({ items, heldItem = null, targetPos = new Vec3(1.8, 64, 0) }) {
  const equipCalls = []
  const swungWith = []
  const events = []
  const bot = {
    health: 20,
    heldItem,
    entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 },
    entities: {
      42: { id: 42, name: 'zombie', isValid: true, height: 1.95, position: targetPos },
    },
    inventory: { items: () => items },
    equip: async (item) => {
      equipCalls.push(item)
      bot.heldItem = item
    },
    lookAt: async () => {},
    attack: () => { swungWith.push(bot.heldItem ? { name: bot.heldItem.name, slot: bot.heldItem.slot } : null) },
    blockAtCursor: () => null,
    pathfinder: { setGoal: () => {} },
  }
  const s = {
    bot,
    interruptedBy: null,
    pushEvent: (type, data) => events.push({ type, data }),
  }
  return { s, bot, equipCalls, swungWith, events }
}

test('attack auto weapon selection keeps diamond_sword over earlier-slot stone_sword in both chase modes and reports weapon', async () => {
  for (const chase of [false, true]) {
    const stone = { name: 'stone_sword', slot: 14, count: 1 }
    const diamond = { name: 'diamond_sword', slot: 37, count: 1 }
    const iron = { name: 'iron_sword', slot: 41, count: 1 }
    const { s, equipCalls, swungWith, events } = makeWeaponSession({
      items: [stone, diamond, iron],
      heldItem: diamond,
    })
    const res = await api.attack(s, { entity_id: 42, max_hits: 1, interval_ms: 50, chase, feedback: true })
    assert.equal(equipCalls.length, 0, `should not re-equip when best diamond_sword is already held (chase=${chase})`)
    assert.deepEqual(swungWith, [{ name: 'diamond_sword', slot: 37 }])
    assert.equal(res.weapon, 'diamond_sword')
    assert.equal(res.hit_log[0].weapon, 'diamond_sword')
    assert.equal(events[0].data.weapon, 'diamond_sword')
  }
})

test('attack auto tie-breaker preserves currently held equal-DPS sword instead of overwriting with earlier slot', async () => {
  const plainEarly = { name: 'diamond_sword', slot: 14, count: 1, maxDurability: 1561, durabilityUsed: 0 }
  const lootingHeld = { name: 'diamond_sword', slot: 37, count: 1, enchants: [{ name: 'looting', lvl: 3 }], maxDurability: 1561, durabilityUsed: 50 }
  const { s, equipCalls, swungWith } = makeWeaponSession({
    items: [plainEarly, lootingHeld],
    heldItem: lootingHeld,
  })
  const res = await api.attack(s, { entity_id: 42, max_hits: 1, interval_ms: 50, chase: false })
  assert.equal(equipCalls.length, 0)
  assert.deepEqual(swungWith, [{ name: 'diamond_sword', slot: 37 }])
  assert.equal(res.weapon, 'diamond_sword')

  // When holding empty hand, equal-DPS candidates prefer combat enchants then higher remaining durability
  const lowDur = { name: 'diamond_sword', slot: 10, count: 1, maxDurability: 1561, durabilityUsed: 1500 }
  const highDur = { name: 'diamond_sword', slot: 20, count: 1, maxDurability: 1561, durabilityUsed: 10 }
  const emptyHand = makeWeaponSession({ items: [lowDur, highDur], heldItem: null })
  await api.attack(emptyHand.s, { entity_id: 42, max_hits: 1, interval_ms: 50, chase: false })
  assert.deepEqual(emptyHand.swungWith, [{ name: 'diamond_sword', slot: 20 }])

  const withEnch = makeWeaponSession({ items: [plainEarly, lootingHeld], heldItem: null })
  await api.attack(withEnch.s, { entity_id: 42, max_hits: 1, interval_ms: 50, chase: false })
  assert.deepEqual(withEnch.swungWith, [{ name: 'diamond_sword', slot: 37 }])
})

test('attack with weapon=hand preserves equipped axe or bare hand without calling equip', async () => {
  const sword = { name: 'netherite_sword', slot: 14, count: 1 }
  const axe = { name: 'diamond_axe', slot: 37, count: 1 }
  const heldAxe = makeWeaponSession({ items: [sword, axe], heldItem: axe })
  const resAxe = await api.attack(heldAxe.s, { entity_id: 42, max_hits: 1, chase: false, feedback: true, weapon: 'hand' })
  assert.equal(heldAxe.equipCalls.length, 0)
  assert.deepEqual(heldAxe.swungWith, [{ name: 'diamond_axe', slot: 37 }])
  assert.equal(resAxe.weapon, 'diamond_axe')
  assert.equal(resAxe.interval_ms, 1000)
  assert.equal(resAxe.hit_log[0].weapon, 'diamond_axe')

  const bareHand = makeWeaponSession({ items: [sword], heldItem: null })
  const resBare = await api.attack(bareHand.s, { entity_id: 42, max_hits: 1, chase: false, feedback: true, weapon: 'hand' })
  assert.equal(bareHand.equipCalls.length, 0)
  assert.deepEqual(bareHand.swungWith, [null])
  assert.equal(resBare.weapon, null)
  assert.equal(resBare.interval_ms, 250)
  assert.equal(resBare.hit_log[0].weapon, null)
})

test('attack with explicit weapon name equips requested weapon and rejects missing or invalid weapon', async () => {
  const sword = { name: 'diamond_sword', slot: 14, count: 1 }
  const axe = { name: 'diamond_axe', slot: 36, count: 1 }
  const trident = { name: 'trident', slot: 38, count: 1 }
  const { s, equipCalls, swungWith } = makeWeaponSession({ items: [sword, axe, trident], heldItem: sword })

  const res = await api.attack(s, { entity_id: 42, max_hits: 1, chase: false, weapon: 'diamond_axe' })
  assert.equal(equipCalls.length, 1)
  assert.equal(equipCalls[0].name, 'diamond_axe')
  assert.deepEqual(swungWith, [{ name: 'diamond_axe', slot: 36 }])
  assert.equal(res.weapon, 'diamond_axe')
  assert.equal(res.interval_ms, 1000)

  const resTri = await api.attack(s, { entity_id: 42, max_hits: 1, chase: true, weapon: 'trident' })
  assert.equal(resTri.weapon, 'trident')
  assert.equal(resTri.interval_ms, 909)

  await assert.rejects(
    () => api.attack(s, { entity_id: 42, max_hits: 1, chase: false, weapon: 'netherite_axe' }),
    err => err && err.code === 'missing_item',
  )
  for (const bad of ['', '   ', 123, null, true]) {
    await assert.rejects(
      () => api.attack(s, { entity_id: 42, max_hits: 1, chase: false, weapon: bad }),
      err => err && err.code === 'bad_args',
    )
  }
})

test('attack with weapon=auto upgrades from held stone_sword to diamond_sword in inventory', async () => {
  const stone = { name: 'stone_sword', slot: 37, count: 1 }
  const diamond = { name: 'diamond_sword', slot: 14, count: 1 }
  const { s, equipCalls, swungWith } = makeWeaponSession({ items: [diamond, stone], heldItem: stone })
  const res = await api.attack(s, { entity_id: 42, max_hits: 1, interval_ms: 50, chase: false, weapon: 'auto' })
  assert.equal(equipCalls.length, 1)
  assert.deepEqual(swungWith, [{ name: 'diamond_sword', slot: 14 }])
  assert.equal(res.weapon, 'diamond_sword')
})
