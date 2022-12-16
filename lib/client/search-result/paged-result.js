'use strict'

const EventEmitter = require('events').EventEmitter
const util = require('util')

const { PagedResultsControl } = require('@ldapjs/controls')

function PageResult (emitter, options, control, callback) {
  const self = this
  EventEmitter.call(this)

  // relay basic events
  this.on('error', emitter.emit.bind(emitter, 'error'))
  this.on('searchEntry', emitter.emit.bind(emitter, 'searchEntry'))
  this.on('searchReference', emitter.emit.bind(emitter, 'searchReference'))

  // handle end of page
  this.on('end', function (msg) {
    const pageControl = msg.controls.find(function (c) {
      return c.type === PagedResultsControl.OID
    })
    if (!pageControl) {
      // paged results not supported
      // server could have refused the search b/c of invalid control,
      //  or it could have ignored the control and sent all results
      emitter.emit('page', msg, options.pagePause && function () { })

      // send pageError and end events if subscribed, else send error only
      const err = new Error('paged search not supported by server')
      err.name = 'PagedResultsError'
      if (emitter.listeners('pageError').length > 0) {
        emitter.emit('pageError', err)
        emitter.emit('end', msg)
        return
      }

      emitter.emit('error', err)
      return
    }

    const cookie = pageControl.value.cookie
    if (!cookie.length) {
      emitter.emit('page', msg, options.pagePause && function () { })
      emitter.emit('end', msg)
      return
    }

    // response cookie may be available to caller through a provided mutable control
    control.value.cookie = cookie

    if (options.pagePause) {
      emitter.emit('page', msg, function resumeNextPage (stop) {
        if (stop) {
          emitter.emit('end', msg)
          return
        }

        // caller may have mutated control
        callback(self)
      })

      return
    }

    emitter.emit('page', msg)

    callback(self)
  })
}
util.inherits(PageResult, EventEmitter)

module.exports = PageResult
