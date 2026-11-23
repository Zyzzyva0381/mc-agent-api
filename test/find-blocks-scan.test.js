const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const mcData = require('minecraft-data')('1.21.11')
const Chunk = require('prismarine-chunk')('1.21.11')
const Block = require('prismarine-block')('1.21.11')
const { api, scanExposed } = require('../src/session')

function makeWorld(columns, pos) {
  const getColumn = (cx, cz) => columns.get(`${cx},${cz}`) || null
  const bot = {
    game: { minY: -64, height: 384 },
    entity: { position: new Vec3(pos[0], pos[1], pos[2]) },
    world: { getColumn },
    blockAt(p) {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
      if (y < -64 || y >= 320) return null
      const col = getColumn(x >> 4, z >> 4)
      if (!col) return null
      const sid = col.getBlockStateId({ x: x & 15, y, z: z & 15 })
      const b = Block.fromStateId(sid, 0)
      b.position = new Vec3(x, y, z)
      return b
    }
  }
  return { bot, mcData }
}

function setBlock(columns, x, y, z, stateId) {
  const cx = x >> 4, cz = z >> 4
  const key = `${cx},${cz}`
  let col = columns.get(key)
  if (!col) {
    col = new Chunk({ minY: -64, worldHeight: 384 })
    columns.set(key, col)
  }
  col.setBlockStateId(new Vec3(x & 15, y, z & 15), stateId)
}

function referenceScan(s, radius, want, max) {
  const bot = s.bot
  const me = bot.entity.position
  const minY = bot.game.minY, maxY = bot.game.minY + bot.game.height - 1
  const see = new Uint8Array(Math.max(...s.mcData.blocksArray.map(b => b.maxStateId)) + 1)
  for (const b of s.mcData.blocksArray) if (b.boundingBox === 'empty' || b.transparent) see.fill(1, b.minStateId, b.maxStateId + 1)
  const sid = (x, y, z) => {
    if (y < minY || y > maxY) return -1
    const c = bot.world.getColumn(x >> 4, z >> 4)
    if (!c) return -1
    return c.getBlockStateId({ x: x & 15, y, z: z & 15 })
  }
  const open = (x, y, z) => { const v = sid(x, y, z); return v >= 0 && see[v] === 1 }
  const out = []
  const r = Math.ceil(radius) + 1
  const cx = Math.floor(me.x), cy = Math.floor(me.y), cz = Math.floor(me.z)
  for (let x = cx - r; x <= cx + r; x++) {
    for (let z = cz - r; z <= cz + r; z++) {
      const dxz = (x - me.x) ** 2 + (z - me.z) ** 2
      if (dxz > radius * radius) continue
      for (let y = Math.max(cy - r, minY); y <= Math.min(cy + r, maxY); y++) {
        const d2 = dxz + (y - me.y) ** 2
        if (d2 > radius * radius) continue
        const v = sid(x, y, z)
        if (v < 0 || !want(v)) continue
        if (open(x + 1, y, z) || open(x - 1, y, z) || open(x, y + 1, z) || open(x, y - 1, z) || open(x, y, z + 1) || open(x, y, z - 1)) {
          out.push([x, y, z, Math.sqrt(d2), v])
        }
      }
    }
  }
  out.sort((a, b) => a[3] - b[3])
  return out.slice(0, max)
}

test('find_blocks with types supports radius up to 128 on negative coords and clamps >128', async () => {
  const columns = new Map()
  const cane = mcData.blocksByName.sugar_cane.defaultState
  const stone = mcData.blocksByName.stone.defaultState
  // Spawn-like negative coordinates, sugar cane at ~79.3 and ~120 blocks away, plus one beyond 128
  setBlock(columns, -12216, 80, -12232, cane) // dist ~79.3
  setBlock(columns, -12160, 80, -12279, cane) // dist ~119.5
  setBlock(columns, -12140, 80, -12279, cane) // dist ~139.5 (> 128)
  // Buried sugar cane completely enclosed by stone should not be returned
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        setBlock(columns, -12270 + dx, 70 + dy, -12270 + dz, stone)
      }
    }
  }
  setBlock(columns, -12270, 70, -12270, cane)

  const session = makeWorld(columns, [-12279.5, 80, -12279.5])

  const r64 = await api.find_blocks(session, { types: ['sugar_cane'], radius: 64 })
  assert.equal(r64.total, 0)

  const r128 = await api.find_blocks(session, { types: ['sugar_cane'], radius: 128 })
  assert.equal(r128.total, 2)
  assert.deepEqual(r128.blocks.map(b => b.pos), [[-12216, 80, -12232], [-12160, 80, -12279]])

  const r200 = await api.find_blocks(session, { types: ['sugar_cane'], radius: 200 })
  assert.equal(r200.total, 2, 'radius > 128 should clamp to 128')

  // Summary mode remains capped at 64
  const summary = await api.find_blocks(session, { radius: 128 })
  assert.equal(summary.radius, 64)
  assert.equal(summary.blocks.sugar_cane, undefined)

  // Validation errors
  await assert.rejects(() => api.find_blocks(session, { types: 'sugar_cane' }), err => err.code === 'bad_args')
  await assert.rejects(() => api.find_blocks(session, { types: ['sugar_cane'], radius: 0 }), err => err.code === 'bad_args')
})

test('scanExposed matches brute-force scan across single, indirect, direct, and legacy chunks', async () => {
  const columns = new Map()
  const stone = mcData.blocksByName.stone.defaultState
  const glass = mcData.blocksByName.glass.defaultState
  const gold = mcData.blocksByName.gold_block.defaultState
  const diamond = mcData.blocksByName.diamond_ore.defaultState

  // 1) Chunk (0, 0): section y=0..15 is SingleValueContainer(stone), section y=16..31 is SingleValueContainer(glass)
  const col0 = new Chunk({ minY: -64, worldHeight: 384 })
  const stoneSecIdx = (0 - (-64)) >> 4
  const glassSecIdx = (16 - (-64)) >> 4
  col0.sections[stoneSecIdx] = new Chunk.section({ noSizePrefix: true, singleValue: stone, maxBitsPerBlock: col0.maxBitsPerBlock })
  col0.sections[glassSecIdx] = new Chunk.section({ noSizePrefix: true, singleValue: glass, maxBitsPerBlock: col0.maxBitsPerBlock })
  // Indirect section at y=32..47 with a few gold blocks
  col0.setBlockStateId(new Vec3(3, 35, 4), gold)
  col0.setBlockStateId(new Vec3(15, 32, 0), diamond)
  columns.set('0,0', col0)

  // 2) Chunk (-1, 0): DirectPaletteContainer (>256 distinct block states in section y=0..15)
  const colDirect = new Chunk({ minY: -64, worldHeight: 384 })
  let placed = 0
  for (let ly = 0; ly < 16 && placed < 300; ly++) {
    for (let lz = 0; lz < 16 && placed < 300; lz++) {
      for (let lx = 0; lx < 16 && placed < 300; lx++) {
        const b = mcData.blocksArray[placed % mcData.blocksArray.length]
        colDirect.setBlockStateId(new Vec3(lx, ly, lz), b.defaultState)
        placed++
      }
    }
  }
  colDirect.setBlockStateId(new Vec3(14, 15, 14), gold)
  assert.equal(colDirect.sections[stoneSecIdx].data.palette, undefined, 'section should have promoted to DirectPaletteContainer')
  columns.set('-1,0', colDirect)

  // 3) Chunk (1, 0): Legacy non-sectioned chunk fallback
  const legacyMap = new Map()
  legacyMap.set('2,10,2', gold)
  legacyMap.set('2,11,2', diamond)
  columns.set('1,0', {
    getBlockStateId(p) { return legacyMap.get(`${p.x},${p.y},${p.z}`) || 0 }
  })

  const session = makeWorld(columns, [2.3, 14.7, 3.8])

  // Test 1: sparse target across indirect + direct + legacy chunks
  const wantSparse = v => v === gold || v === diamond
  const gotSparse = await scanExposed(session, 24, wantSparse, 100)
  const refSparse = referenceScan(session, 24, wantSparse, 100)
  assert.deepEqual(gotSparse.map(x => [x[0], x[1], x[2], x[4]]), refSparse.map(x => [x[0], x[1], x[2], x[4]]))

  // Test 2: SingleValueContainer solid stone (interior skipped, faces exposed to air/glass/direct) with cutoff2
  const wantStone = v => v === stone
  const gotStone = await scanExposed(session, 20, wantStone, 50)
  const refStone = referenceScan(session, 20, wantStone, 50)
  assert.equal(gotStone.length, refStone.length)
  // All returned distances should match the exact top-50 distances
  assert.deepEqual(gotStone.map(x => +x[3].toFixed(6)), refStone.map(x => +x[3].toFixed(6)))

  // Test 3: SingleValueContainer transparent glass (interior blocks ARE exposed because glass is transparent)
  const wantGlass = v => v === glass
  const gotGlass = await scanExposed(session, 10, wantGlass, 40)
  const refGlass = referenceScan(session, 10, wantGlass, 40)
  assert.equal(gotGlass.length, refGlass.length)
  assert.deepEqual(gotGlass.map(x => +x[3].toFixed(6)), refGlass.map(x => +x[3].toFixed(6)))
})

test('scanExposed radius=128 over 17x17 chunks is fast for sparse and dense queries', async () => {
  const columns = new Map()
  const stone = mcData.blocksByName.stone.defaultState
  const grass = mcData.blocksByName.grass_block.defaultState
  const dirt = mcData.blocksByName.dirt.defaultState
  const cane = mcData.blocksByName.sugar_cane.defaultState

  // Build 17x17 loaded chunks (view-distance=8) with realistic underground stone + surface + 2 sparse cane patches
  for (let cx = -8; cx <= 8; cx++) {
    for (let cz = -8; cz <= 8; cz++) {
      const col = new Chunk({ minY: -64, worldHeight: 384 })
      for (let si = 0; si < 8; si++) {
        col.sections[si] = new Chunk.section({ noSizePrefix: true, singleValue: stone, maxBitsPerBlock: col.maxBitsPerBlock })
      }
      // Surface section y=64..79 with grass + dirt (IndirectPaletteContainer)
      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
          col.setBlockStateId(new Vec3(lx, 64, lz), dirt)
          col.setBlockStateId(new Vec3(lx, 65, lz), grass)
        }
      }
      columns.set(`${cx},${cz}`, col)
    }
  }
  setBlock(columns, 80, 66, 12, cane)
  setBlock(columns, -110, 66, -20, cane)

  const session = makeWorld(columns, [0.5, 66, 0.5])

  const tSparse = Date.now()
  const sparse = await api.find_blocks(session, { types: ['sugar_cane'], radius: 128 })
  const sparseMs = Date.now() - tSparse
  assert.equal(sparse.total, 2)
  assert.ok(sparseMs < 200, `expected sparse radius=128 scan < 200ms, got ${sparseMs}ms`)

  const tDense = Date.now()
  const dense = await api.find_blocks(session, { types: ['grass_block'], radius: 128, limit: 20 })
  const denseMs = Date.now() - tDense
  assert.equal(dense.blocks.length, 20)
  assert.ok(denseMs < 500, `expected dense radius=128 scan with cutoff2 < 500ms, got ${denseMs}ms`)
})
