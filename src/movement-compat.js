'use strict'

const TO_RADIANS = Math.PI / 180
// Match Vanilla Shapes.EPSILON (1.0E-7) in prismarine-physics AABB collision checks.
// Without it, IEEE-754 rounding at wall faces (e.g. (4 + 0.3) - 0.3 < 4) makes computeOffsetY
// treat an adjacent vertical wall as a floor (mid-air wall-clinging float) and lets computeOffsetX/Z
// clip straight through walls.
const COLLISION_EPSILON = 1e-7
const EFFECT_GRACE_MIN_TICKS = 40 // 2 s minimum buffer for server TPS lag / packet jitter
const EFFECT_GRACE_MAX_TICKS = 200 // 10 s cap so stuck effects still clear promptly if remove_entity_effect is lost

function installEffectLifecycle(bot) {
  const tracked = new WeakMap()

  const clearOwnEffects = () => {
    const effects = bot.entity?.effects
    if (!effects) return
    for (const id of Object.keys(effects)) delete effects[id]
  }

  // Vanilla ClientPacketListener.handleRespawn always creates a fresh LocalPlayer with empty
  // activeEffects; for dimension changes the server immediately re-sends entity_effect packets.
  // Mineflayer only resets bot.entity on login, never on respawn, so a missed remove_entity_effect
  // across death/respawn (e.g. Levitation) would otherwise stick forever.
  bot.on('respawn', clearOwnEffects)
  bot._client?.on('state', state => { if (state !== 'play') clearOwnEffects() })

  // Mineflayer stores effect.duration once from entity_effect and never ticks it down.
  // Decrement finite effects (duration >= 0; -1 means infinite in 1.19.4+) on physicsTick so
  // /status reports remaining duration accurately and stuck effects expire after a TPS-safe grace
  // window if remove_entity_effect is ever missed.
  bot.on('physicsTick', () => {
    const entity = bot.entity
    const effects = entity?.effects
    if (!effects) return
    for (const key of Object.keys(effects)) {
      const eff = effects[key]
      if (!eff || !Number.isFinite(eff.duration) || eff.duration < 0) continue
      let meta = tracked.get(eff)
      if (!meta) {
        const graceTicks = Math.min(EFFECT_GRACE_MAX_TICKS, Math.max(EFFECT_GRACE_MIN_TICKS, Math.ceil(eff.duration * 0.25)))
        meta = { graceTicks, overdueTicks: 0 }
        tracked.set(eff, meta)
      }
      if (eff.duration > 0) {
        eff.duration--
      } else if (++meta.overdueTicks >= meta.graceTicks) {
        delete effects[key]
        bot.emit('entityEffectEnd', entity, eff)
      }
    }
  })
}

function installCollisionEpsilon() {
  const AABB = require('prismarine-physics/lib/aabb')
  if (AABB.prototype._mcAgentCollisionEpsilonInstalled) return
  const eps = COLLISION_EPSILON
  AABB.prototype.computeOffsetX = function (other, offsetX) {
    if (other.maxY > this.minY + eps && other.minY < this.maxY - eps &&
        other.maxZ > this.minZ + eps && other.minZ < this.maxZ - eps) {
      if (offsetX > 0.0 && other.maxX <= this.minX + eps) {
        offsetX = Math.max(0.0, Math.min(this.minX - other.maxX, offsetX))
      } else if (offsetX < 0.0 && other.minX >= this.maxX - eps) {
        offsetX = Math.min(0.0, Math.max(this.maxX - other.minX, offsetX))
      }
    }
    return offsetX
  }
  AABB.prototype.computeOffsetY = function (other, offsetY) {
    if (other.maxX > this.minX + eps && other.minX < this.maxX - eps &&
        other.maxZ > this.minZ + eps && other.minZ < this.maxZ - eps) {
      if (offsetY > 0.0 && other.maxY <= this.minY + eps) {
        offsetY = Math.max(0.0, Math.min(this.minY - other.maxY, offsetY))
      } else if (offsetY < 0.0 && other.minY >= this.maxY - eps) {
        offsetY = Math.min(0.0, Math.max(this.maxY - other.minY, offsetY))
      }
    }
    return offsetY
  }
  AABB.prototype.computeOffsetZ = function (other, offsetZ) {
    if (other.maxX > this.minX + eps && other.minX < this.maxX - eps &&
        other.maxY > this.minY + eps && other.minY < this.maxY - eps) {
      if (offsetZ > 0.0 && other.maxZ <= this.minZ + eps) {
        offsetZ = Math.max(0.0, Math.min(this.minZ - other.maxZ, offsetZ))
      } else if (offsetZ < 0.0 && other.minZ >= this.maxZ - eps) {
        offsetZ = Math.min(0.0, Math.max(this.maxZ - other.minZ, offsetZ))
      }
    }
    return offsetZ
  }
  AABB.prototype._mcAgentCollisionEpsilonInstalled = true
}

function installFishingPull(bot, bobber) {
  const hookedIndex = bobber?.metadataKeys?.indexOf('hooked_entity') ?? -1
  if (hookedIndex < 0) return

  const client = bot._client
  const owners = new Map()
  client.on('spawn_entity', packet => {
    if (packet.type === bobber.internalId) owners.set(packet.entityId, packet.objectData)
  })
  client.on('entity_destroy', ({ entityIds }) => {
    for (const id of entityIds) owners.delete(id)
  })
  for (const event of ['login', 'respawn']) bot.on(event, () => owners.clear())
  client.on('state', state => { if (state !== 'play') owners.clear() })

  client.on('entity_status', ({ entityId, entityStatus }) => {
    if (entityStatus !== 31 || !owners.has(entityId) || !bot.entity) return
    const hook = bot.entities[entityId]
    const owner = bot.entities[owners.get(entityId)]
    if (hook?.name !== bobber.name || hook.metadata?.[hookedIndex] !== bot.entity.id + 1 || !owner?.position) return

    // Vanilla applies this impulse on the client of the hooked player.
    const pull = owner.position.minus(hook.position).scaled(0.1)
    bot.entity.velocity.translate(pull.x, pull.y, pull.z)
  })
}

function teleportVelocity(entity, packet) {
  const { flags } = packet
  let { x, y, z } = entity.velocity
  if (flags.yawDelta) {
    // Convert Mineflayer angles to the protocol convention and rotate pitch before yaw.
    const oldYaw = Math.PI - entity.yaw
    const oldPitch = -entity.pitch
    const yaw = (flags.yaw ? oldYaw : 0) + packet.yaw * TO_RADIANS
    const pitch = (flags.pitch ? oldPitch : 0) + packet.pitch * TO_RADIANS
    const pitchDelta = oldPitch - Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch))
    const yawDelta = oldYaw - yaw
    const adjustedY = y * Math.cos(pitchDelta) + z * Math.sin(pitchDelta)
    const adjustedZ = z * Math.cos(pitchDelta) - y * Math.sin(pitchDelta)
    z = adjustedZ * Math.cos(yawDelta) - x * Math.sin(yawDelta)
    x = x * Math.cos(yawDelta) + adjustedZ * Math.sin(yawDelta)
    y = adjustedY
  }

  return [
    packet.dx + (flags.dx ? x : 0),
    packet.dy + (flags.dy ? y : 0),
    packet.dz + (flags.dz ? z : 0)
  ]
}

function installTeleportVelocity(bot) {
  const client = bot._client
  const velocities = new WeakMap()
  // The built-in handler handles position and acknowledgement, but overwrites velocity.
  client.prependListener('position', packet => {
    const entity = bot.entity
    if (!entity?.velocity || !Number.isInteger(packet.teleportId) || packet.teleportId < 0 ||
        !packet.flags || typeof packet.flags !== 'object' ||
        ![packet.dx, packet.dy, packet.dz].every(Number.isFinite)) return
    velocities.set(packet, { entity, velocity: teleportVelocity(entity, packet) })
  })
  client.on('position', packet => {
    const saved = velocities.get(packet)
    velocities.delete(packet)
    if (saved && saved.entity === bot.entity) saved.entity.velocity.set(...saved.velocity)
  })
}

function installMovementCompatibility(bot) {
  installCollisionEpsilon()
  installEffectLifecycle(bot)
  const data = require('minecraft-data')(bot.version)
  if (!data) return
  installFishingPull(bot, data.entitiesByName.fishing_bobber)
  const positionFields = data.protocol.play.toClient.types.packet_position?.[1]
  if (positionFields?.some(field => field.name === 'dx')) installTeleportVelocity(bot)
}

module.exports = { installMovementCompatibility, installCollisionEpsilon, installEffectLifecycle }
