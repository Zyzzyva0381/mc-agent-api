'use strict'

const TICKS_PER_SECOND = 20
const round = n => +n.toFixed(3)

// Mineflayer exposes physics velocity in blocks/tick, not blocks/second.
function motionSummary (entity) {
  const v = entity.velocity
  if (!v || ![v.x, v.y, v.z].every(Number.isFinite)) return { speed: null, velocity: null }
  const velocity = [v.x, v.y, v.z].map(n => n * TICKS_PER_SECOND)
  return {
    speed: round(Math.hypot(velocity[0], velocity[2])),
    velocity: velocity.map(round)
  }
}

module.exports = { motionSummary }
