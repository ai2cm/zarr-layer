// CachingStore in-flight dedupe, abort sharing and byte accounting, loaded
// from src via esbuild. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc } from './load-src.mjs'

const { CachingStore } = await loadSrc('src/caching-store.ts')

const tick = () => new Promise((r) => setTimeout(r, 0))

// A base store whose gets stay pending until resolved by hand. Each call is
// recorded with its key and signal. `ignoreAbort` makes it resolve even
// after its signal aborts (like a store that doesn't honour signals).
function manualBase({ sizes = {}, ignoreAbort = false } = {}) {
  const calls = []
  const base = {
    get(key, opts) {
      return new Promise((resolve, reject) => {
        const call = { key, signal: opts?.signal, resolve, reject }
        call.resolveData = () => {
          const n = sizes[key]
          resolve(n === undefined ? undefined : new Uint8Array(n).fill(7))
        }
        if (!ignoreAbort) {
          opts?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        }
        calls.push(call)
      })
    },
  }
  return { base, calls }
}

const sumEntryBytes = (store, keys) =>
  keys.reduce((t, k) => t + (store.getEntryBytes(k) ?? 0), 0)

test('two concurrent gets of one key make one base fetch; both get the data', async () => {
  const { base, calls } = manualBase({ sizes: { '/a': 100 } })
  const store = new CachingStore(base, 10_000)
  const p1 = store.get('/a')
  const p2 = store.get('/a', { signal: new AbortController().signal })
  assert.equal(calls.length, 1)
  calls[0].resolveData()
  const [a, b] = await Promise.all([p1, p2])
  assert.equal(a.byteLength, 100)
  assert.equal(b, a)
  assert.equal(store.getTotalBytes(), 100)
  assert.equal(store.size, 1)
  // Settled: the next get is a cache hit
  await store.get('/a')
  assert.equal(calls.length, 1)
})

test('each caller access is attributed once, with its own options', async () => {
  const { base, calls } = manualBase({ sizes: { '/a': 10 } })
  const store = new CachingStore(base, 10_000)
  const seen = []
  store.addAccessListener((key, opts) => {
    // Resident when the listener runs
    seen.push([key, opts?.signal ?? null, store.has(key)])
  })
  const s1 = new AbortController().signal
  const s2 = new AbortController().signal
  const p1 = store.get('/a', { signal: s1 })
  const p2 = store.get('/a', { signal: s2 })
  const p3 = store.get('/a')
  calls[0].resolveData()
  await Promise.all([p1, p2, p3])
  assert.equal(seen.length, 3)
  const who = (s) => (s === s1 ? 's1' : s === s2 ? 's2' : s)
  assert.deepEqual(
    // Order across callers is not specified
    seen.map(([k, s, resident]) => [k, who(s) ?? '-', resident]).sort(),
    [
      ['/a', '-', true],
      ['/a', 's1', true],
      ['/a', 's2', true],
    ]
  )
})

test('one caller aborting does not fail the other or cancel the shared fetch', async () => {
  const { base, calls } = manualBase({ sizes: { '/a': 50 } })
  const store = new CachingStore(base, 10_000)
  const seen = []
  store.addAccessListener((key, opts) => seen.push(opts?.signal))
  const c1 = new AbortController()
  const c2 = new AbortController()
  const p1 = store.get('/a', { signal: c1.signal })
  const p2 = store.get('/a', { signal: c2.signal })
  c1.abort()
  await assert.rejects(p1, { name: 'AbortError' })
  assert.equal(calls[0].signal.aborted, false, 'shared fetch still running')
  calls[0].resolveData()
  assert.equal((await p2).byteLength, 50)
  assert.equal(seen.length, 1, 'only the caller that got data')
  assert.equal(seen[0], c2.signal)
  assert.equal(store.getTotalBytes(), 50)
})

test('a caller without a signal keeps the shared fetch alive', async () => {
  const { base, calls } = manualBase({ sizes: { '/a': 50 } })
  const store = new CachingStore(base, 10_000)
  const c1 = new AbortController()
  const p1 = store.get('/a', { signal: c1.signal })
  const p2 = store.get('/a')
  c1.abort()
  await assert.rejects(p1, { name: 'AbortError' })
  assert.equal(calls[0].signal.aborted, false)
  calls[0].resolveData()
  assert.equal((await p2).byteLength, 50)
})

test('when every caller aborts the base fetch is aborted; a later get fetches afresh', async () => {
  const { base, calls } = manualBase({ sizes: { '/a': 50 } })
  const store = new CachingStore(base, 10_000)
  const c1 = new AbortController()
  const c2 = new AbortController()
  const p1 = store.get('/a', { signal: c1.signal })
  const p2 = store.get('/a', { signal: c2.signal })
  c1.abort()
  c2.abort()
  await assert.rejects(p1, { name: 'AbortError' })
  await assert.rejects(p2, { name: 'AbortError' })
  assert.equal(calls[0].signal.aborted, true)
  const p3 = store.get('/a')
  assert.equal(calls.length, 2, 'does not join the aborted fetch')
  calls[1].resolveData()
  assert.equal((await p3).byteLength, 50)
  assert.equal(store.getTotalBytes(), 50)
})

test('an already-aborted signal rejects without fetching', async () => {
  const { base, calls } = manualBase({ sizes: { '/a': 50 } })
  const store = new CachingStore(base, 10_000)
  const c = new AbortController()
  c.abort()
  await assert.rejects(store.get('/a', { signal: c.signal }), {
    name: 'AbortError',
  })
  assert.equal(calls.length, 0)
})

test('a base error reaches every waiter and is not cached; a retry refetches', async () => {
  const { base, calls } = manualBase({ sizes: { '/a': 50 } })
  const store = new CachingStore(base, 10_000)
  const p1 = store.get('/a')
  const p2 = store.get('/a', { signal: new AbortController().signal })
  calls[0].reject(new Error('boom'))
  await assert.rejects(p1, /boom/)
  await assert.rejects(p2, /boom/)
  assert.equal(store.size, 0)
  const p3 = store.get('/a')
  assert.equal(calls.length, 2)
  calls[1].resolveData()
  assert.equal((await p3).byteLength, 50)
})

test('totalBytes equals the sum of entry sizes after concurrent fills', async () => {
  const sizes = { '/a': 100, '/b': 200, '/c': 300 }
  const { base, calls } = manualBase({ sizes })
  const store = new CachingStore(base, 10_000)
  const pending = []
  for (let i = 0; i < 3; i++) {
    for (const key of Object.keys(sizes)) {
      pending.push(store.get(key, { signal: new AbortController().signal }))
    }
  }
  assert.equal(calls.length, 3)
  for (const c of calls) c.resolveData()
  await Promise.all(pending)
  assert.equal(store.getTotalBytes(), 600)
  assert.equal(store.getTotalBytes(), sumEntryBytes(store, Object.keys(sizes)))
})

test('overwrite: a fetch that ignored its abort and lands after a refetch is counted once', async () => {
  const { base, calls } = manualBase({
    sizes: { '/a': 100 },
    ignoreAbort: true,
  })
  const store = new CachingStore(base, 10_000)
  const c = new AbortController()
  const p1 = store.get('/a', { signal: c.signal })
  c.abort()
  await assert.rejects(p1, { name: 'AbortError' })
  const p2 = store.get('/a')
  assert.equal(calls.length, 2)
  calls[1].resolveData()
  await p2
  // The abandoned request still resolves (the base store ignored the abort)
  calls[0].resolveData()
  await tick()
  assert.equal(store.size, 1)
  assert.equal(store.getTotalBytes(), 100)
})

test('concurrent getRange reads of one shard make one base fetch', async () => {
  const { base, calls } = manualBase({ sizes: { '/shard': 16 } })
  const store = new CachingStore(base, 10_000)
  const r1 = store.getRange('/shard', { offset: 0, length: 4 })
  const r2 = store.getRange('/shard', { offset: 4, length: 4 })
  const r3 = store.getRange('/shard', { suffixLength: 2 })
  assert.equal(calls.length, 1)
  calls[0].resolveData()
  const [a, b, c] = await Promise.all([r1, r2, r3])
  assert.deepEqual([a.byteLength, b.byteLength, c.byteLength], [4, 4, 2])
  assert.equal(store.getTotalBytes(), 16)
})
