'use strict'

const { test } = require('tap')
const flush = require('../../../../lib/client/request-queue/flush')

test('clears timer', async t => {
  t.plan(2)
  const q = {
    _timer: 123,
    _queue: {
      values () {
        return []
      },
      clear () {
        t.pass()
      }
    }
  }
  flush.call(q)
  t.equal(q._timer, null)
})

test('invokes callback with parameters', async t => {
  t.plan(6)
  const q = {
    _timer: 123,
    _queue: {
      values () {
        return [['foo', 'bar', 'baz', theCB]]
      },
      clear () {
        t.pass()
      }
    }
  }
  flush.call(q, function () {
    t.equal(arguments[0], 'foo')
    t.equal(arguments[1], 'bar')
    t.equal(arguments[2], 'baz')
    t.equal(arguments[3], theCB)
  })
  t.equal(q._timer, null)

  function theCB () {}
})
