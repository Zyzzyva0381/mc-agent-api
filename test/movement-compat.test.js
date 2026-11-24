'use strict'

const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const { test } = require('node:test')
const protocol = require('minecraft-protocol')
const registry = require('prismarine-registry')
const injectPhysics = require('mineflayer/lib/plugins/physics')
const { Vec3 } = require('vec3')
const { Physics } = require('prismarine-physics')
const { installMovementCompatibility, installCollisionEpsilon } = require('../src/movement-compat')
const { hasLocalPhysicsChunks } = require('../src/session')

function fixture(version = '1.21.11') {
  const data = registry(version)
  return Object.assign(new EventEmitter(), {
    version,
    registry: data,
    supportFeature: data.supportFeature,
    _client: Object.assign(new EventEmitter(), { write() {} }),
    entity: { id: 10, position: new Vec3(0, 64, 0), velocity: new Vec3(0.2, 0.1, 0.3), yaw: Math.PI, pitch: 0 },
    entities: {}
  })
}

test('a fishing reel pulls only the hooked local player toward the owner', () => {
  const bot = fixture()
  const client = bot._client
  const bobber = bot.registry.entitiesByName.fishing_bobber
  const index = bobber.metadataKeys.indexOf('hooked_entity')
  const hook = { name: bobber.name, position: new Vec3(1, 65, 0), metadata: { [index]: bot.entity.id + 2 } }
  bot.entities[11] = hook
  bot.entities[12] = { position: new Vec3(6, 64, -3) }
  installMovementCompatibility(bot)

  const spawn = { type: bobber.id, entityId: 11, objectData: 12 }
  const reel = () => client.emit('entity_status', { entityId: 11, entityStatus: 31 })
  client.emit('spawn_entity', spawn)
  reel()
  assert.deepEqual(bot.entity.velocity.toArray(), [0.2, 0.1, 0.3])
  hook.metadata[index] = bot.entity.id + 1
  reel()
  for (const [axis, expected] of Object.entries({ x: 0.7, y: 0, z: 0 })) {
    assert.ok(Math.abs(bot.entity.velocity[axis] - expected) < 1e-9)
  }

  const velocity = bot.entity.velocity.toArray()
  client.emit('entity_destroy', { entityIds: [11] })
  reel()
  client.emit('spawn_entity', spawn)
  bot.emit('respawn')
  reel()
  client.emit('spawn_entity', spawn)
  client.emit('state', 'configuration')
  reel()
  assert.deepEqual(bot.entity.velocity.toArray(), velocity)
})

test('a decoded 1.21.11 position packet applies independent velocity flags', async () => {
  const bot = fixture()
  injectPhysics(bot, {})
  installMovementCompatibility(bot)

  const packet = { teleportId: 3, x: 5, y: 0, z: 6, dx: 0.5, dy: 0, dz: 0.7, yaw: 0, pitch: 0, flags: { y: true, dx: true } }
  const serializer = protocol.createSerializer({ state: 'play', version: bot.version, isServer: true })
  const deserializer = protocol.createDeserializer({ state: 'play', version: bot.version, isServer: false })
  const decoded = once(deserializer, 'data')
  serializer.pipe(deserializer)
  serializer.end({ name: 'position', params: packet })
  const [{ data }] = await decoded
  bot._client.emit(data.name, data.params)
  assert.deepEqual(bot.entity.position.toArray(), [5, 64, 6])
  assert.deepEqual(bot.entity.velocity.toArray(), [0.7, 0, 0.7])

  bot._client.emit('position', {
    ...packet, teleportId: -1, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0,
    flags: { x: true, y: true, z: true, yaw: true, pitch: true }
  })
  assert.deepEqual(bot.entity.velocity.toArray(), [0.7, 0, 0.7])
})

test('teleport can rotate the previous velocity before adding the new velocity', () => {
  const bot = fixture()
  bot.entity.velocity.set(0, 0, 1)
  injectPhysics(bot, {})
  installMovementCompatibility(bot)
  bot._client.emit('position', {
    teleportId: 1, x: 5, y: 64, z: 5, dx: 0.25, dy: 0, dz: 0, yaw: 90, pitch: 30,
    flags: { dx: true, dy: true, dz: true, yawDelta: true }
  })
  const { x, y, z } = bot.entity.velocity
  assert.ok(Math.abs(x - (0.25 - Math.sqrt(3) / 2)) < 1e-9)
  assert.ok(Math.abs(y + 0.5) < 1e-9)
  assert.ok(Math.abs(z) < 1e-9)
})

test('legacy teleport handling remains with Mineflayer', () => {
  const bot = fixture('1.20.4')
  injectPhysics(bot, {})
  installMovementCompatibility(bot)
  bot._client.emit('position', { teleportId: 5, x: 5, y: 64, z: 6, yaw: 0, pitch: 0, flags: 1 })
  assert.deepEqual(bot.entity.velocity.toArray(), [0.2, 0, 0])
})

test('collision epsilon prevents wall-clinging mid-air float and wall clipping across IEEE-754 boundaries', () => {
  installCollisionEpsilon()
  const mcData = require('minecraft-data')('1.21.11')
  const solid = { type: 1, position: null, shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block', metadata: 0 }
  const air = { type: 0, position: null, shapes: [], boundingBox: 'empty', metadata: 0 }

  // 1) Pushing into IEEE-754 boundary walls then removing floor must neither clip nor float
  for (const [dir, base] of [[-1, 1], [-1, 3], [-1, 31], [-1, 127], [1, -2], [1, -4], [1, -32], [1, -128]]) {
    const wallFace = dir === -1 ? base + 1 : base
    let hasFloor = true
    const world = {
      getBlock (pos) {
        const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z)
        if ((dir === -1 ? z <= base : z >= base) || y <= 63 || (hasFloor && y === 64)) return { ...solid, position: new Vec3(x, y, z) }
        return { ...air, position: new Vec3(x, y, z) }
      }
    }
    const phys = Physics(mcData, world)
    phys.playerHalfWidth = 0.3
    const e = {
      pos: new Vec3(10.5, 65.0, dir === -1 ? wallFace + 0.5 : wallFace - 0.5),
      vel: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false,
      isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false,
      jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, attributes: {},
      yaw: dir === -1 ? 0 : Math.PI, pitch: 0,
      control: { forward: true, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
      jumpBoost: 0, speed: 0, slowness: 0, dolphinsGrace: 0, slowFalling: 0, levitation: 0, depthStrider: 0, elytraEquipped: false
    }
    for (let t = 0; t < 15; t++) {
      phys.simulatePlayer(e, world)
      if (dir === -1) assert.ok(e.pos.z >= wallFace + 0.3 - 1e-6, `clipped -Z wall at base=${base}: z=${e.pos.z}`)
      else assert.ok(e.pos.z <= wallFace - 0.3 + 1e-6, `clipped +Z wall at base=${base}: z=${e.pos.z}`)
    }
    hasFloor = false
    e.control.forward = false
    for (let t = 0; t < 20; t++) phys.simulatePlayer(e, world)
    assert.equal(e.pos.y, 64, `floated against wall base=${base}: y=${e.pos.y}`)
    assert.equal(e.onGround, true)
  }

  // 2) Legitimate standing on a ledge edge (0.05-block overlap) must still hold
  const ledgeWorld = {
    getBlock (pos) {
      const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z)
      if ((z <= 99 && y === 64) || y <= 63) return { ...solid, position: new Vec3(x, y, z) }
      return { ...air, position: new Vec3(x, y, z) }
    }
  }
  const ledgePhys = Physics(mcData, ledgeWorld)
  ledgePhys.playerHalfWidth = 0.3
  const ledgeEntity = {
    pos: new Vec3(10.5, 65.0, 100.25), vel: new Vec3(0, 0, 0), onGround: true,
    isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false,
    isCollidedVertically: false, elytraFlying: false, jumpTicks: 0, jumpQueued: false,
    fireworkRocketDuration: 0, attributes: {}, yaw: 0, pitch: 0,
    control: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
    jumpBoost: 0, speed: 0, slowness: 0, dolphinsGrace: 0, slowFalling: 0, levitation: 0, depthStrider: 0, elytraEquipped: false
  }
  for (let t = 0; t < 20; t++) ledgePhys.simulatePlayer(ledgeEntity, ledgeWorld)
  assert.equal(ledgeEntity.pos.y, 65)
  assert.equal(ledgeEntity.onGround, true)
})

test('hasLocalPhysicsChunks checks only chunks under the player hitbox (including chunk borders)', () => {
  const loaded = new Set()
  const bot = {
    _client: { state: 'play' },
    physics: { playerHalfWidth: 0.3 },
    entity: { position: new Vec3(8.5, 80, 8.5) },
    world: { getColumn: (cx, cz) => loaded.has(`${cx},${cz}`) ? {} : null },
    blockAt: (pos) => loaded.has(`${Math.floor(pos.x) >> 4},${Math.floor(pos.z) >> 4}`) ? { type: 0 } : null
  }
  assert.equal(hasLocalPhysicsChunks(bot), false)
  loaded.add('0,0')
  assert.equal(hasLocalPhysicsChunks(bot), true)

  // Standing on chunk border x=15.9 requires both chunk (0,0) and (1,0)
  bot.entity.position = new Vec3(15.9, 80, 8.5)
  assert.equal(hasLocalPhysicsChunks(bot), false)
  loaded.add('1,0')
  assert.equal(hasLocalPhysicsChunks(bot), true)

  // Outside play state must return false
  bot._client.state = 'configuration'
  assert.equal(hasLocalPhysicsChunks(bot), false)
})
