'use strict'
// 直连单个服务器：出生即就绪，断线即失效。
function create (session) {
  let ready = false
  return {
    attach (bot) {
      ready = false
      bot.once('spawn', () => {
        ready = true
        session.pushEvent('server_confirmed', { via: 'spawn' })
      })
    },
    isReady () { return ready },
    onEnd () { ready = false }
  }
}

module.exports = { create }
