module.exports = require('../index')

// supersede the callback-based factory function with a promise-producing one
// TODO: provide listeners for non-terminal connectError and setupError events
const createClient = module.exports.createClient
module.exports.createClient = function (options) {
  return new Promise((resolve, reject) => {
    const client = createClient(options)
      .once('error', reject)
      .once('connect', function (error) {
        if (error) {
          reject(error)
          return
        }

        resolve(client)
      })

    // TODO: take handlers for these events from options.handlers
    // should handlers be removed on success ?
    // client.on('connectTimeout') with no listener, these will be emitted as plain error events
    // client.on('connectRefused') with no listener, these will be emitted as plain error events
    // client.on('connectError') is not terminal in case of connection retries
    // client.on('setupError') is not terminal in case of connection retries
  })
}
