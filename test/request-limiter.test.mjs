// Unit tests for the prefetch request cap (task 30).
// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RequestLimiter } from '../src/request-limiter.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

// Tasks that stay running until the test releases them
function gated() {
  const gates = new Map()
  const started = []
  const task = (name) => () =>
    new Promise((resolve) => {
      started.push(name)
      gates.set(name, resolve)
    })
  const release = async (name) => {
    await tick()
    gates.get(name)()
    await tick()
  }
  return { task, started, release }
}

test('never more than max tasks run; waiters start in priority order, FIFO among equals', async () => {
  const limiter = new RequestLimiter(2)
  const g = gated()
  const done = [
    limiter.run(g.task('a0'), { priority: 0 }),
    limiter.run(g.task('b0'), { priority: 1 }),
    limiter.run(g.task('b1'), { priority: 1 }),
    limiter.run(g.task('c0'), { priority: 2 }),
    limiter.run(g.task('a1'), { priority: 0 }),
    limiter.run(g.task('b2'), { priority: 1 }),
  ]
  await tick()
  assert.deepEqual(g.started, ['a0', 'b0'])
  assert.equal(limiter.active, 2)
  assert.equal(limiter.pending, 4)
  await g.release('a0')
  assert.deepEqual(g.started, ['a0', 'b0', 'a1'], 'priority 0 jumps ahead')
  await g.release('b0')
  await g.release('a1')
  assert.deepEqual(g.started, ['a0', 'b0', 'a1', 'b1', 'b2'])
  await g.release('b1')
  await g.release('b2')
  await g.release('c0')
  await Promise.all(done)
  assert.equal(limiter.peak, 2)
  assert.equal(limiter.active, 0)
})

test('a waiting task whose signal aborts is dropped with an AbortError and never runs', async () => {
  const limiter = new RequestLimiter(1)
  const g = gated()
  const controller = new AbortController()
  const first = limiter.run(g.task('x'))
  const waiting = limiter.run(g.task('y'), { signal: controller.signal })
  const after = limiter.run(g.task('z'))
  controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
  assert.equal(limiter.pending, 1)
  await g.release('x')
  assert.deepEqual(g.started, ['x', 'z'])
  await g.release('z')
  await Promise.all([first, after])
  // Already aborted: rejected without queueing
  await assert.rejects(
    limiter.run(g.task('w'), { signal: controller.signal }),
    {
      name: 'AbortError',
    }
  )
  assert.deepEqual(g.started, ['x', 'z'])
})

test('a failing task frees its slot and propagates its error', async () => {
  const limiter = new RequestLimiter(1)
  const failing = limiter.run(async () => {
    throw new Error('boom')
  })
  const next = limiter.run(async () => 42)
  await assert.rejects(failing, /boom/)
  assert.equal(await next, 42)
  assert.equal(limiter.active, 0)
})

test('chunkQueue: a zarrita-style queue whose tasks share the cap', async () => {
  const limiter = new RequestLimiter(3)
  let live = 0
  let peak = 0
  const job = () => async () => {
    live++
    peak = Math.max(peak, live)
    await new Promise((r) => setTimeout(r, 2))
    live--
  }
  const queues = [limiter.chunkQueue(), limiter.chunkQueue({ priority: 1 })]
  for (const q of queues) for (let i = 0; i < 5; i++) q.add(job())
  await Promise.all(queues.map((q) => q.onIdle()))
  assert.equal(peak, 3)
})

test('max must be >= 1', () => {
  assert.throws(() => new RequestLimiter(0), RangeError)
  assert.throws(() => new RequestLimiter(NaN), RangeError)
  assert.equal(new RequestLimiter(2.7).max, 2)
})

test('chunkQueue.onIdle waits for every task even after one rejects, then rejects with that error', async () => {
  const limiter = new RequestLimiter(1)
  const g = gated()
  const q = limiter.chunkQueue()
  q.add(async () => {
    throw new Error('503')
  })
  q.add(g.task('b')) // queued behind the failing task
  let settled = false
  const idle = q.onIdle().finally(() => {
    settled = true
  })
  idle.catch(() => {})
  await tick()
  assert.deepEqual(g.started, ['b'])
  assert.equal(settled, false, 'must not settle while b is still running')
  await g.release('b')
  await assert.rejects(idle, /503/)
  assert.equal(limiter.active, 0)
})
