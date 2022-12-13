'use strict'

const enqueue = require('./enqueue')
const flush = require('./flush')
const purge = require('./purge')

/**
 * Builds a request queue object and returns it.
 *
 * @param {object} [options]
 * @param {integer} [options.size] Maximum size of the request queue. Must be
 * a number greater than `0` if supplied. Default: `Infinity`.
 * @param {integer} [options.timeout] Time in milliseconds a queue has to
 * complete the requests it contains.
 *
 * @returns {object} A queue instance.
 */
module.exports = function requestQueueFactory (options) {
  options = Object.assign({}, options)

  return Object.assign({
    size: (options.size > 0) ? options.size : Infinity,
    timeout: (options.timeout > 0) ? options.timeout : 0,
    _queue: new Set(),
    _timer: null,
    _frozen: false
  }, {
    enqueue: enqueue,
    flush: flush,
    purge: purge,
    freeze () {
      this._frozen = true
    },
    thaw () {
      this._frozen = false
    }
  })
}
