'use strict'

const EventEmitter = require('events').EventEmitter
const net = require('net')
const tls = require('tls')
const util = require('util')

const once = require('once')
const backoff = require('backoff')
const vasync = require('vasync')
const assert = require('assert-plus')
const VError = require('verror').VError

const Attribute = require('../attribute')
const Change = require('../change')
const Control = require('../controls/index').Control
const { Control: LdapControl, PagedResultsControl } = require('@ldapjs/controls')
const Protocol = require('@ldapjs/protocol')
const dn = require('../dn')
const errors = require('../errors')
const filters = require('@ldapjs/filter')
const messages = require('../messages')
const exops = require('../exops')
const url = require('../url')

const { MAX_MSGID } = require('./constants')
const requestQueueFactory = require('./request-queue')
const messageTrackerFactory = require('./message-tracker')
const SearchResult = require('./search-result')

/// --- Globals

const AbandonRequest = messages.AbandonRequest
const AddRequest = messages.AddRequest
const BindRequest = messages.BindRequest
const CompareRequest = messages.CompareRequest
const DeleteRequest = messages.DeleteRequest
const ExtendedRequest = messages.ExtendedRequest
const ModifyRequest = messages.ModifyRequest
const ModifyDNRequest = messages.ModifyDNRequest
const SearchRequest = messages.SearchRequest
const UnbindRequest = messages.UnbindRequest
const UnbindResponse = messages.UnbindResponse

const LDAPResult = messages.LDAPResult
const SearchEntry = messages.SearchEntry
const SearchReference = messages.SearchReference

const Parser = messages.Parser

const PresenceFilter = filters.PresenceFilter

const ConnectionError = errors.ConnectionError

function ConnectionTimeout (message) {
  errors.LDAPError.call(this, message, null, ConnectionTimeout)
}
util.inherits(ConnectionTimeout, errors.LDAPError)
module.exports.ConnectionTimeout = ConnectionTimeout
Object.defineProperties(ConnectionTimeout.prototype, {
  name: {
    get: function () {
      return 'ConnectionTimeout'
    },
    configurable: false
  }
})

// node 0.6 got rid of FDs, so make up a client id for logging
let CLIENT_ID = 0

/// --- Internal Helpers

function nextClientId () {
  if (++CLIENT_ID === MAX_MSGID) { return 1 }

  return CLIENT_ID
}

function validateControls (controls) {
  if (Array.isArray(controls)) {
    controls.forEach(function (c) {
      if (!(c instanceof Control) && !(c instanceof LdapControl)) {
        throw new TypeError('controls must be [Control]')
      }
    })

    return controls
  }

  if (!(controls instanceof Control) && !(controls instanceof LdapControl)) {
    throw new TypeError('controls must be [Control]')
  }

  return [controls]
}

function ensureDN (input, strict) {
  if (dn.DN.isDN(input)) {
    return dn
  } else if (strict) {
    return dn.parse(input)
  } else if (typeof (input) === 'string') {
    return input
  } else {
    throw new Error('invalid DN')
  }
}

// get a callable function, wrapping on optional result-transformer
//  but also appears to be an instance of Promise and has the Promise interface
function getPromiseCallback (transformer) {
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

  const d = new Deferred()
  return Object.setPrototypeOf(
    Object.defineProperties(
      function callback (err, res) {
        if (err) {
          d.reject(err)
          return
        }

        if (transformer) {
          d.resolve(transformer(res))
        } else if (res) {
          d.resolve(res)
        } else {
          d.resolve()
        }
      },
      {
        then: d.then.bind(d),
        catch: d.catch.bind(d),
        finally: d.finally.bind(d)
      }
    ),
    Promise.prototype // spoof instanceof
  )
}

/// --- API

/**
 * Constructs a new client.
 *
 * The options object is required, and must contain either a URL (string) or
 * a socketPath (string); the socketPath is only if you want to talk to an LDAP
 * server over a Unix Domain Socket.  Additionally, you can pass in a bunyan
 * option that is the result of `new Logger()`, presumably after you've
 * configured it.
 *
 * @param {Object} options must have either url or socketPath.
 * @throws {TypeError} on bad input.
 */
function Client (options) {
  assert.ok(options)

  EventEmitter.call(this, options)

  this.urls = options.url ? [].concat(options.url).map(url.parse) : []
  this._nextServer = 0

  this.host = undefined
  this.port = undefined
  this.secure = undefined
  this.url = undefined

  this.tlsOptions = options.tlsOptions
  this.socketPath = options.socketPath || false

  this.log = options.log.child({ clazz: 'Client' }, true)

  this.timeout = parseInt((options.timeout || 0), 10)
  this.connectTimeout = parseInt((options.connectTimeout || 0), 10)
  this.idleTimeout = parseInt((options.idleTimeout || 0), 10)
  if (options.reconnect) {
    // Fall back to defaults if options.reconnect === true
    const rOpts = (typeof (options.reconnect) === 'object')
      ? options.reconnect
      : {}
    this.reconnect = {
      initialDelay: parseInt(rOpts.initialDelay || 100, 10),
      maxDelay: parseInt(rOpts.maxDelay || 10000, 10),
      failAfter: parseInt(rOpts.failAfter, 10) || Infinity
    }
  }
  this.strictDN = (options.strictDN !== undefined) ? options.strictDN : true

  this.queue = requestQueueFactory({
    size: parseInt((options.queueSize || 0), 10),
    timeout: parseInt((options.queueTimeout || 0), 10)
  })
  if (options.queueDisable) {
    this.queue.freeze()
  }

  // If provided tlsOptions but not a ldaps: url, do starttls before possibly bind
  if (options.tlsOptions) {
    this.on('setup', function (cb) {
      if (!this._socket.encrypted) {
        this.starttls(options.tlsOptions, cb)
        return
      }

      cb()
    })
  }

  // Configure setup action to implicitly bind the client if bindDN and
  // bindCredentials are passed in.  This will more closely mimic PooledClient
  // auto-login behavior.
  if (options.bindDN !== undefined && options.bindCredentials !== undefined) {
    this.on('setup', this.bind.bind(this, options.bindDN, options.bindCredentials))
  }

  this._socket = null
  this.connected = false
  this.connect()
}
util.inherits(Client, EventEmitter)
module.exports = Client

/**
 * Sends an abandon request to the LDAP server.
 *
 * The callback will be invoked as soon as the data is flushed out to the
 * network, as there is never a response from abandon.
 *
 * @param {Number} messageID the messageID to abandon.
 * @param {Control} controls (optional) either a Control or [Control].
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on invalid input.
 */
Client.prototype.abandon = function abandon (messageID, controls, callback) {
  assert.number(messageID, 'messageID')
  if (typeof (controls) === 'function') {
    callback = controls
    controls = []
  } else {
    controls = validateControls(controls)
  }
  if (callback) {
    assert.func(callback, 'callback')
  } else {
    callback = getPromiseCallback()
  }

  const req = new AbandonRequest({
    abandonID: messageID,
    controls: controls
  })

  this._dispatchRequest(req, 'abandon', callback)
  if (callback instanceof Promise) {
    return callback
  }
}

/**
 * Adds an entry to the LDAP server.
 *
 * Entry can be either [Attribute] or a plain JS object where the
 * values are either a plain value or an array of values.  Any value (that's
 * not an array) will get converted to a string, so keep that in mind.
 *
 * @param {String} name the DN of the entry to add.
 * @param {Object} entry an array of Attributes to be added or a JS object.
 * @param {Control} controls (optional) either a Control or [Control].
 * @param {Function} callback of the form f(err, res).
 * @throws {TypeError} on invalid input.
 */
Client.prototype.add = function add (name, entry, controls, callback) {
  assert.ok(name !== undefined, 'name')
  assert.object(entry, 'entry')
  if (typeof (controls) === 'function') {
    callback = controls
    controls = []
  } else {
    controls = validateControls(controls)
  }
  if (callback) {
    assert.func(callback, 'callback')
  } else {
    callback = getPromiseCallback()
  }

  if (Array.isArray(entry)) {
    entry.forEach(function (a) {
      if (!Attribute.isAttribute(a)) {
        throw new TypeError('entry must be an Array of Attributes')
      }
    })
  } else {
    const save = entry

    entry = []
    Object.keys(save).forEach(function (k) {
      const attr = new Attribute({ type: k })
      if (Array.isArray(save[k])) {
        save[k].forEach(function (v) {
          attr.addValue(v.toString())
        })
      } else if (Buffer.isBuffer(save[k])) {
        attr.addValue(save[k])
      } else {
        attr.addValue(save[k].toString())
      }
      entry.push(attr)
    })
  }

  const req = new AddRequest({
    entry: ensureDN(name, this.strictDN),
    attributes: entry,
    controls: controls
  })

  this._dispatchRequest(req, [errors.LDAP_SUCCESS], callback)
  if (callback instanceof Promise) {
    return callback
  }
}

/**
 * Performs a simple authentication against the server.
 *
 * @param {String} name the DN to bind as.
 * @param {String} credentials the userPassword associated with name.
 * @param {Control} controls (optional) either a Control or [Control].
 * @param {Function} callback of the form f(err, res).
 * @throws {TypeError} on invalid input.
 */
Client.prototype.bind = function bind (name, credentials, controls, callback) {
  if (typeof (name) !== 'string' && !(name instanceof dn.DN)) {
    throw new TypeError('name (string) required')
  }
  assert.optionalString(credentials, 'credentials')
  if (typeof (controls) === 'function') {
    callback = controls
    controls = []
  } else {
    controls = validateControls(controls)
  }
  if (callback) {
    assert.func(callback, 'callback')
  } else {
    callback = getPromiseCallback()
  }

  const req = new BindRequest({
    name: name || '',
    authentication: 'Simple',
    credentials: credentials || '',
    controls: controls
  })

  // Connection errors will be reported to the bind callback too (useful when the LDAP server is not available)
  const self = this
  const _callback = callback
  this.addListener('connectError', callback = function (err, ret) {
    self.removeListener('connectError', callback)
    _callback(err, ret)
  })

  this._dispatchRequest(req, [errors.LDAP_SUCCESS], callback)
  if (callback instanceof Promise) {
    return callback
  }
}

/**
 * Compares an attribute/value pair with an entry on the LDAP server.
 *
 * @param {String} name the DN of the entry to compare attributes with.
 * @param {String} attr name of an attribute to check.
 * @param {String} value value of an attribute to check.
 * @param {Control} controls (optional) either a Control or [Control].
 * @param {Function} callback of the form f(err, boolean, res).
 * @throws {TypeError} on invalid input.
 */
Client.prototype.compare = function compare (name, attr, value, controls, callback) {
  assert.ok(name !== undefined, 'name')
  assert.string(attr, 'attr')
  assert.string(value, 'value')
  if (typeof (controls) === 'function') {
    callback = controls
    controls = []
  } else {
    controls = validateControls(controls)
  }
  if (callback) {
    assert.func(callback, 'callback')
    const _callback = callback
    callback = function (err, res) {
      if (err) {
        _callback(err)
        return
      }

      _callback(null, res.status === errors.LDAP_COMPARE_TRUE, res)
    }
  } else {
    callback = getPromiseCallback((res) => [
      res.status === errors.LDAP_COMPARE_TRUE,
      res
    ])
  }

  const req = new CompareRequest({
    entry: ensureDN(name, this.strictDN),
    attribute: attr,
    value: value,
    controls: controls
  })

  this._dispatchRequest(req, [errors.LDAP_COMPARE_TRUE, errors.LDAP_COMPARE_FALSE], callback)
  if (callback instanceof Promise) {
    return callback
  }
}

/**
 * Deletes an entry from the LDAP server.
 *
 * @param {String} name the DN of the entry to delete.
 * @param {Control} controls (optional) either a Control or [Control].
 * @param {Function} callback of the form f(err, res).
 * @throws {TypeError} on invalid input.
 */
Client.prototype.del = function del (name, controls, callback) {
  assert.ok(name !== undefined, 'name')
  if (typeof (controls) === 'function') {
    callback = controls
    controls = []
  } else {
    controls = validateControls(controls)
  }
  if (callback) {
    assert.func(callback, 'callback')
  } else {
    callback = getPromiseCallback()
  }

  const req = new DeleteRequest({
    entry: ensureDN(name, this.strictDN),
    controls: controls
  })

  this._dispatchRequest(req, [errors.LDAP_SUCCESS], callback)
  if (callback instanceof Promise) {
    return callback
  }
}

/**
 * Performs an extended operation on the LDAP server.
 *
 * Pretty much none of the LDAP extended operations return an OID
 * (responseName), so I just don't bother giving it back in the callback.
 * It's on the third param in `res` if you need it.
 *
 * @param {String} name the OID of the extended operation to perform.
 * @param {String} value value to pass in for this operation.
 * @param {Control} controls (optional) either a Control or [Control].
 * @param {Function} callback of the form f(err, value, res).
 * @throws {TypeError} on invalid input.
 */
Client.prototype.exop = function exop (name, value, controls, callback) {
  assert.string(name, 'name')
  if (typeof (value) === 'function') {
    callback = value
    controls = []
    value = undefined
  }
  if (typeof (controls) === 'function') {
    callback = controls
    controls = []
  } else {
    controls = validateControls(controls)
  }
  if (callback) {
    assert.func(callback, 'callback')
    const _callback = callback
    callback = function (err, res) {
      if (err) {
        _callback(err)
        return
      }

      _callback(null, res.responseValue || '', res)
    }
  } else {
    callback = getPromiseCallback((res) => [res.responseValue || '', res])
  }

  const req = new ExtendedRequest({
    requestName: name,
    requestValue: value,
    controls: controls
  })

  this._dispatchRequest(req, [errors.LDAP_SUCCESS], callback)
  if (callback instanceof Promise) {
    return callback
  }
}

/**
 * Performs an LDAP modify against the server.
 *
 * @param {String} name the DN of the entry to modify.
 * @param {Change} change update to perform (can be [Change]).
 * @param {Control} controls (optional) either a Control or [Control].
 * @param {Function} callback of the form f(err, res).
 * @throws {TypeError} on invalid input.
 */
Client.prototype.modify = function modify (name, change, controls, callback) {
  assert.ok(name !== undefined, 'name')
  assert.object(change, 'change')
  if (typeof (controls) === 'function') {
    callback = controls
    controls = []
  } else {
    controls = validateControls(controls)
  }
  if (callback) {
    assert.func(callback, 'callback')
  } else {
    callback = getPromiseCallback()
  }

  function itemizeChanges () {
    function changesFromObject (c) {
      if (!c.operation && !c.type) {
        throw new Error('change.operation required')
      }
      if (typeof c.modification !== 'object') {
        throw new Error('change.modification (object) required')
      }

      if (
        Object.keys(c.modification).length === 2 &&
        typeof c.modification.type === 'string' &&
        Array.isArray(c.modification.vals)
      ) {
        return [new Change({
          operation: c.type,
          modification: c.modification
        })]
      }

      // Itemize the modification object by attribute
      return Object.entries(c.modification).map(function (k, val) {
        return new Change({
          operation: c.operation || c.type,
          modification: { [k]: val }
        })
      })
    }

    if (Change.isChange(change)) {
      return [change]
    }

    if (Array.isArray(change)) {
      return change.flatMap(function (c) {
        if (Change.isChange(c)) {
          return c
        }

        return changesFromObject(c)
      })
    }

    return changesFromObject(change)
  }

  const changes = itemizeChanges()
  const req = new ModifyRequest({
    object: ensureDN(name, this.strictDN),
    changes: changes,
    controls: controls
  })

  this._dispatchRequest(req, [errors.LDAP_SUCCESS], callback)
  if (callback instanceof Promise) {
    return callback
  }
}

/**
 * Performs an LDAP modifyDN against the server.
 *
 * This does not allow you to keep the old DN, as while the LDAP protocol
 * has a facility for that, it's stupid. Just Search/Add.
 *
 * This will automatically deal with "new superior" logic.
 *
 * @param {String} name the DN of the entry to modify.
 * @param {String} newName the new DN to move this entry to.
 * @param {Control} controls (optional) either a Control or [Control].
 * @param {Function} callback of the form f(err, res).
 * @throws {TypeError} on invalid input.
 */
Client.prototype.modifyDN = function modifyDN (name, newName, controls, callback) {
  assert.ok(name !== undefined, 'name')
  assert.string(newName, 'newName')
  if (typeof (controls) === 'function') {
    callback = controls
    controls = []
  } else {
    controls = validateControls(controls)
  }
  if (callback) {
    assert.func(callback, 'callback')
  } else {
    callback = getPromiseCallback()
  }

  const DN = ensureDN(name)
  // TODO: is non-strict handling desired here?
  const newDN = dn.parse(newName)

  const req = new ModifyDNRequest({
    entry: DN,
    deleteOldRdn: true,
    controls: controls
  })

  if (newDN.length !== 1) {
    req.newRdn = dn.parse(newDN.rdns.shift().toString())
    req.newSuperior = newDN
  } else {
    req.newRdn = newDN
  }

  this._dispatchRequest(req, [errors.LDAP_SUCCESS], callback)
  if (callback instanceof Promise) {
    return callback
  }
}

/**
 * Performs an LDAP search against the server.
 *
 * Note that the defaults for options are a 'base' search, if that's what
 * you want you can just pass in a string for options and it will be treated
 * as the search filter.  Also, you can either pass in programatic Filter
 * objects or a filter string as the filter option.
 *
 * Note that this method is 'special' in that the callback 'res' param will
 * have two important events on it, namely 'entry' and 'end' that you can hook
 * to.  The former will emit a SearchEntry object for each record that comes
 * back, and the latter will emit a normal LDAPResult object.
 *
 * @param {String} base the DN in the tree to start searching at.
 * @param {Object} options parameters:
 *                           - {String} scope default of 'base'.
 *                           - {String} filter default of '(objectclass=*)'.
 *                           - {Array} attributes [string] to return.
 *                           - {Boolean} attrsOnly whether to return values.
 *                           - {Boolean|Object} paged whether to utilize PagedControl
 *                                -{Number} pageSize
 *                                -{Boolean} pagePause
 * @param {Control} controls (optional) either a Control or [Control].
 * @param {Function} callback of the form f(err, res).
 * @throws {TypeError} on invalid input.
 *
 * analysis of events on a paged vs. non-paged search result:
 * 'error', 'searchEntry', and 'searchReference' events are similar for both
 * non-paged:
 *  'searchRequest' event occurs only once (only one request is written toward server)
 *  there are no 'page' events, and the 'end' event's data is the final LDAPResponse
 * paged:
 *  Each page request marked by a 'searchRequest' event when written toward server, event
 *   data is the LDAPMessage sent
 *  End of each page is marked by a 'page' event, event data is the LDAPResponse received
 *   When options.pagePause requests it, the 'page' event sends a callback function to request
 *   the next page, or to halt paging if called with an error.
 *  The end of results is marked by a 'end' event, event data is a repeat of the LDAPResponse
 *   sent with the final 'page' event, or the final error (if any)
 *  If the server does not support PagedControl, a 'pageError' event occurs, but if 'pageError'
 *   has no listeners, an 'error' event occurs instead and there is no page 'end' event
 *  Paging is sequential only, no rewinds or jumps.
 */
Client.prototype.search = function search (base, options, controls, callback) {
  assert.ok(base !== undefined, 'search base')
  if (Array.isArray(options) || options instanceof Control || options instanceof LdapControl) {
    callback = controls
    controls = options
    options = {}
  } else if (typeof (options) === 'function') {
    callback = options
    controls = []
    options = {
      filter: new PresenceFilter({ attribute: 'objectclass' })
    }
  } else if (typeof (options) === 'string') {
    options = { filter: filters.parseString(options) }
  } else if (typeof (options) !== 'object') {
    throw new TypeError('options (object) required')
  }
  if (typeof (options.filter) === 'string') {
    options.filter = filters.parseString(options.filter)
  } else if (!options.filter) {
    options.filter = new PresenceFilter({ attribute: 'objectclass' })
  } else if (Object.prototype.toString.call(options.filter) !== '[object FilterString]') {
    throw new TypeError('options.filter (Filter) required')
  }
  if (options.attributes) {
    if (!Array.isArray(options.attributes)) {
      if (typeof (options.attributes) !== 'string') {
        throw new TypeError('options.attributes must be an Array of Strings')
      }

      options.attributes = [options.attributes]
    }
  }
  if (options.paged) {
    if (typeof options.paged !== 'object') {
      options.paged = {}
    }
  }
  if (typeof (controls) === 'function') {
    callback = controls
    controls = []
  } else {
    controls = validateControls(controls)
  }
  if (callback) {
    assert.func(callback, 'callback')
  } else {
    callback = getPromiseCallback()
  }

  let pagedControl = controls.find(function (c) {
    return c.type === PagedResultsControl.OID
  })

  const self = this
  const baseDN = ensureDN(base, this.strictDN)
  const req = new SearchRequest({
    baseObject: baseDN,
    scope: options.scope || 'base',
    filter: options.filter,
    derefAliases: options.derefAliases || Protocol.NEVER_DEREF_ALIASES,
    sizeLimit: options.sizeLimit || 0,
    timeLimit: options.timeLimit || 10,
    typesOnly: options.typesOnly || false,
    attributes: options.attributes || [],
    controls: controls
  })

  const searchResult = new SearchResult()

  if (options.paged || pagedControl) {
    if (!pagedControl) {
      // According to the RFC, servers should ignore the paging control if
      // pageSize >= sizelimit.  Some might still send results, but it's safer
      // to stay under that figure when assigning a default value.
      pagedControl = new PagedResultsControl({
        value: {
          size:
            options.paged.pageSize > 0
              ? options.paged.pageSize
              : options.sizeLimit > 1
                ? options.sizeLimit - 1
                : 100 // Default page size
        }
      })

      req.controls.push(pagedControl)
    }

    callback = once(callback)
    pagedControl.value.cookie = null

    function pagedSearch (emitter) {
      self._dispatchRequest(req,
        [errors.LDAP_SUCCESS],
        emitter,
        function onSent (err, _, request) {
          if (!callback.called) {
            callback(err, searchResult)
          }

          if (err) {
            searchResult.emit('error', err)
            return
          }

          searchResult.emit('searchRequest', request)
        })
    }

    pagedSearch(searchResult.pagedResult(options.paged || {}, pagedControl, pagedSearch))
  } else {
    this._dispatchRequest(req,
      [errors.LDAP_SUCCESS],
      searchResult,
      function onSent (err, emitter, request) {
        callback(err, emitter)
        emitter.emit('searchRequest', request)
      })
  }

  if (callback instanceof Promise) {
    return callback
  }
}

/**
 * Unbinds this client from the LDAP server.
 *
 * Note that unbind does not have a response, so this callback is actually
 * optional; either way, the client is disconnected.
 *
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} if you pass in callback as not a function.
 */
Client.prototype.unbind = function unbind (callback) {
  if (callback) {
    assert.func(callback, 'callback')
  } else {
    callback = getPromiseCallback()
  }

  if (this._socket && this.connected) {
    const req = new UnbindRequest()
    this._dispatchRequest(req, 'unbind', callback)
  } else {
    // shortcut--request not sent to server
    // avoid queuing and reconnecting
    callback()
  }

  if (callback instanceof Promise) {
    return callback
  }
}

/**
 * Attempt to secure connection with StartTLS.
 */
Client.prototype.starttls = function starttls (options, controls, callback) {
  assert.optionalObject(options)
  options = options || {}
  if (typeof controls === 'function') {
    callback = controls
    controls = []
  } else {
    controls = validateControls(controls)
  }
  if (callback) {
    assert.func(callback, 'callback')
  } else {
    callback = getPromiseCallback()
  }

  if (this._starttls) {
    callback(new Error('STARTTLS already in progress'))
    return
  }

  if (this._socket.encrypted) {
    // could compare these options to the tlsOptions used for connection to LDAPS:// url ???
    callback(new Error('Socket is already encrypted'))
    return
  }

  this._starttls = 'starting'

  const self = this
  const req = new ExtendedRequest({
    requestName: exops.StartTlsExOp.OID,
    requestValue: null,
    controls: controls
  })

  // TODO: block all new requests pending resolution, wait for pending operations to complete
  //  self.connected = false // force request queuing
  //  do following in an event handler on the queue's 'drain' event

  // use emitter, we need to react to server's reply
  const emitter = new EventEmitter()
    .on('error', function onStartTlsError (err) {
      delete self._starttls
      callback(err)
    })
    .on('end', function onStartTlsReply () {
      const socket = self._socket

      // suspend 'data' event mapping (prevent leaking the TLS handshake to pending trackers)
      // TODO: there shouldn't be any pending operations
      const dataListeners = socket.listeners('data')
      socket.removeAllListeners('data')

      options.socket = socket
      tls.connect(options, function onSecureConnection () {
        // relocate 'data' event listeners to secure socket (restore mapping to self._tracker.parser)
        dataListeners.forEach(function (listener) {
          this.on('data', listener)
        })

        // re-use 'error' event listeners from TCP socket
        this.removeAllListeners('error')
        socket.listeners('error').forEach(function (listener) {
          this.on('error', listener)
        })

        self._socket = this
        delete self._starttls
        callback()
      })
        .once('error', function onSecureConnectError (err) {
          // restore 'data' listeners mapping to TCP socket
          dataListeners.forEach(function (listener) {
            socket.on('data', listener)
          })

          delete self._starttls
          callback(err)
        })
    })

  this._dispatchRequest(req, [errors.LDAP_SUCCESS], emitter, function onSent (err) {
    if (err) {
      delete self._starttls
      callback(err)
    }
  })

  if (callback instanceof Promise) {
    return callback
  }
}

/**
 * Disconnect from the LDAP server and do not allow reconnection.
 *
 * If the client is instantiated with proper reconnection options, it's
 * possible to initiate new requests after a call to unbind since the client
 * will attempt to reconnect in order to fulfill the request.
 *
 * Calling destroy will prevent any further reconnection from occurring.
 * Pending requests receive a ConnectionError
 * Courtesy unbind is sent to server, if connected
 *
 * @param {Object} err (Optional) error that was cause of client destruction
 */
Client.prototype.destroy = function destroy (err) {
  this.queue.freeze()
  this.queue.flush(function (_msg, _expect, _emitter, callback) {
    callback(new ConnectionError('client destroyed'))
  })

  if (this._socket) {
    if (this.connected) {
      this.unbind() // socket is closed once request is flushed to socket
      // in case of back-pressure, fall through to destroy socket immediately
    }

    this._socket.destroy()
  }

  this.destroyed = true
  this.emit('destroy', err)
}

/**
 * Initiate LDAP connection.
 */
Client.prototype.connect = function connect () {
  if (this.connected || this.connecting) {
    return
  }

  if (this.destroyed) {
    // cite comments on this.destroy:
    // "Calling destroy will prevent any further reconnection from occurring."
    return
  }

  this.connecting = true

  const self = this

  function getNextServer () {
    const server = self.urls[self._nextServer]
    self._nextServer = (self._nextServer + 1) % self.urls.length

    return server
  }

  function connectSocket (server, next) {
    function startConnectTimer (cb) {
      if (self.connectTimeout) {
        self.connectTimer = setTimeout(function onConnectTimeout () {
          socket.destroy()
          cb(new ConnectionTimeout())
        }, self.connectTimeout)
      }
    }

    function clearConnectTimer () {
      if (self.connectTimer) {
        clearTimeout(self.connectTimer)
        delete self.connectTimer
      }
    }

    let socket
    function callback (connectErr) {
      clearConnectTimer()

      if (connectErr) {
        self.emit('connectError', connectErr)
        next(connectErr)
        return
      }

      // set self._socket as soon as TCP/TLS is connected
      socket
        .removeAllListeners('error')
        .removeAllListeners('connect')
        .removeAllListeners('secureConnect')

      // identify remote endpoint as soon as available
      let serverDescription
      if (server) {
        self.secure = !!socket.encrypted
        self.host = server.hostname
        self.port = server.port
        serverDescription = server.href
      } else {
        self.path = self.socketPath
        serverDescription = self.socketPath
      }

      next(null, socket, serverDescription)
    }

    startConnectTimer(callback)

    if (server && server.secure) {
      if (server.hostname && server.port) {
        socket = tls.connect(server.port, server.hostname, self.tlsOptions, callback)
      } else {
        socket = tls.connect(server.port || self.socketPath, self.tlsOptions, callback)
      }
    } else if (server && server.hostname && server.port) {
      socket = net.connect(server.port, server.hostname, callback)
    } else {
      socket = net.connect((server && server.port) || self.socketPath, callback)
    }

    socket.once('error', callback)

    // patch setKeepAlive method on TlsSocket
    if (typeof (socket.setKeepAlive) !== 'function') {
      socket.setKeepAlive = socket.socket ? socket.socket.setKeepAlive : false
    }
  }

  function setupResponseTracker (socket, serverDescription) {
    const tracker = messageTrackerFactory({
      id: nextClientId() + '__' + (serverDescription),
      parser: new Parser({ log: self.log })
    })

    self.log = self.log.child({ ldap_id: tracker.id }, true)
    const log = self.log

    socket.on('data', function onData (data) {
      log.trace('data event: %s', util.inspect(data))
      tracker.parser.write(data)
    })

    tracker.parser.on('message', function onMessage (message) {
      message.connection = socket
      const callback = tracker.fetch(message.messageID)
      if (!callback) {
        log.error({ message: message.json }, 'unsolicited message')
        return
      }

      callback(message)
    })

    tracker.parser.on('error', function onParseError (err) {
      self.emit('error', new VError(err, 'Parser error for %s', tracker.id))
      socket.end()
    })

    return tracker
  }

  function runSetupTasks (socket, next) {
    function bail (err) {
      socket.destroy()
      next(err || new Error('client error during setup'))
    }

    ;(socket.socket ? socket.socket : socket).once('close', bail)
    socket.once('end', bail)
    socket.once('error', bail)
    socket.once('timeout', bail)

    // exec setup tasks (registered as setup event listeners)
    vasync.forEachPipeline({
      inputs: self.listeners('setup'),
      func: function (f, cb) {
        f.call(self, cb)
      }
    }, function (err) {
      // finished setup tasks, remove setup-phase listeners
      ;(socket.socket ? socket.socket : socket).removeListener('close', bail)
      socket
        .removeListener('end', bail)
        .removeListener('error', bail)
        .removeListener('timeout', bail)

      if (err) {
        self.emit('setupError', err)
        socket.destroy()
      }

      next(err, socket)
    })
  }

  function setConnectedSocketListeners (socket) {
    const log = self.log
    ;(socket.socket ? socket.socket : socket).once(
      'close',
      self._onClose.bind(self)
    )
    socket.once('end', function onEnd () {
      log.trace('socket end event')
      self.emit('end')
      socket.end()
    })
    socket.once('timeout', function onTimeout () {
      log.trace('socket timeout event')
      self.emit('socketTimeout')
      socket.end()
    })
    socket.once('error', function onSocketError (socketErr) {
      log.trace({ err: socketErr }, 'socket error event: %s', new Error().stack)
      self.emit('error', socketErr)
      socket.destroy()
    })
  }

  let retry
  let maxRetries = this.urls.length || 1
  if (this.reconnect) {
    if (this.reconnect.failAfter) {
      maxRetries *= this.reconnect.failAfter
    }

    retry = backoff.exponential({
      initialDelay: this.reconnect.initialDelay,
      maxDelay: this.reconnect.maxDelay
    })
  } else {
    retry = backoff.exponential({
      initialDelay: 1,
      maxDelay: 2
    })
  }

  retry.on('ready', function onBackoffReady (num) {
    if (self.destroyed) {
      return
    }

    // phase one:  connect socket
    connectSocket(getNextServer(), function (err, socket, serverDescription) {
      if (err) {
        retry.backoff(err)
        return
      }

      onConnected(socket, serverDescription)
    })

    // phase two: setup tasks
    function onConnected (socket, serverDescription) {
      self._socket = socket
      self._tracker = setupResponseTracker(socket, serverDescription)
      runSetupTasks(socket, function (err) {
        if (err) {
          retry.backoff(err)
          return
        }

        afterSetup(socket)
      })
    }

    // final phase: prepare runtime & flush queued requests
    function afterSetup (socket) {
      self.log.debug('connected after %d attempt(s)', num + 1)
      self.connected = !(self.connecting = false)
      setConnectedSocketListeners(socket)

      self.queue.flush(self._sendRequest, self)
      self.emit('connect', socket)
      retry.reset()
    }
  })

  retry.on('fail', function onBackoffFail (err) {
    self.log.debug('failed to connect after %d attempts', maxRetries)

    function dispatchError (event, data) {
      if (event !== 'error' && self.listenerCount(event) === 0 && data) {
        // convert to error event
        if (typeof data === 'string') {
          data = event + ': ' + data
        } else if (data.message) {
          data.message = event + ': ' + data.message
        }

        event = 'error'
      }

      self.emit(event, data)
    }

    if (err) {
      if (err instanceof ConnectionTimeout) {
        dispatchError('connectTimeout', err)
      } else if (err.code === 'ECONNREFUSED') {
        dispatchError('connectRefused', err)
      } else {
        dispatchError('error', err)
      }
    } else {
      dispatchError('error', 'max retries')
    }
  })

  retry.failAfter(maxRetries)
  retry.backoff()
}

/// --- Private API

/**
 * Clean up socket/parser resources after socket close.
 */
Client.prototype._onClose = function _onClose (closeError) {
  this.log.trace('close event had_err=%s', closeError ? 'yes' : 'no')
  this.connected = false

  // On close we have to walk the outstanding messages and go invoke their
  // callback with an error.
  const socket = this._socket
  const tracker = this._tracker
  tracker.purge(function (msgid, cb) {
    if (msgid === socket.unbindMessageID) {
      // Unbinds will be communicated as a success since we're closed
      const unbind = new UnbindResponse({ messageID: msgid })
      unbind.status = 'unbind'
      cb(unbind)
      return
    }

    cb(new ConnectionError(tracker.id + ' closed'))
  })
  this._tracker = null

  ;((socket.socket) ? socket.socket : socket).removeAllListeners('close')
  socket.removeAllListeners('connect')
    .removeAllListeners('data')
    .removeAllListeners('drain')
    .removeAllListeners('end')
    .removeAllListeners('error')
    .removeAllListeners('timeout')
  this._socket = null

  this.emit('close', closeError)

  // start re-connection, except if closed by 'unbind'
  if (this.reconnect && !socket.unbindMessageID) {
    this.connect()
  }
}

/**
 * Attempt to send an LDAP request.
 */
Client.prototype._dispatchRequest = function _dispatchRequest (req, expect, emitter, callback) {
  assert.ok(req)
  assert.ok(expect)
  if (emitter && !(emitter instanceof EventEmitter)) {
    callback = emitter
    emitter = null
  }
  assert.optionalObject(emitter)
  assert.ok(callback)

  if (this.destroyed) {
    callback(new ConnectionError('client destroyed'))
    return
  }

  // Allow setup tasks during connection to bypass request-queue
  if (this.connecting && this._socket && this._socket.writable) {
    this._sendRequest(req, expect, emitter, callback)
    return
  }

  if (!this._socket || !this.connected || this._socket.stuffed) {
    // need reconnect, setup tasks not complete, or socket-write stream is buffered
    if (!this.queue.enqueue(req, expect, emitter, callback)) {
      callback(new ConnectionError('request queue unavailable'))
      return
    }

    if (this.connected || this.connecting) return

    if (this.reconnect) {
      // reconnect after unbind or destroy (else reconnect afer socket 'end' event is automatic)
      this.connect() // idempotent if connection is in-progress
      return
    }

    // caller will have to take some action to resume the request just queued
    callback(new ConnectionError('connection unavailable'))
    return
  }

  this.queue.flush(this._sendRequest, this)
  this._sendRequest(req, expect, emitter, callback)
}

Client.prototype._sendRequest = function _sendRequest (req, expect, emitter, callback) {
  const self = this
  const socket = this._socket
  const tracker = this._tracker
  const log = this.log

  function clearIdleTimer () {
    if (self._idleTimer) {
      clearTimeout(self._idleTimer)
      self._idleTimer = null
    }
  }

  let requestTimer = null
  function startRequestTimer () {
    if (self.timeout) {
      log.trace('Setting request timeout to %d', self.timeout)
      requestTimer = setTimeout(function onTimeout () {
        requestTimer = null
        self.emit('timeout', req)

        const onMessageTracker = tracker.fetch(req.messageID)
        if (onMessageTracker) {
          tracker.abandon(req.messageID)
          onMessageTracker(
            new errors.TimeoutError('request timeout (client interrupt)')
          )
        }
      }, self.timeout)
    }
  }

  function clearRequestTimer () {
    if (requestTimer) {
      clearTimeout(requestTimer)
    }
  }

  function startIdleTimer () {
    function connectionIdle () {
      return (
        self._socket &&
        self.connected &&
        self._tracker.pending === 0
      )
    }

    if (connectionIdle() && self.idleTimeout && !self._idleTimer) {
      self._idleTimer = setTimeout(function () {
        if (connectionIdle()) {
          self.emit('idle')
        }
      }, self.idleTimeout)
    }
  }

  log.trace('sending request %j', req.json)
  clearIdleTimer()
  startRequestTimer()

  tracker.track(req, function onMessage (msg) { // message.messageID set here as side-effect, btw
    log.trace({ msg: msg ? msg.json : null }, 'response received')
    clearRequestTimer()

    function dispatch (event, data) {
      if (event === 'error') {
        self.emit('resultError', data)
      }

      if (emitter) {
        emitter.emit(event || 'end', data)
        return
      }

      if (event === 'error') {
        callback(data)
        return
      }

      callback(null, data)
    }

    if (expect === 'abandon') {
      // response to 'abandon' is not tracked--should not reach here
      dispatch('end')
      return
    }

    if (msg instanceof SearchEntry || msg instanceof SearchReference) {
      const msgName = msg.constructor.name
      const event = msgName[0].toLowerCase() + msgName.slice(1)
      dispatch(event, msg)
      return
    }

    // expect no further replies from server on this request
    tracker.remove(req.messageID)
    startIdleTimer()

    if (msg instanceof Error) {
      dispatch('error', msg)
      return
    }

    if (!(msg instanceof LDAPResult)) {
      dispatch('error', new errors.ProtocolError(msg.type))
      return
    }

    if (expect.indexOf(msg.status) === -1) {
      // unexpected message from server
      dispatch('error', errors.getError(msg))
      return
    }

    dispatch(null, msg)
  })

  try {
    socket.write(req.toBer(), function onSent () {
      if (expect === 'abandon') {
        tracker.abandon(req.abandonID) // Mark the messageID specified as abandoned
        tracker.remove(req.messageID) // No need to track the abandon request itself
        callback(null)
        return
      }

      if (expect === 'unbind') {
        // will not wait for server reply, callback is invoked by socket's close listener
        socket.unbindMessageID = req.messageID
        socket.removeAllListeners('error')
        socket.end()
        return
      }

      if (emitter) {
        callback(null, emitter, req)
      }
    })
  } catch (err) {
    log.trace({ err: err }, 'Error writing message to socket')
    clearRequestTimer()
    callback(err)
  }
}
