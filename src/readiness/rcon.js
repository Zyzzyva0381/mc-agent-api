'use strict'

const fs = require('fs')
const net = require('net')
const path = require('path')

function packet (id, type, value) {
  const body = Buffer.from(value)
  const buffer = Buffer.alloc(14 + body.length)
  buffer.writeInt32LE(10 + body.length, 0)
  buffer.writeInt32LE(id, 4)
  buffer.writeInt32LE(type, 8)
  body.copy(buffer, 12)
  return buffer
}

function create (opts, baseDir) {
  let socket = null
  let pending = null
  let sequence = 0

  function close (error = new Error('RCON connection closed')) {
    const previous = socket
    socket = null
    previous?.destroy()
    if (!pending) return
    const { timer, reject } = pending
    pending = null
    clearTimeout(timer)
    reject(error)
  }

  function command (text) {
    if (pending) throw new Error('RCON command already pending')
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const wrapper = packet(id, 2, text)
      const timer = setTimeout(() => close(new Error('RCON command timed out')), 2500)
      pending = { id, timer, resolve, reject }
      if (socket) { socket.write(wrapper); return }

      let password
      try {
        password = opts.password || fs.readFileSync(path.resolve(baseDir, opts.passwordFile || '.rcon-pass'), 'utf8').trim()
        if (!password) throw new Error('RCON password is empty')
      } catch (error) { close(error); return }

      const authId = ++sequence
      const connection = net.createConnection({ host: opts.host, port: opts.port })
      socket = connection
      let authorized = false
      let buffer = Buffer.alloc(0)
      connection.on('connect', () => connection.write(packet(authId, 3, password)))
      connection.on('error', error => { if (socket === connection) close(error) })
      connection.on('close', () => { if (socket === connection) close() })
      connection.on('data', chunk => {
        if (socket !== connection) return
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 4 && socket === connection) {
          const size = buffer.readInt32LE(0)
          if (size < 10 || size > 65536) return close(new Error('Invalid RCON packet size'))
          if (buffer.length < size + 4) return
          const response = buffer.subarray(4, size + 4)
          buffer = buffer.subarray(size + 4)
          const replyId = response.readInt32LE(0)
          const type = response.readInt32LE(4)
          if (!authorized) {
            if (replyId === -1) return close(new Error('RCON authentication failed'))
            if (replyId === authId && type === 2) {
              authorized = true
              connection.write(wrapper)
            }
          } else if (pending && replyId === pending.id && type === 0) {
            const completed = pending
            pending = null
            clearTimeout(completed.timer)
            completed.resolve(response.toString('utf8', 8, response.length - 2))
          }
        }
      })
    })
  }

  async function includesPlayer (name) {
    if (/\p{Cc}/u.test(name)) throw new Error('Invalid control character in player name')
    const result = (await command(`execute if entity @a[name=${JSON.stringify(name)},limit=1]`)).replace(/§./g, '').trim()
    if (/^Test passed(?:[.!]|\. Count: 1)?$/i.test(result)) return true
    if (/^Test failed[.!]?$/i.test(result)) return false
    throw new Error('RCON replied with an unexpected player check result')
  }

  return { includesPlayer, close }
}

module.exports = { create }
