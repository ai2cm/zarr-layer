// CachingStore range mode (rangeRequests: true): range caching, in-flight
// dedupe, fallbacks when a server ignores or rejects ranges, byte
// accounting, and step attribution through ZarrLayer. Loaded from src via
// esbuild. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc } from './load-src.mjs'

const {
  CachingStore,
  RangeIgnoredError,
  RangeNotSatisfiableError,
  RangeRateLimitedError,
  RANGE_NETWORK_FAILURES_BEFORE_ERROR,
  RANGE_KEY_SEPARATOR: S,
  rangeCacheKey,
} = await loadSrc('src/caching-store.ts')
const { ZarrLayer } = await loadSrc('src/zarr-layer.ts')

const tick = () => new Promise((r) => setTimeout(r, 0))

// An object's bytes: byte i is i % 251, so slices are recognisable
const objectBytes = (n) => Uint8Array.from({ length: n }, (_, i) => i % 251)
const expectedSlice = (n, range) => {
  const full = objectBytes(n)
  return 'suffixLength' in range
    ? full.slice(Math.max(0, n - range.suffixLength))
    : full.slice(range.offset, range.offset + range.length)
}

// A base store with get and getRange over objects of `sizes[key]` bytes.
// Calls stay pending until resolved by hand (`resolveData`) unless `auto`.
// `mode` changes how getRange answers: 'range' (a 206), 'ignore' (the whole
// object, as FetchStore passes a 200 through), 'ignoreError' (throws
// RangeIgnoredError with the whole body), '416', 'error'.
// `fail`: errors thrown by the first getRange calls, one per call, before
// answering normally.
function rangeBase({
  sizes = {},
  mode = 'range',
  auto = false,
  fail = [],
} = {}) {
  fail = [...fail]
  const calls = []
  const pending = (kind, key, range, opts, answer) =>
    new Promise((resolve, reject) => {
      const call = { kind, key, range, signal: opts?.signal, resolve, reject }
      call.resolveData = () => {
        try {
          resolve(answer())
        } catch (err) {
          reject(err)
        }
      }
      opts?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError'))
      )
      calls.push(call)
      if (auto) queueMicrotask(call.resolveData)
    })
  const base = {
    get(key, opts) {
      return pending('get', key, null, opts, () =>
        sizes[key] === undefined ? undefined : objectBytes(sizes[key])
      )
    },
    getRange(key, range, opts) {
      const failure = fail.shift()
      return pending('range', key, range, opts, () => {
        if (failure) throw failure
        const n = sizes[key]
        if (n === undefined) return undefined
        if (mode === 'ignore') return objectBytes(n)
        if (mode === 'ignoreError') {
          throw new RangeIgnoredError(key, objectBytes(n))
        }
        if (mode === '416') throw new RangeNotSatisfiableError(key)
        if (mode === 'error') throw new Error('network down')
        return expectedSlice(n, range)
      })
    },
  }
  return { base, calls }
}

const rangeStore = (base, maxBytes = 10_000) =>
  new CachingStore(base, maxBytes, {
    rangeRequests: true,
    retryDelayMs: () => 0,
  })

test('range mode reads a range with getRange and caches it under its range key', async () => {
  const { base, calls } = rangeBase({ sizes: { '/s': 1000 }, auto: true })
  const store = rangeStore(base)
  const seen = []
  store.addAccessListener((k) => seen.push(k))
  const range = { offset: 100, length: 50 }
  const a = await store.getRange('/s', range)
  assert.deepEqual(a, expectedSlice(1000, range))
  assert.deepEqual(
    calls.map((c) => [c.kind, c.key]),
    [['range', '/s']]
  )
  const key = rangeCacheKey('/s', range)
  assert.equal(key, `/s${S}100:50`)
  assert.ok(store.has(key))
  assert.ok(!store.has('/s'))
  assert.equal(store.getEntryBytes(key), 50)
  assert.equal(store.getTotalBytes(), 50)
  // A hit: no new base call, same key reported
  const b = await store.getRange('/s', range)
  assert.equal(b, a)
  assert.equal(calls.length, 1)
  assert.deepEqual(seen, [key, key])
})

test('suffix ranges are cached under their own key', async () => {
  const { base, calls } = rangeBase({ sizes: { '/s': 1000 }, auto: true })
  const store = rangeStore(base)
  const idx = await store.getRange('/s', { suffixLength: 20 })
  assert.deepEqual(idx, expectedSlice(1000, { suffixLength: 20 }))
  assert.equal(rangeCacheKey('/s', { suffixLength: 20 }), `/s${S}suffix:20`)
  assert.equal(store.getEntryBytes(`/s${S}suffix:20`), 20)
  await store.getRange('/s', { suffixLength: 20 })
  assert.equal(calls.length, 1)
})

test('concurrent reads of one range share a fetch; other ranges fetch separately', async () => {
  const { base, calls } = rangeBase({ sizes: { '/s': 1000 } })
  const store = rangeStore(base)
  const r1 = store.getRange('/s', { offset: 0, length: 10 })
  const r2 = store.getRange(
    '/s',
    { offset: 0, length: 10 },
    { signal: new AbortController().signal }
  )
  const r3 = store.getRange('/s', { offset: 10, length: 10 })
  assert.equal(calls.length, 2)
  for (const c of calls) c.resolveData()
  const [a, b, c] = await Promise.all([r1, r2, r3])
  assert.equal(a, b)
  assert.equal(c.byteLength, 10)
  assert.equal(store.size, 2)
  assert.equal(store.getTotalBytes(), 20)
})

test('range dedupe keeps get() abort semantics', async () => {
  const { base, calls } = rangeBase({ sizes: { '/s': 1000 } })
  const store = rangeStore(base)
  const range = { offset: 0, length: 10 }
  const c1 = new AbortController()
  const c2 = new AbortController()
  const p1 = store.getRange('/s', range, { signal: c1.signal })
  const p2 = store.getRange('/s', range, { signal: c2.signal })
  assert.equal(calls.length, 1)
  c1.abort()
  await assert.rejects(p1, { name: 'AbortError' })
  assert.equal(
    calls[0].signal.aborted,
    false,
    'one waiter left: fetch continues'
  )
  calls[0].resolveData()
  assert.equal((await p2).byteLength, 10)

  // Every waiter aborts: the base request is aborted, nothing cached
  const range2 = { offset: 10, length: 10 }
  const c3 = new AbortController()
  const p3 = store.getRange('/s', range2, { signal: c3.signal })
  c3.abort()
  await assert.rejects(p3, { name: 'AbortError' })
  assert.equal(calls[1].signal.aborted, true)
  assert.ok(!store.has(rangeCacheKey('/s', range2)))
  // No full-object fallback after an abort
  await tick()
  assert.equal(calls.filter((c) => c.kind === 'get').length, 0)
  // A later read fetches afresh
  const p4 = store.getRange('/s', range2)
  assert.equal(calls.length, 3)
  calls[2].resolveData()
  assert.equal((await p4).byteLength, 10)
})

test('the access listener gets the range key with each caller options', async () => {
  const { base, calls } = rangeBase({ sizes: { '/s': 100 } })
  const store = rangeStore(base)
  const seen = []
  store.addAccessListener((k, opts) =>
    seen.push([k, opts?.signal ?? null, store.has(k)])
  )
  const s1 = new AbortController().signal
  const p1 = store.getRange('/s', { offset: 0, length: 8 }, { signal: s1 })
  const p2 = store.getRange('/s', { offset: 0, length: 8 })
  calls[0].resolveData()
  await Promise.all([p1, p2])
  assert.deepEqual(
    seen.map(([k, s, resident]) => [k, s === s1 ? 's1' : '-', resident]).sort(),
    [
      [`/s${S}0:8`, '-', true],
      [`/s${S}0:8`, 's1', true],
    ]
  )
})

for (const mode of ['ignoreError', 'ignore']) {
  test(`a server ignoring Range (${mode}): the body becomes the whole-object entry and range mode turns off`, async (t) => {
    const warn = t.mock.method(console, 'warn', () => {})
    const { base, calls } = rangeBase({
      sizes: { '/s': 1000, '/t': 500 },
      mode,
      auto: true,
    })
    const store = rangeStore(base)
    const seen = []
    store.addAccessListener((k) => seen.push(k))
    const idx = await store.getRange('/s', { suffixLength: 20 })
    assert.deepEqual(idx, expectedSlice(1000, { suffixLength: 20 }))
    assert.equal(store.rangeRequests, false)
    assert.equal(warn.mock.callCount(), 1)
    // Cached whole, under the object key, counted once
    assert.ok(store.has('/s'))
    assert.equal(store.getEntryBytes('/s'), 1000)
    assert.equal(store.getTotalBytes(), 1000)
    assert.equal(store.size, 1)
    // Later ranges of it are sliced from the entry, attributed to the object
    const chunk = await store.getRange('/s', { offset: 30, length: 40 })
    assert.deepEqual(chunk, expectedSlice(1000, { offset: 30, length: 40 }))
    assert.equal(calls.length, 1)
    assert.deepEqual(seen, ['/s', '/s'])
    // Other objects are read whole with get() from now on
    const other = await store.getRange('/t', { offset: 0, length: 5 })
    assert.deepEqual(other, expectedSlice(500, { offset: 0, length: 5 }))
    assert.deepEqual(calls.at(-1).kind, 'get')
    assert.equal(store.getTotalBytes(), 1500)
  })
}

test('a 416 turns range mode off and reads the whole object', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const { base, calls } = rangeBase({
    sizes: { '/s': 1000 },
    mode: '416',
    auto: true,
  })
  const store = rangeStore(base)
  const seen = []
  store.addAccessListener((k) => seen.push(k))
  const r = await store.getRange('/s', { offset: 5, length: 5 })
  assert.deepEqual(r, expectedSlice(1000, { offset: 5, length: 5 }))
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['range', 'get']
  )
  assert.equal(store.rangeRequests, false)
  assert.equal(store.getEntryBytes('/s'), 1000)
  assert.deepEqual(seen, ['/s'])
})

const status = (code) => new Error(`Unexpected response status ${code} `)
const network = () => new TypeError('Failed to fetch')
const aborted = () => new DOMException('aborted', 'AbortError')

for (const [label, err] of [
  ['a 503', status(503)],
  ['a short read', new Error('Short read: expected 10 bytes but received 4')],
]) {
  test(`${label} is retried once, then thrown: never a whole-object GET`, async () => {
    const { base, calls } = rangeBase({
      sizes: { '/s': 1000 },
      fail: [err, err],
      auto: true,
    })
    const store = rangeStore(base)
    await assert.rejects(store.getRange('/s', { offset: 0, length: 5 }), err)
    assert.deepEqual(
      calls.map((c) => c.kind),
      ['range', 'range']
    )
    assert.equal(store.rangeRequests, true)
    assert.equal(store.size, 0)
    // The next read tries a range again
    const r = await store.getRange('/s', { offset: 0, length: 5 })
    assert.deepEqual(r, expectedSlice(1000, { offset: 0, length: 5 }))
    assert.equal(calls.at(-1).kind, 'range')
  })
}

test('a 429 (RangeRateLimitedError) is thrown at once: no retry, no whole GET', async () => {
  const err = new RangeRateLimitedError('/s')
  const { base, calls } = rangeBase({
    sizes: { '/s': 1000 },
    fail: [err],
    auto: true,
  })
  const store = rangeStore(base)
  await assert.rejects(store.getRange('/s', { offset: 0, length: 5 }), err)
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['range']
  )
  assert.equal(store.rangeRequests, true)
})

test('after a range has worked, a TypeError twice is a dropout: thrown, range mode stays on', async () => {
  const { base, calls } = rangeBase({ sizes: { '/s': 1000 }, auto: true })
  const store = rangeStore(base)
  await store.getRange('/s', { offset: 0, length: 5 })
  // The next two range calls fail at the network level
  const orig = base.getRange
  let failures = 2
  base.getRange = (...args) =>
    failures-- > 0 ? Promise.reject(network()) : orig(...args)
  await assert.rejects(store.getRange('/s', { offset: 10, length: 5 }), {
    name: 'TypeError',
  })
  assert.equal(store.rangeRequests, true)
  assert.equal(calls.filter((c) => c.kind === 'get').length, 0)
  // Back online: ranges again
  const r = await store.getRange('/s', { offset: 10, length: 5 })
  assert.deepEqual(r, expectedSlice(1000, { offset: 10, length: 5 }))
  assert.equal(calls.at(-1).kind, 'range')
})

test('a transient error: the retry succeeds and is cached as a range', async () => {
  const { base, calls } = rangeBase({
    sizes: { '/s': 1000 },
    fail: [status(502)],
    auto: true,
  })
  const store = rangeStore(base)
  const r = await store.getRange('/s', { offset: 10, length: 5 })
  assert.deepEqual(r, expectedSlice(1000, { offset: 10, length: 5 }))
  assert.equal(calls.length, 2)
  assert.ok(store.has(`/s${S}10:5`))
})

test('a network failure (TypeError) once: the retry succeeds, range mode stays on', async () => {
  const { base, calls } = rangeBase({
    sizes: { '/s': 1000 },
    fail: [network()],
    auto: true,
  })
  const store = rangeStore(base)
  await store.getRange('/s', { offset: 0, length: 5 })
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['range', 'range']
  )
  assert.equal(store.rangeRequests, true)
})

test('a bare network failure (TypeError) twice on a fresh store is a dropout: thrown, range mode stays on', async () => {
  // e.g. offline at page load or right after a variable switch
  const { base, calls } = rangeBase({
    sizes: { '/s': 1000 },
    fail: [network(), network()],
    auto: true,
  })
  const store = rangeStore(base)
  await assert.rejects(store.getRange('/s', { offset: 0, length: 5 }), {
    name: 'TypeError',
  })
  assert.equal(store.rangeRequests, true)
  assert.equal(calls.filter((c) => c.kind === 'get').length, 0)
  // Back online: the next read is a range
  await store.getRange('/s', { offset: 0, length: 5 })
  assert.equal(calls.at(-1).kind, 'range')
})

test('many concurrent network failures: no whole GETs, no mode change', async () => {
  const n = 8
  const { base, calls } = rangeBase({
    sizes: { '/s': 100_000 },
    fail: Array.from({ length: 2 * n }, network),
    auto: true,
  })
  const store = rangeStore(base, 1_000_000)
  const reads = Array.from({ length: n }, (_, i) =>
    store.getRange('/s', { offset: i * 1000, length: 100 })
  )
  const results = await Promise.allSettled(reads)
  assert.ok(results.every((r) => r.status === 'rejected'))
  assert.equal(calls.filter((c) => c.kind === 'get').length, 0)
  assert.equal(calls.length, 2 * n, 'one retry each')
  assert.equal(store.rangeRequests, true)
})

test('repeated network failures before any range worked: one console.error, no mode change', async (t) => {
  const error = t.mock.method(console, 'error', () => {})
  const N = RANGE_NETWORK_FAILURES_BEFORE_ERROR
  const { base, calls } = rangeBase({
    sizes: { '/s': 100_000 },
    fail: Array.from({ length: 2 * N }, network),
    auto: true,
  })
  const store = rangeStore(base, 1_000_000)
  for (let i = 0; i < N; i++) {
    await store
      .getRange('/s', { offset: i * 1000, length: 100 })
      .catch(() => {})
  }
  assert.equal(error.mock.callCount(), 1, 'logged once')
  assert.match(
    String(error.mock.calls[0].arguments[0]),
    /Range reads are failing.*may\s+not allow the Range header.*rangeRequests off/s
  )
  assert.equal(store.rangeRequests, true)
  assert.equal(calls.filter((c) => c.kind === 'get').length, 0)
})

test('network failures after a range worked never log the misconfiguration error', async (t) => {
  const error = t.mock.method(console, 'error', () => {})
  const N = RANGE_NETWORK_FAILURES_BEFORE_ERROR
  const { base } = rangeBase({ sizes: { '/s': 100_000 }, auto: true })
  const store = rangeStore(base, 1_000_000)
  await store.getRange('/s', { offset: 0, length: 100 })
  const orig = base.getRange
  base.getRange = () => Promise.reject(network())
  for (let i = 1; i <= N; i++) {
    await store
      .getRange('/s', { offset: i * 1000, length: 100 })
      .catch(() => {})
  }
  base.getRange = orig
  assert.equal(error.mock.callCount(), 0)
})

test('when the whole-object fallback fails too, its error reaches the caller', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const { base, calls } = rangeBase({ sizes: { '/s': 1000 }, mode: '416' })
  const store = rangeStore(base)
  const p = store.getRange('/s', { offset: 0, length: 5 })
  calls[0].resolveData()
  await tick()
  calls[1].reject(new Error('still down'))
  await assert.rejects(p, /still down/)
  assert.equal(store.size, 0)
})

test('an AbortError the read did not ask for (a shared lower-level request) is retried', async () => {
  const { base, calls } = rangeBase({
    sizes: { '/s': 1000 },
    fail: [aborted()],
    auto: true,
  })
  const store = rangeStore(base)
  const signal = new AbortController().signal
  const r = await store.getRange('/s', { offset: 0, length: 5 }, { signal })
  assert.deepEqual(r, expectedSlice(1000, { offset: 0, length: 5 }))
  assert.equal(calls.length, 2)
})

test("a shard-index (suffix) read is not cancelled by its caller's abort", async () => {
  const { base, calls } = rangeBase({ sizes: { '/s': 1000 } })
  const store = rangeStore(base)
  const c = new AbortController()
  const p = store.getRange('/s', { suffixLength: 16 }, { signal: c.signal })
  c.abort()
  await tick()
  assert.equal(calls[0].signal.aborted, false)
  calls[0].resolveData()
  // The caller still gets it (zarrita shares it with other chunk reads)
  assert.equal((await p).byteLength, 16)
  assert.ok(store.has(`/s${S}suffix:16`))
})

test('a missing object reads undefined and is not cached', async () => {
  const { base } = rangeBase({ sizes: {}, auto: true })
  const store = rangeStore(base)
  assert.equal(await store.getRange('/nope', { suffixLength: 4 }), undefined)
  assert.equal(store.size, 0)
})

test('an object cached whole serves ranges without range requests', async () => {
  const { base, calls } = rangeBase({ sizes: { '/s': 1000 }, auto: true })
  const store = rangeStore(base)
  await store.get('/s')
  const seen = []
  store.addAccessListener((k) => seen.push(k))
  const r = await store.getRange('/s', { suffixLength: 10 })
  assert.deepEqual(r, expectedSlice(1000, { suffixLength: 10 }))
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['get']
  )
  assert.deepEqual(seen, ['/s'])
})

test('caching the whole object drops its range entries (no double counting)', async () => {
  const { base } = rangeBase({ sizes: { '/s': 1000, '/t': 1000 }, auto: true })
  const store = rangeStore(base)
  await store.getRange('/s', { suffixLength: 20 })
  await store.getRange('/s', { offset: 0, length: 100 })
  await store.getRange('/t', { offset: 0, length: 100 })
  assert.equal(store.getTotalBytes(), 220)
  await store.get('/s')
  assert.deepEqual([...store.cache.keys()].sort(), ['/s', `/t${S}0:100`])
  assert.equal(store.getTotalBytes(), 1100)
})

test('range entries are counted and evicted one by one (LRU)', async () => {
  const { base } = rangeBase({ sizes: { '/s': 10_000 }, auto: true })
  const store = rangeStore(base, 300)
  await store.getRange('/s', { offset: 0, length: 100 })
  await store.getRange('/s', { offset: 100, length: 100 })
  await store.getRange('/s', { offset: 200, length: 100 })
  assert.equal(store.getTotalBytes(), 300)
  // Touch the first; the next fill evicts the second (least recent)
  await store.getRange('/s', { offset: 0, length: 100 })
  await store.getRange('/s', { offset: 300, length: 100 })
  assert.equal(store.getTotalBytes(), 300)
  assert.ok(store.has(`/s${S}0:100`))
  assert.ok(!store.has(`/s${S}100:100`))
  assert.ok(store.has(`/s${S}200:100`))
  assert.ok(store.has(`/s${S}300:100`))
  // Shrinking the budget evicts range entries too
  store.setMaxBytes(100)
  assert.equal(store.getTotalBytes(), 100)
  assert.deepEqual([...store.cache.keys()], [`/s${S}300:100`])
})

test('without getRange on the base store, or by default, getRange reads whole objects', async () => {
  const { base, calls } = rangeBase({ sizes: { '/s': 100 }, auto: true })
  const noRange = { get: base.get }
  const s1 = new CachingStore(noRange, 10_000, { rangeRequests: true })
  assert.equal(s1.rangeRequests, false)
  await s1.getRange('/s', { offset: 0, length: 4 })
  const s2 = new CachingStore(base, 10_000)
  assert.equal(s2.rangeRequests, false)
  await s2.getRange('/s', { offset: 0, length: 4 })
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['get', 'get']
  )
})

// ---- step attribution, cache status and the per-step estimate ----

// A layer over a range-mode CachingStore. Each step reads its inner chunks
// (offset ranges) of a shard, after the shard index (a suffix range) the
// first time the shard is read, like zarrita's sharded reads (it keeps
// decoded indexes itself), with the prefetch request's signal.
function rangeLayer({ maxBytes = 100_000, chunksFor }) {
  const layer = new ZarrLayer({
    id: 'test',
    source: 'http://example.invalid/store.zarr',
    variable: 'v',
    clim: [0, 1],
    colormap: ['#000000', '#ffffff'],
    selector: { time: { selected: 0, type: 'index' } },
  })
  const { base, calls } = rangeBase({
    sizes: { '/v/c/0': 10_000, '/v/c/1': 10_000 },
    auto: true,
  })
  const store = new CachingStore(base, maxBytes, { rangeRequests: true })
  store.addAccessListener((key, opts) => layer.attributeChunkAccess(key, opts))
  layer.zarrStore = { cachingStore: store }
  const indexRead = new Set()
  layer.mode = {
    setSelector: async () => {},
    dispose() {},
    async prefetchTimeSteps(indices, dim, signal) {
      const { shard, ranges } = chunksFor(indices[0])
      if (!indexRead.has(shard)) {
        await store.getRange(shard, { suffixLength: 36 }, { signal })
        indexRead.add(shard)
      }
      await Promise.all(ranges.map((r) => store.getRange(shard, r, { signal })))
      return true
    },
  }
  const fetchStep = async (idx) => {
    layer.prefetchTimeSteps([idx])
    for (let i = 0; i < 5; i++) await tick()
  }
  return { layer, store, calls, fetchStep }
}

test('range entries are attributed to steps: cached, partial after eviction, estimate', async () => {
  // Steps 0 and 1 share shard 0 (index read once, by step 0 only)
  const chunksFor = (idx) => ({
    shard: '/v/c/0',
    ranges: [
      { offset: idx * 1000, length: 400 },
      { offset: idx * 1000 + 400, length: 400 },
    ],
  })
  const { layer, store, calls, fetchStep } = rangeLayer({ chunksFor })
  await fetchStep(0)
  await fetchStep(1)
  assert.deepEqual(layer.getCacheStatus([0, 1, 2]), {
    0: 'cached',
    1: 'cached',
    2: 'missing',
  })
  // Only the ranges went over the network: the index, then 2 chunks per step
  assert.equal(calls.length, 5)
  assert.equal(store.getTotalBytes(), 36 + 4 * 400)
  const keys0 = [
    ...layer.timestepKeys.get(layer.stepKey(0, layer.currentSelection())).keys,
  ]
  assert.deepEqual(keys0.sort(), [
    `/v/c/0${S}0:400`,
    `/v/c/0${S}400:400`,
    `/v/c/0${S}suffix:36`,
  ])
  // The estimate uses each step's own range bytes (index shared: step 0 only
  // read it here, so it counts for step 0)
  assert.equal(layer.getEstimatedTimestepBytes(), (836 + 800) / 2)
  // Evicting one of step 1's chunks makes it partial
  store.cache.delete(`/v/c/0${S}1000:400`)
  store.totalBytes -= 400
  assert.deepEqual(layer.getCacheStatus([0, 1]), { 0: 'cached', 1: 'partial' })
})

test('after a range fallback, steps are attributed to the whole object as before', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const chunksFor = (idx) => ({
    shard: '/v/c/0',
    ranges: [{ offset: idx * 1000, length: 400 }],
  })
  const { layer, store, calls, fetchStep } = rangeLayer({ chunksFor })
  // The server starts ignoring Range
  const base = store.baseStore
  const origRange = base.getRange
  base.getRange = (key, range, opts) =>
    origRange(key, range, opts).then(() => objectBytes(10_000))
  await fetchStep(0)
  await fetchStep(1)
  assert.equal(store.rangeRequests, false)
  assert.deepEqual(layer.getCacheStatus([0, 1]), { 0: 'cached', 1: 'cached' })
  assert.deepEqual([...store.cache.keys()], ['/v/c/0'])
  // One range request answered whole, then slices of the entry
  assert.equal(calls.length, 1)
  // The whole object splits between the two steps that read it
  assert.equal(layer.getEstimatedTimestepBytes(), 5000)
})
