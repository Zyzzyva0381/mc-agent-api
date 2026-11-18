'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')
const { create } = require('../src/auth/yggdrasil')

const first = { id: '11111111111111111111111111111111', name: 'Agent_1' }
const second = { id: 'abcdef0123456789abcdef0123456789', name: 'Agent_2' }

async function authServer (t, response, refresh = {}) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    calls.push({ path: req.url, body })
    const result = req.url.endsWith('/refresh')
      ? { accessToken: 'bound-token', clientToken: body.clientToken, selectedProfile: second, ...refresh }
      : { accessToken: 'initial-token', clientToken: body.clientToken, ...response }
    res.writeHead(result.error ? 403 : 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}`
  return { provider: create({ authServer: base + '/authserver/', sessionServer: base + '/sessionserver' }), calls }
}

const credentials = { username: 'account', password: 'secret' }

test('default selection and single-profile fallback remain compatible', async t => {
  for (const response of [{ selectedProfile: first }, { availableProfiles: [first] }]) {
    const { provider, calls } = await authServer(t, response)
    const result = await provider.authenticate(credentials)
    assert.deepEqual(result.profile, first)
    assert.equal(result.botOptions.session.accessToken, 'initial-token')
    assert.equal(calls.length, 1)
    assert.match(calls[0].body.clientToken, /^[0-9a-f-]{36}$/)
    assert.equal(result.botOptions.session.clientToken, calls[0].body.clientToken)
  }
})

test('an already selected name or UUID does not refresh', async t => {
  for (const profile of [second.name, second.id, 'ABCDEF01-2345-6789-ABCD-EF0123456789']) {
    const { provider, calls } = await authServer(t, { selectedProfile: second })
    const result = await provider.authenticate({ ...credentials, profile })
    assert.deepEqual(result.profile, second)
    assert.equal(result.botOptions.session.accessToken, 'initial-token')
    assert.equal(calls.length, 1)
  }
})

test('selecting another name or UUID binds the token through refresh', async t => {
  for (const profile of [second.name, second.id, 'ABCDEF01-2345-6789-ABCD-EF0123456789']) {
    for (const selectedProfile of [first, null]) {
      const { provider, calls } = await authServer(t, { selectedProfile, availableProfiles: [first, second] })
      const result = await provider.authenticate({ ...credentials, profile })
      assert.deepEqual(calls.map(c => c.path), ['/authserver/authenticate', '/authserver/refresh'])
      assert.deepEqual(calls[1].body, {
        accessToken: 'initial-token', clientToken: calls[0].body.clientToken,
        selectedProfile: second, requestUser: true
      })
      assert.deepEqual(result.botOptions.session, {
        accessToken: 'bound-token', clientToken: calls[0].body.clientToken, selectedProfile: second
      })
      assert.deepEqual(result.profile, second)
      assert.equal(result.botOptions.username, second.name)
    }
  }
})

test('ambiguous, absent, and unavailable profiles fail without refreshing', async t => {
  for (const response of [{}, { availableProfiles: [] }, { availableProfiles: [first, second] }]) {
    const { provider, calls } = await authServer(t, response)
    await assert.rejects(provider.authenticate(credentials), { code: 'no_profile' })
    assert.equal(calls.length, 1)
  }
  const { provider, calls } = await authServer(t, { selectedProfile: first, availableProfiles: [first, second] })
  await assert.rejects(provider.authenticate({ ...credentials, profile: 'Missing' }), { code: 'no_profile' })
  assert.equal(calls.length, 1)
})

test('refresh errors and invalid bindings never return a session', async t => {
  for (const [refresh, code] of [
    [{ error: 'ForbiddenOperationException', errorMessage: 'invalid token' }, 'invalid_credentials'],
    [{ error: 'ForbiddenOperationException', errorMessage: 'too many requests' }, 'rate_limited'],
    [{ selectedProfile: first }, 'auth_error'],
    [{ selectedProfile: null }, 'auth_error'],
    [{ accessToken: null }, 'auth_error'],
    [{ clientToken: 'different-client' }, 'auth_error']
  ]) {
    const { provider } = await authServer(t, { availableProfiles: [first, second] }, refresh)
    await assert.rejects(provider.authenticate({ ...credentials, profile: second.name }), { code })
  }
})

test('each authentication generates a distinct client token', async t => {
  const { provider, calls } = await authServer(t, { selectedProfile: first })
  await provider.authenticate(credentials)
  await provider.authenticate(credentials)
  assert.notEqual(calls[0].body.clientToken, calls[1].body.clientToken)
})

test('HTTP validates and forwards profile, keeps distinct roles, replaces only the same role', async t => {
  // Isolate bot spawning; exercise the real HTTP routes and offline adapter.
  const botprocPath = require.resolve('../src/botproc')
  const original = require.cache[botprocPath]
  const bots = []
  class FakeBot {
    constructor (opts) { Object.assign(this, opts); this.createdAt = Date.now(); bots.push(this) }
    destroy () { this.destroyed = true }
  }
  require.cache[botprocPath] = { id: botprocPath, filename: botprocPath, loaded: true, exports: { BotProcess: FakeBot } }
  t.after(() => { if (original) require.cache[botprocPath] = original; else delete require.cache[botprocPath] })
  const api = require('../src/http')
  const forwarded = []
  const offline = require('../src/auth/offline').create({ password: 'secret' })
  api.configure({
    config: { http: { host: '127.0.0.2', port: 0 }, session: { tokenTtlHours: 1 } },
    authProvider: { async authenticate (args) {
      forwarded.push(args)
      return offline.authenticate({ ...args, username: args.profile || args.username })
    } }
  })
  const server = api.start()
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const url = `http://127.0.0.2:${server.address().port}/api/v1`
  async function login (profile) {
    return fetch(url + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...credentials, profile })
    })
  }
  for (const invalid of [null, '', '  ', 42, false, {}, []]) {
    const res = await login(invalid)
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.code, 'bad_args')
  }
  assert.equal(forwarded.length, 0)
  const a = await (await login(first.name)).json()
  const b = await (await login(second.name)).json()
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.deepEqual(forwarded[0], { ...credentials, profile: first.name })
  assert.equal(bots[0].destroyed, undefined)
  await login(first.name)
  assert.equal(bots[0].destroyed, true)
  assert.equal(bots[1].destroyed, undefined)
  const old = await fetch(url + '/status', { headers: { Authorization: `Bearer ${a.token}` } })
  assert.equal((await old.json()).error.code, 'invalid_token')
  assert.equal((await (await login(undefined)).json()).ok, true)
  assert.equal(forwarded.at(-1).profile, undefined)
  const offlineResult = await offline.authenticate({ username: first.name, password: 'secret', profile: second.name })
  assert.equal(offlineResult.profile.name, first.name)
})
