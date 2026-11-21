'use strict'

const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { DEFAULTS, loadConfig } = require('../src/config')
const { ApiError, Session, api, configure } = require('../src/session')
const { dispatch } = require('../src/dispatch')
const web = require('../src/http')

function pathingBot() {
  return Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0) },
    game: { dimension: 'overworld' },
    pathfinder: { setGoal() {}, goto() { return Promise.resolve() } }
  })
}

test('chat bypasses the action lock without changing the running action or held keys', async t => {
  configure({ config: DEFAULTS, createReadiness: () => ({ guardsWorld: true, isReady: () => true }) })
  const s = new Session('token', 'ChatProbe', { name: 'ChatProbe' }, {})
  s.bot = { entity: { position: new Vec3(0, 64, 0) }, health: 20, chat: t.mock.fn() }
  s.worldReady = true
  const releaseHeld = t.mock.method(s, 'releaseHeld', () => assert.fail('chat released the held keys'))
  const posture = t.mock.method(s, 'applyPosture', () => {})
  let finish
  t.mock.method(api, 'control', () => new Promise(resolve => { finish = resolve }))

  const action = dispatch(s, 'control', { stop_on: ['hurt'] })
  const lock = s.busy
  const stopOn = s.activeStopOn
  assert.equal(lock.name, 'control')
  assert.equal((await dispatch(s, 'control', {})).body.error.code, 'busy')
  assert.deepEqual((await dispatch(s, 'chat', { message: 'Working' })).body.result, { sent: true })
  assert.equal((await dispatch(s, 'chat', { message: 'Still working' })).body.error.code, 'rate_limited')
  assert.equal(s.busy, lock)
  assert.equal(s.activeStopOn, stopOn)
  assert.equal(s.interruptedBy, null)
  assert.equal(posture.mock.callCount(), 0)
  finish({ controlled: true })
  assert.deepEqual((await action).body.result, { controlled: true })

  const held = { keys: ['sneak'] }
  s.heldControl = held
  s.lastChatAt = Date.now() - 1000
  s.bot.chat.mock.mockImplementation(() => assert.equal(s.busy, null))
  assert.equal((await dispatch(s, 'chat', { message: '/' })).body.error.code, 'bad_args')
  assert.deepEqual((await dispatch(s, 'chat', { message: 'Holding sneak' })).body.result, { sent: true })
  assert.equal(s.heldControl, held)
  assert.equal(releaseHeld.mock.callCount(), 0)
  assert.equal(posture.mock.callCount(), 1)
  s.alive = false
  assert.equal((await dispatch(s, 'chat', { message: 'Dead' })).body.error.code, 'dead')
  assert.equal(s.bot.chat.mock.callCount(), 2)
})

test('keep the teleport ID guard when the protocol packet table is unavailable', t => {
  const write = t.mock.fn()
  const client = Object.assign(new EventEmitter(), {
    state: 'play',
    write
  })
  const bot = Object.assign(new EventEmitter(), {
    version: 'unavailable-test-version', _client: client, loadPlugin() {}
  })
  t.mock.method(mineflayer, 'createBot', () => bot)
  configure({ config: DEFAULTS, createReadiness: () => ({ attach() {} }) })
  const session = new Session('test', 'PacketProbe', {}, {})
  session.connect()
  client.write('keep_alive', {})
  assert.equal(client.write('teleport_confirm', {}), false)
  assert.deepEqual(write.mock.calls.map(({ arguments: args }) => args[0]), ['keep_alive'])
  assert.equal(session.nearestHostile(24), null)
})

test('repeated deaths preserve the session and emit the usual death events', async t => {
  const client = Object.assign(new EventEmitter(), { state: 'play', write() {} })
  const bot = Object.assign(pathingBot(), {
    version: 'unavailable-test-version',
    _client: client,
    loadPlugin() {},
    quit: t.mock.fn()
  })
  t.mock.method(mineflayer, 'createBot', () => bot)
  configure({ config: DEFAULTS, createReadiness: () => ({ attach() {} }) })
  const session = new Session('test', 'DeathProbe', { name: 'DeathProbe' }, {})
  session.connect()
  for (let i = 0; i < 4; i++) {
    session.alive = true
    bot.emit('death')
    assert.equal(session.alive, false)
    assert.equal(session.bot, bot)
  }
  assert.equal(bot.quit.mock.callCount(), 0)
  assert.deepEqual(session.events.map(event => event.type), ['death', 'death', 'death', 'death'])
  session.bot = null
  assert.deepEqual(await api.connect(session), { ok: true, reconnect: true })
})

test('disconnect aborts pending pathfinding and cleans up the original bot', { timeout: 1000 }, async () => {
  for (const y of [undefined, 64]) {
    const bot = pathingBot()
    const replacement = pathingBot()
    const s = { bot }
    const cleared = []
    bot.pathfinder.setGoal = goal => cleared.push(goal)
    bot.pathfinder.goto = () => new Promise(() => {})
    replacement.pathfinder.setGoal = () => assert.fail('cleared the new bot goal')
    const moving = api.move_to(s, { x: 10, y, z: 0 })
    s.bot = replacement
    bot.emit('end')
    await assert.rejects(moving, { code: 'not_connected' })
    assert.deepEqual(cleared, [null])
    assert.equal(bot.listenerCount('end'), 0)
    assert.equal(bot.listenerCount('path_reset'), 0)
  }
})

test('move_to validates coordinates before calling pathfinder', async t => {
  const bot = pathingBot()
  const goto = t.mock.method(bot.pathfinder, 'goto')
  for (const args of [{ z: 0 }, { x: 1 }, { x: 0, z: '' }, { x: 0, y: 'bad', z: 0 }]) {
    await assert.rejects(api.move_to({ bot }, args), { code: 'bad_args' })
  }
  assert.equal(goto.mock.callCount(), 0)
  await api.move_to({ bot }, { x: '10', z: '0' })
  assert.equal(goto.mock.calls[0].arguments[0].x, 10)
})

test('attack does not hit or clear a replacement bot after disconnect during aiming', async t => {
  const bot = pathingBot()
  const replacement = pathingBot()
  const s = { bot }
  const target = { position: new Vec3(1, 64, 0), height: 2, isValid: true }
  bot.entities = { 1: target }
  bot.inventory = { items: () => [] }
  bot.lookAt = async () => { s.bot = replacement }
  bot.attack = t.mock.fn()
  const go = t.mock.method(bot.pathfinder, 'setGoal')
  const newGoal = t.mock.method(replacement.pathfinder, 'setGoal')
  await assert.rejects(api.attack(s, { entity_id: 1 }), { code: 'not_connected' })
  assert.equal(bot.attack.mock.callCount(), 0)
  assert.equal(go.mock.calls.at(-1).arguments[0], null)
  assert.equal(newGoal.mock.callCount(), 0)
})

test('login rate-limit config rejects zero instead of silently defaulting', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-api-config-'))
  const file = path.join(dir, 'config.json')
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir) })
  for (const key of Object.keys(DEFAULTS.http.loginRateLimit)) {
    fs.writeFileSync(file, JSON.stringify({ http: { loginRateLimit: { [key]: 0 } } }))
    assert.throws(() => loadConfig(file), new RegExp(key + ' must be a positive integer'))
  }
})

function login(port, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.2', port, path: '/api/v1/auth/login', method: 'POST', headers }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    for (const chunk of body) req.write(chunk)
    req.end()
  })
}

test('HTTP body limit covers declared and streamed sizes and preserves UTF-8', async t => {
  const authenticate = t.mock.fn(async () => { throw new ApiError('invalid_credentials', 'test login') })
  web.configure({
    config: {
      ...DEFAULTS,
      http: { host: '127.0.0.2', port: 0, loginRateLimit: { ...DEFAULTS.http.loginRateLimit, maxFailsPerIp: 1 } }
    },
    authProvider: { authenticate }
  })
  const server = web.start()
  t.after(() => new Promise(resolve => server.close(resolve)))
  await once(server, 'listening')
  const { port } = server.address()
  const limit = 1024 * 1024
  for (const headers of [{ 'Content-Length': limit + 1 }, { 'Transfer-Encoding': 'chunked' }]) {
    const result = await login(port, [Buffer.alloc(limit, 32), Buffer.from(' ')], headers)
    assert.equal(result.status, 413)
    assert.equal(result.body.error.code, 'body_too_large')
  }
  assert.equal(authenticate.mock.callCount(), 0)

  const boundary = Buffer.alloc(limit, 32)
  const json = Buffer.from('{"username":"玩家"}')
  json.copy(boundary)
  const split = json.indexOf(Buffer.from('玩')) + 1
  const response = await login(port, [boundary.subarray(0, split), boundary.subarray(split)], { 'Content-Length': limit })
  assert.equal(response.status, 401)
  assert.equal(authenticate.mock.calls[0].arguments[0].username, '玩家')
  const blocked = await login(port, [json], { 'Content-Length': json.length })
  assert.equal(blocked.status, 429)
})
