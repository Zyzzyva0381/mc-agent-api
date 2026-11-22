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
})
