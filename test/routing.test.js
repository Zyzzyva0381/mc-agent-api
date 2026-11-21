'use strict'

const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { dispatch } = require('../src/dispatch')
const { api, Session, configure, ApiError } = require('../src/session')
const { DEFAULTS } = require('../src/config')
const web = require('../src/http')
const proxy = require('../src/readiness/proxy')
const rcon = require('../src/readiness/rcon')

const options = {
  server: 'first',
  rcon: { port: 25575 },
  backends: { second: { rcon: { port: 25576 } } }
}

test('routing faults reject logins before upstream auth and leave its rate budget intact', async t => {
  let tableAvailable = false
  const authenticate = t.mock.fn(async () => { throw new ApiError('invalid_credentials', 'test login') })
  web.configure({
    config: { ...DEFAULTS, http: { host: '127.0.0.2', port: 0, loginRateLimit: { maxGlobalPerMinute: 1 } } },
    authProvider: { authenticate },
    readRoutes: () => {
      if (!tableAvailable) throw new Error('fixture invalid table')
      return () => ({ server: 'first' })
    }
  })
  const server = web.start()
  t.after(() => new Promise(resolve => server.close(resolve)))
  await once(server, 'listening')
  const { port } = server.address()
  const login = body => fetch(`http://127.0.0.2:${port}/api/v1/auth/login`, { method: 'POST', body })
  assert.equal((await login('null')).status, 400)
  for (let i = 0; i < 2; i++) {
    const response = await login('{"username":"Fixture"}')
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error.code, 'routing_unavailable')
  }
  assert.equal(authenticate.mock.callCount(), 0)
  tableAvailable = true
  assert.equal((await login('{"username":"Fixture"}')).status, 401)
  assert.equal(authenticate.mock.callCount(), 1)
})

test('assignment snapshots use the selected role and reject broken or unknown targets', t => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-test-'))
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }))
  const file = path.join(baseDir, 'assignments.json')
  const readRoutes = proxy.prepare({
    ...options, assignments: { Agent_1: 'first' }, assignmentsFile: 'assignments.json'
  }, { baseDir })
  assert.throws(readRoutes, /ENOENT/)
  fs.writeFileSync(file, '{"aGenT_1":"second","__proto__":"second"}')
  const old = readRoutes()
  assert.equal(old('Agent_1').server, 'second')
  assert.equal(old('LoginAlias').server, 'first')
  assert.equal(old('__proto__').server, 'second')
  fs.writeFileSync(file, '{}')
  assert.equal(readRoutes()('Agent_1').server, 'first')
  assert.equal(old('Agent_1').server, 'second')
  for (const body of ['{', 'null', '[]', '{"Agent_1":"missing"}', '{"A":"first","a":"second"}']) {
    fs.writeFileSync(file, body)
    assert.throws(readRoutes)
  }
})

test('multi-backend configuration rejects missing or reused RCON endpoints', () => {
  assert.throws(() => proxy.prepare({ ...options, rcon: undefined }, {}), /Missing RCON/)
  assert.throws(() => proxy.prepare({ ...options, backends: { second: { rcon: { host: 'localhost', port: 25575 } } } }, {}), /distinct RCON/)
  assert.throws(() => proxy.prepare({ ...options, backends: { 'bad name': {} } }, {}), /Invalid readiness backend/)
})

test('stale presence from the previous backend cannot mark the new world ready', async t => {
  const polls = []
  t.mock.method(rcon, 'create', () => ({
    includesPlayer: () => new Promise((resolve, reject) => polls.push({ resolve, reject })),
    close () {}
  }))
  const session = {
    route: { server: 'second', rcon: options.backends.second.rcon },
    profile: { name: 'Agent_1' },
    log: t.mock.fn(),
    pushEvent: t.mock.fn(),
    onBackendUnconfirmed: t.mock.fn(),
    hardReconnect: t.mock.fn()
  }
  const client = new EventEmitter()
  client.state = 'play'
  const bot = Object.assign(new EventEmitter(), { entity: {}, _client: client, chat: t.mock.fn() })
  const readiness = proxy.create(session, options, {})
  t.after(() => readiness.destroy())
  const move = state => {
    const previous = client.state
    client.state = state
    client.emit('state', state, previous)
  }
  readiness.attach(bot)
  bot.emit('spawn')
  move('configuration')
  move('play')
  polls[0].resolve(true)
  await Promise.resolve()
  assert.equal(readiness.isReady(), false)
  polls[1].resolve(true)
  await Promise.resolve()
  assert.equal(readiness.isReady(), true)
  move('configuration')
  assert.equal(readiness.isReady(), false)
  assert.equal(session.onBackendUnconfirmed.mock.callCount(), 1)
  move('play')
  polls[2].reject(new Error('fixture offline'))
  await Promise.resolve()
  assert.equal(readiness.state(), 'backend_unavailable')
  assert.equal(session.hardReconnect.mock.callCount(), 0)
})

test('proxy gates world observations and lock-free gameplay, and filters wrong-world events', async () => {
  configure({
    config: {},
    createReadiness: () => ({
      guardsWorld: true, server: 'second', isReady: () => false, state: () => 'backend_unavailable'
    })
  })
  const s = new Session('token', 'alias', { name: 'Agent_1' }, {})
  s.bot = { entity: { position: { x: 999 } } }
  for (const endpoint of ['get_block', 'find_blocks', 'get_entities', 'inventory', 'advancements', 'look', 'posture', 'control', 'chat']) {
    const r = await dispatch(s, endpoint, {})
    assert.equal(r.body.error.code, 'backend_unavailable', endpoint)
  }
  assert.deepEqual(await api.status(s), { username: 'Agent_1', server: 'second', ready: false, readiness_state: 'backend_unavailable' })
  s.pushEvent('spawn', { pos: [999, 0, 0] })
  s.pushEvent('disconnected', { reason: 'fixture' })
  assert.deepEqual(s.events.map(event => event.type), ['disconnected'])
})

test('an old gameplay request stays interrupted after verification is restored', async () => {
  configure({ config: {}, createReadiness: () => ({ guardsWorld: true, isReady: () => true }) })
  const s = new Session('token', 'Agent_1', { name: 'Agent_1' }, {})
  let resume
  const waiting = new Promise(resolve => { resume = resolve })
  const action = s.withBackendAction(async () => {
    await waiting
    assert.equal(s.backendActionIsCurrent(), false)
    return 'late result'
  })
  s.onBackendUnconfirmed()
  resume()
  await assert.rejects(action, { code: 'interrupted', extra: { cause: 'server_changed' } })
  assert.equal(await s.withBackendAction(() => 'new action'), 'new action')
})

test('RCON reads a quoted player selector and ignores unrelated response IDs', async t => {
  function packet (id, type, body) {
    const data = Buffer.from(body)
    const msg = Buffer.alloc(data.length + 14)
    msg.writeInt32LE(data.length + 10, 0)
    msg.writeInt32LE(id, 4)
    msg.writeInt32LE(type, 8)
    data.copy(msg, 12)
    return msg
  }
  let command
  let replies = 0
  const server = net.createServer(socket => {
    let data = Buffer.alloc(0)
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk])
      while (data.length >= 4 && data.length >= data.readInt32LE(0) + 4) {
        const size = data.readInt32LE(0)
        const id = data.readInt32LE(4)
        const type = data.readInt32LE(8)
        const value = data.toString('utf8', 12, size + 2)
        data = data.subarray(size + 4)
        if (type === 3) { socket.write(packet(id, 2, '')); continue }
        command = value
        const good = packet(id, 0, replies++ ? 'Test failed' : 'Test passed. Count: 1')
        socket.write(Buffer.concat([packet(id + 999, 0, 'Test failed'), good.subarray(0, 7)]))
        socket.write(good.subarray(7))
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const connection = rcon.create({ host: '127.0.0.1', port: server.address().port, password: 'fixture' }, '')
  t.after(() => {
    connection.close()
    return new Promise(resolve => server.close(resolve))
  })
  assert.equal(await connection.includesPlayer('测试角色'), true)
  assert.equal(command, 'execute if entity @a[name="测试角色",limit=1]')
  assert.equal(await connection.includesPlayer('Missing'), false)
})
