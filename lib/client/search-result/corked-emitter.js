'use strict'

const EventEmitter = require('events').EventEmitter
const util = require('util')

/**
 * A CorkedEmitter is a variant of an EventEmitter where events emitted
 *  wait for the appearance of the first listener of any kind. That is,
 *  a CorkedEmitter will store all .emit()s it receives, to be replayed
 *  later when an .on() is applied.
 * It is meant for situations where the consumers of the emitter are
 *  unable to register listeners right away, and cannot afford to miss
 *  any events emitted from the start.
 * Note that, whenever the first emitter (for any event) appears,
 *  the emitter becomes uncorked and works as usual for ALL events, and
 *  will not cache anything anymore. This is necessary to avoid
 *  re-ordering emits - either everything is being buffered, or nothing.
 */
function CorkedEmitter () {
  EventEmitter.call(this)

  // a queue of bound emitter functions
  this.eventQueue = []

  // queue is not flushed synchronously, so that many event listeners can be added
  this.once('newListener', function () {
    const self = this
    setImmediate(function emitOneEvent () {
      self.eventQueue.shift()()
      if (!self.eventQueue.length) {
        self.eventQueue = false
        return
      }

      setImmediate(emitOneEvent)
    })
  })
}
util.inherits(CorkedEmitter, EventEmitter)

CorkedEmitter.prototype.emit = function corkedEmit (eventName, ...args) {
  if (this.eventQueue && eventName !== 'newListener') {
    this.eventQueue.push(EventEmitter.prototype.emit.bind(this, eventName, ...args))
    return
  }

  EventEmitter.prototype.emit.call(this, eventName, ...args)
}

module.exports = CorkedEmitter
