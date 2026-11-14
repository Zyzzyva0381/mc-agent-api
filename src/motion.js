'use strict'

const TICKS_PER_SECOND = 20
const round = n => +n.toFixed(3)

// Speed from the bot's actual per-tick displacement (blocks/second).
// mineflayer's entity.velocity is the value left for the *next* tick after
// friction/drag (on ground it is ~0.546 x the real walking speed, and it keeps
// a -0.078 b/t gravity term while standing), so it is not what the bot moved.
function createMotionTracker () {
  let prev = null
  let last = null
  return {
    tick (pos) {
      if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) { prev = null; last = null; return }
      if (prev) {
        const d = [pos.x - prev.x, pos.y - prev.y, pos.z - prev.z]
        // a teleport / respawn is not motion
        last = Math.hypot(d[0], d[1], d[2]) > 10 ? null : d
      }
      prev = { x: pos.x, y: pos.y, z: pos.z }
    },
    reset () { prev = null; last = null },
    summary () {
      if (!last) return { speed: null, velocity: null }
      const v = last.map(n => n * TICKS_PER_SECOND)
      return { speed: round(Math.hypot(v[0], v[2])), velocity: v.map(n => round(n) || 0) }
    }
  }
}

module.exports = { createMotionTracker }
