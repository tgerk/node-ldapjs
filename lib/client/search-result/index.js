'use strict'

const CorkedEmitter = require('./corked-emitter')
const PagedResult = require('./paged-result')
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
function SearchResult () {
  const self = this
  CorkedEmitter.call(self)
}
util.inherits(SearchResult, CorkedEmitter)

SearchResult.prototype.pagedResult = function (options, control, nextPage) {
  return new PagedResult(this, options, control, nextPage)
}

/*
 yield searchEntry values, optionally yield searchReferences as well
 with pagePause option, caller must to listen for 'page' events & use callback to resume

 the SearchResult object is proveded to caller on sending the search request to the server
 any iterator should be created before the first server response could be received, else the first
  page of results may be missed because the listener is applied too late
 this is practically the same as need to attach event listeners, so NBD
*/
SearchResult.prototype[Symbol.asyncIterator] = function () {
  return this.entries()
}

SearchResult.prototype.toArray = async function toArray (options) {
  const entries = []
  for await (const e of this.entries(options)) {
    entries.push(e)
  }

  return entries
}

SearchResult.prototype.entries = function entries (options) {
  const asyncEntriesIterator = getInjectableAsyncIterator()

  // CorkedEmitter buffers events from its construction until
  //  next tick after adding the first listener
  this
    .on('error', asyncEntriesIterator.inject.bind(asyncEntriesIterator))
    .on('end', asyncEntriesIterator.inject.bind(asyncEntriesIterator, true))
    .on('searchEntry', asyncEntriesIterator.inject.bind(asyncEntriesIterator, null))

  if (options.includeSearchReferences) {
    this.on('searchReference', asyncEntriesIterator.inject.bind(asyncEntriesIterator, null))
  }

  if (options.pagePause) {
    this.once('page', function (msg) {
      // caller must listen to page event to get the next-page callback
      // caller should get entries async generator again for each page
      this.removeAllListeners('error')
        .removeAllListeners('end')
        .removeAllListeners('searchEntry')
        .removeAllListeners('searchReference')
      asyncEntriesIterator.inject(true, msg)
    })
  }

  return asyncEntriesIterator
}

module.exports = SearchResult

/*
 * get an AsyncIterator having property-method for injecting values,
 *  e.g. from event listeners
 * the injector method utilizes callback-style params
 *  an error:  inject(err)
 *  a regular value:  inject(null, value)
 *  the final value:  inject(true, value) i.e. "err = done"
 * the construct "for await (const entry of iterator)"
 *  - can not access the final return value
 *  - must be in a try/catch to capture errors
 *  - errors do not pre-empt buffered values
 */
function getInjectableAsyncIterator () {
  function Deferred () {
    if (!(this instanceof Deferred)) {
      return new Deferred()
    }

    // the promise constructor function is called synchronously
    // assign our enumerable properties to the Promise
    return Object.assign(
      new Promise((resolve, reject) => {
        this.reject = reject
        this.resolve = resolve
      }),
      this
    )
  }

  // use a queue of promises to buffer the event stream
  return Object.assign(
    (async function * () {
      while (1) {
        // don't remove promise item from buffer until settled
        // generator will throw if promise rejected
        const next = await this.eventStream[0]

        this.eventStream.shift()
        if (this.eventStream.length) {
          yield next
        } else {
          // if there is no promises, "next" is the return value
          return next
        }
      }
    })(),
    {
      inject (err, val) {
        const tail = this.eventStream[this.eventStream.length - 1]
        if (val) {
          tail.resolve(val.value)
          if (!err) {
            this.eventStream.push(new Deferred())
          }
        } else if (err) {
          tail.reject(err)
        }
      },

      eventStream: [new Deferred()]
    }
  )
}
