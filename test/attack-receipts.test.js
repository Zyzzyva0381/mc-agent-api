'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { Vec3 } = require('vec3')
const { api } = require('../src/session')

function makeSession({ targetPos, blockAtCursor = () => null }) {
  let goalCalls = 0
  let attacks = 0
  const events = []
  const bot = {
    health: 18.4,
    heldItem: { name: 'iron_sword' },
    entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 },
    entities: {
      42: { id: 42, name: 'zombie', isValid: true, height: 1.95, position: targetPos },
    },
    inventory: { items: () => [{ name: 'iron_sword', count: 1 }] },
    equip: async () => {},
    lookAt: async () => {},
    attack: () => { attacks++ },
    blockAtCursor,
    pathfinder: { setGoal: () => { goalCalls++ } },
  }
  const s = {
    bot,
    interruptedBy: null,
    pushEvent: (type, data) => events.push({ type, data }),
  }
  return { s, bot, getGoalCalls: () => goalCalls, getAttacks: () => attacks, events }
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
