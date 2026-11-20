'use strict'

const fs = require('fs')
const path = require('path')
const rcon = require('./rcon')

const SERVER_NAME = /^[A-Za-z0-9_.-]+$/
const POLL_MS = 3000
const SWITCH_INTERVAL_MS = 8000
const MAX_SAMPLE_AGE_MS = 8000

function isRecord (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function rconOptions (value, label) {
  if (!isRecord(value)) throw new Error(label + ' must be an RCON object')
  const { host = '127.0.0.1', port = 25575, password, passwordFile } = value
  if (typeof host !== 'string' || !host.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(label + ' needs a host and a port in 1..65535')
  }
  for (const [key, setting] of Object.entries({ password, passwordFile })) {
    if (setting !== undefined && (typeof setting !== 'string' || !setting.trim())) throw new Error(label + '.' + key + ' must be a non-empty string')
  }
  return { host, port, password, passwordFile }
}

function prepare (opts, config) {
  const { server, backends = {}, assignments = {}, assignmentsFile } = opts
  if (typeof server !== 'string' || !SERVER_NAME.test(server)) throw new Error('readiness.proxy needs a valid default server name')
  if (!isRecord(backends)) throw new Error('readiness.backends must be an object')
  const multi = Object.keys(backends).some(name => name !== server)
  const routes = new Map()
  const endpoints = new Set()
  for (const name of new Set([server, ...Object.keys(backends)])) {
    if (!SERVER_NAME.test(name)) throw new Error('Invalid readiness backend name: ' + name)
    const entry = Object.hasOwn(backends, name) ? backends[name] : {}
    if (!isRecord(entry)) throw new Error('readiness.backends.' + name + ' must be an object')
    const rawRcon = entry.rcon ?? (name === server ? opts.rcon : undefined)
    if (multi && rawRcon === undefined) throw new Error('Missing RCON for backend ' + name)
    const rcon = rawRcon === undefined ? null : rconOptions(rawRcon, 'RCON for ' + name)
    if (rcon) {
      const host = rcon.host.toLowerCase().replace(/^localhost$/, '127.0.0.1')
      const endpoint = host + ':' + rcon.port
      if (endpoints.has(endpoint)) throw new Error('Backends must have distinct RCON endpoints')
      endpoints.add(endpoint)
    }
    routes.set(name, { server: name, rcon })
  }

  function parse (table, label) {
    if (!isRecord(table)) throw new Error(label + ' must be a JSON object')
    const result = new Map()
    for (const [name, target] of Object.entries(table)) {
      if (!name.trim() || /\p{Cc}/u.test(name) || !routes.has(target)) throw new Error('Invalid player or target in ' + label + ': ' + JSON.stringify(name))
      const key = name.toLowerCase()
      if (result.has(key)) throw new Error('Duplicate player name in ' + label + ': ' + JSON.stringify(name))
      result.set(key, routes.get(target))
    }
    return result
  }

  const inline = parse(assignments, 'readiness.assignments')
  let file
  if (assignmentsFile !== undefined) {
    if (typeof assignmentsFile !== 'string' || !assignmentsFile.trim()) throw new Error('readiness.assignmentsFile must be a non-empty path')
    file = path.resolve(config.baseDir, assignmentsFile)
  }

  return () => {
    const fromFile = file ? parse(JSON.parse(fs.readFileSync(file, 'utf8')), 'assignmentsFile') : new Map()
    return name => fromFile.get(name.toLowerCase()) ?? inline.get(name.toLowerCase()) ?? routes.get(server)
  }
}

function create (session, opts, config) {
  const { server, rcon: rconConfig } = session.route ?? prepare(opts, config)()(session.profile.name)
  const probe = rconConfig ? rcon.create(rconConfig, config.baseDir) : null
  let bot = null
  let interval = null
  let epoch = 0
  let polling = false
  let lastProbeAt = 0
  let lastSample = 0
  let sample = null
  let bootstrapSent = false
  let legacyConfirmed = false
  let attempts = 0
  let lastSwitchAt = 0
  let phase = 'connecting'

  function suspend (next) {
    const wasConfirmed = phase === 'confirmed'
    phase = next
    if (wasConfirmed) session.onBackendUnconfirmed()
  }

  function reset (next) {
    epoch++
    polling = false
    lastProbeAt = 0
    lastSample = 0
    sample = null
    legacyConfirmed = false
    suspend(next)
    probe?.close()
  }

  function confirm (via) {
    if (phase === 'confirmed') return
    phase = 'confirmed'
    attempts = 0
    session.log('GUARD confirmed', server, 'via', via)
    session.pushEvent('server_confirmed', { server, via })
    session.onBackendConfirmed?.()
  }

  function ready () {
    if (phase === 'confirmed' && probe && Date.now() - lastSample > MAX_SAMPLE_AGE_MS) suspend('backend_unavailable')
    return phase === 'confirmed'
  }

  function switchServer () {
    if (!bot?.entity || bot._client.state !== 'play' || ready()) return false
    // A failed RCON check provides no evidence that another switch is warranted.
    if (probe && (sample !== false || Date.now() - lastSample > MAX_SAMPLE_AGE_MS) && bootstrapSent) return false
    const now = Date.now()
    if (now - lastSwitchAt < SWITCH_INTERVAL_MS) return false
    if (attempts >= 3) {
      session.hardReconnect('server switch not taking effect')
      return false
    }
    if (!probe || sample === false) attempts++
    bootstrapSent = true
    lastSwitchAt = now
    session.log('GUARD sending /server', server)
    try { bot.chat('/server ' + server) } catch (error) { session.log('GUARD chat failed', error.message); return false }
    return true
  }

  async function check () {
    if (!bot?.entity || bot._client.state !== 'play') return
    if (!probe) {
      if (!legacyConfirmed) switchServer()
      return
    }
    if (polling) return
    if (Date.now() - lastProbeAt < POLL_MS) return
    const current = epoch
    polling = true
    lastProbeAt = Date.now()
    try {
      const present = await probe.includesPlayer(bot.username || session.profile.name)
      if (epoch !== current) return
      sample = present
      lastSample = Date.now()
      if (present) confirm('rcon')
      else {
        suspend('switching')
        switchServer()
      }
    } catch (error) {
      if (epoch !== current) return
      if (phase !== 'backend_unavailable') session.log('GUARD backend verification unavailable', server, error.message)
      sample = null
      suspend('backend_unavailable')
      switchServer()
    } finally {
      if (epoch === current) polling = false
    }
  }

  function onEnd () {
    if (interval) clearInterval(interval)
    interval = null
    reset('connecting')
    bot = null
  }

  return {
    server,
    guardsWorld: true,
    attach (attached) {
      onEnd()
      bot = attached
      bootstrapSent = false
      attempts = 0
      lastSwitchAt = 0
      attached._client.on('state', (state, previous) => {
        if (bot !== attached) return
        if (previous === 'play' && state !== 'play') reset('switching')
        if (state === 'play') void check()
      })
      attached.on('spawn', check)
      interval = setInterval(check, POLL_MS)
      interval.unref()
    },
    isReady: ready,
    state () { ready(); return phase },
    onAdvancements (packet) {
      if (probe) return
      const size = session.advancementDefinitions.size
      if (size >= (opts.minAdvancements || 20)) {
        legacyConfirmed = true
        confirm('advancements')
      } else if (packet.reset && size <= 5) {
        legacyConfirmed = false
        suspend('switching')
      }
    },
    onConnectWhileNotReady () {
      const sent = switchServer()
      void check()
      return { resent_server_switch: sent }
    },
    onEnd,
    destroy: onEnd
  }
}

module.exports = { create, prepare }
