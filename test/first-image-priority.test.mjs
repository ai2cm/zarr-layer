// ace-viz task 49 (time to first image): the request gate serves render
// reads before background (prefetch) reads, keeps RENDER_RESERVE tokens for
// them, and prefetch resumes once the render reads are out. Prefetch reads
// are marked by the CachingStore (background classifier) with a header that
// gatedFetch strips. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as zarr from 'zarrita'
import { loadSrc } from './load-src.mjs'

const { RequestGate, gatedFetch, RENDER_RESERVE } = await loadSrc(
  'src/request-gate.ts'
)
const { CachingStore, BACKGROUND_REQUEST_HEADER } = await loadSrc(
  'src/caching-store.ts'
)
const { withRangeCoalescing } = await loadSrc('src/range-coalescing.ts')

const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
// Advance mocked time in 100 ms steps, letting the gate's timers re-arm
async function advance(t, ms) {
  for (let left = ms; left > 0; left -= 100) {
    t.mock.timers.tick(Math.min(100, left))
    await flush()
  }
}

test('gate: on a cold start, render requests go before queued background ones', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const gate = new RequestGate({ maxRequestsPerSecond: 5, burst: 1 })
  await gate.acquire() // metadata read: the bucket is empty now
  const got = []
  for (let i = 0; i < 4; i++)
    gate.acquire(undefined, { background: true }).then(() => got.push(`p${i}`))
  for (let i = 0; i < 2; i++) gate.acquire().then(() => got.push(`r${i}`))
  await flush()
  assert.deepEqual(got, [])
  await advance(t, 400)
  assert.deepEqual(got, ['r0', 'r1'], 'render first, FIFO within the lane')
  await advance(t, 800)
  assert.deepEqual(got, ['r0', 'r1', 'p0', 'p1', 'p2', 'p3'])
})

test('gate: background requests leave RENDER_RESERVE tokens for render reads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  assert.equal(RENDER_RESERVE, 2)
  const gate = new RequestGate({ maxRequestsPerSecond: 5, burst: 10 })
  let bg = 0
  for (let i = 0; i < 20; i++)
    gate.acquire(undefined, { background: true }).then(() => bg++)
  await flush()
  assert.equal(bg, 8, 'burst minus the reserve')
  let render = 0
  for (let i = 0; i < 3; i++) gate.acquire().then(() => render++)
  await flush()
  assert.equal(render, 2, 'the reserve goes out at once')
  t.mock.timers.tick(200)
  await flush()
  assert.equal(render, 3, 'the next token goes to the render read')
  assert.equal(bg, 8)
})

test('gate: prefetch resumes at the cap once the render reads are out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const gate = new RequestGate({ maxRequestsPerSecond: 5, burst: 3 })
  // First frame: three render reads use the whole bucket
  for (let i = 0; i < 3; i++) await gate.acquire()
  let bg = 0
  for (let i = 0; i < 5; i++)
    gate.acquire(undefined, { background: true }).then(() => bg++)
  // Refill to 1 + RENDER_RESERVE tokens (600 ms), then one per 200 ms
  await advance(t, 500)
  assert.equal(bg, 0)
  await advance(t, 100)
  assert.equal(bg, 1)
  await advance(t, 800)
  assert.equal(bg, 5, 'paced at the rate after that')
})

test('gate: with no cap, background requests never wait; a 429 probe is a render read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const gate = new RequestGate({}, { random: () => 0.5 })
  for (let i = 0; i < 30; i++)
    await gate.acquire(undefined, { background: true })
  assert.equal(gate.stats.waited, 0)
  const first = await gate.acquire()
  gate.done(first, 'rate-limited')
  const got = []
  gate.acquire(undefined, { background: true }).then(() => got.push('p'))
  gate.acquire().then(() => got.push('r'))
  t.mock.timers.tick(2000)
  await flush()
  assert.deepEqual(got, ['r'], 'the render read is the probe')
})

test('gatedFetch: the background marker picks the lane and is never sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const gate = new RequestGate({ maxRequestsPerSecond: 5, burst: 1 })
  await gate.acquire()
  const sent = []
  const f = gatedFetch(
    async (request) => {
      sent.push({
        url: request.url,
        marked: request.headers.has(BACKGROUND_REQUEST_HEADER),
        range: request.headers.get('Range'),
      })
      return new Response('x', { status: 206 })
    },
    () => gate
  )
  const bg = f(
    new Request('http://h.invalid/bg', {
      headers: { [BACKGROUND_REQUEST_HEADER]: '1', Range: 'bytes=0-1' },
    })
  )
  const render = f(new Request('http://h.invalid/render'))
  await advance(t, 1000)
  await Promise.all([bg, render])
  assert.deepEqual(sent, [
    { url: 'http://h.invalid/render', marked: false, range: null },
    { url: 'http://h.invalid/bg', marked: false, range: 'bytes=0-1' },
  ])
})

// A CachingStore over FetchStore -> coalescing -> gatedFetch, like
// createFetchStore builds, with a stub network
function gatedStack({ markBackground = true, gate }) {
  const sent = []
  const fetchStore = new zarr.FetchStore('http://h.invalid/s.zarr', {
    fetch: gatedFetch(
      async (request) => {
        sent.push({
          path: new URL(request.url).pathname,
          range: request.headers.get('Range'),
          marked: request.headers.has(BACKGROUND_REQUEST_HEADER),
        })
        const m = /bytes=(\d+)-(\d+)/.exec(request.headers.get('Range') ?? '')
        const n = m ? +m[2] - +m[1] + 1 : 8
        return new Response(new Uint8Array(n), { status: m ? 206 : 200 })
      },
      () => gate
    ),
  })
  const base = withRangeCoalescing(fetchStore)
  const store = new CachingStore(base, 1e6, {
    rangeRequests: true,
    markBackground,
    retryDelayMs: () => 0,
  })
  const prefetch = new AbortController().signal
  store.setBackgroundClassifier((opts) => opts?.signal === prefetch)
  return { store, sent, prefetch }
}

test('CachingStore: prefetch reads take the background lane through FetchStore and coalescing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const gate = new RequestGate({ maxRequestsPerSecond: 5, burst: 1 })
  await gate.acquire()
  const { store, sent, prefetch } = gatedStack({ gate })
  // A prefetch read issued first (far from the render read: not merged),
  // then the render read and a whole-object render get
  const p = store.getRange(
    '/v/c/1',
    { offset: 0, length: 4 },
    { signal: prefetch }
  )
  const r = store.getRange('/v/c/0', { offset: 0, length: 4 })
  const g = store.get('/v/zarr.json')
  // Let the coalescing flush (a macrotask) reach the gate; the bucket is
  // still empty, so all three wait
  for (let i = 0; i < 5; i++) await new Promise((res) => setImmediate(res))
  assert.equal(gate.pending, 3)
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(100)
    await new Promise((res) => setImmediate(res))
  }
  await Promise.all([p, r, g])
  assert.deepEqual(
    sent.map((s) => s.path),
    ['/s.zarr/v/zarr.json', '/s.zarr/v/c/0', '/s.zarr/v/c/1'],
    'render reads first although the prefetch read was issued first'
  )
  assert.ok(
    sent.every((s) => !s.marked),
    'the marker never reaches the network'
  )
})

test('coalescing: a merged request is background only when every member is', async () => {
  const seen = []
  const base = {
    async get() {
      return undefined
    },
    async getRange(_key, range, opts) {
      seen.push(!!opts?.headers?.[BACKGROUND_REQUEST_HEADER])
      return new Uint8Array(range.length)
    },
  }
  const store = withRangeCoalescing(base)
  const bg = { headers: { [BACKGROUND_REQUEST_HEADER]: '1' } }
  await Promise.all([
    store.getRange('/a', { offset: 0, length: 4 }, bg),
    store.getRange('/a', { offset: 4, length: 4 }, bg),
  ])
  await Promise.all([
    store.getRange('/a', { offset: 0, length: 4 }, bg),
    store.getRange('/a', { offset: 4, length: 4 }),
  ])
  assert.deepEqual(seen, [true, false])
})

test('CachingStore: no marker without markBackground (a custom store would send it)', async () => {
  const seen = []
  const base = {
    async get(_key, opts) {
      seen.push(opts?.headers?.[BACKGROUND_REQUEST_HEADER] ?? null)
      return new Uint8Array(4)
    },
  }
  const prefetch = new AbortController().signal
  for (const markBackground of [false, true]) {
    const store = new CachingStore(base, 1e6, { markBackground })
    store.setBackgroundClassifier((opts) => opts?.signal === prefetch)
    await store.get('/a', { signal: prefetch })
    await store.get('/b')
  }
  assert.deepEqual(seen, [null, null, '1', null])
})

// Review round 1: the ZarrLayer wiring (attachCachingStore) tags a real
// prefetch step's reads as background and leaves render reads alone
test("ZarrLayer: a prefetch step's reads carry the background marker; render reads do not", async () => {
  const { ZarrLayer } = await loadSrc('src/zarr-layer.ts')
  const layer = new ZarrLayer({
    id: 'test',
    source: 'http://example.invalid/store.zarr',
    variable: 'v',
    clim: [0, 1],
    colormap: ['#000000', '#ffffff'],
    selector: { time: { selected: 0, type: 'index' } },
  })
  const seen = []
  const base = {
    async get(key, opts) {
      seen.push({ key, marked: !!opts?.headers?.[BACKGROUND_REQUEST_HEADER] })
      return new Uint8Array(100)
    },
  }
  const store = new CachingStore(base, 1e6, { markBackground: true })
  layer.zarrStore = { cachingStore: store }
  layer.attachCachingStore(store)
  layer.mode = {
    setSelector: async () => {},
    dispose() {},
    // Like untiled mode: the step's reads go through the store with the
    // step's signal
    async prefetchTimeSteps(indices, _dim, signal) {
      await store.get(`/v/c/${indices[0]}/0`, { signal })
      return true
    },
  }
  layer.prefetchTimeSteps([3])
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  // A render read of the displayed step: zarrita passes its own signal
  await store.get('/v/c/0/0', { signal: new AbortController().signal })
  await store.get('/v/c/0/1')
  assert.deepEqual(seen, [
    { key: '/v/c/3/0', marked: true },
    { key: '/v/c/0/0', marked: false },
    { key: '/v/c/0/1', marked: false },
  ])
})

// setBackgroundReads (ace-viz task 35): a hidden "hot" layer puts its render
// reads in the background lane too
function makeLayer(ZarrLayer, extra = {}) {
  return new ZarrLayer({
    id: 'test',
    source: 'http://example.invalid/store.zarr',
    variable: 'v',
    clim: [0, 1],
    colormap: ['#000000', '#ffffff'],
    selector: { time: { selected: 0, type: 'index' } },
    ...extra,
  })
}

test('ZarrLayer: backgroundReads marks render reads; turning it off unmarks them; prefetch stays background', async () => {
  const { ZarrLayer } = await loadSrc('src/zarr-layer.ts')
  const layer = makeLayer(ZarrLayer, { backgroundReads: true })
  const seen = []
  const base = {
    async get(key, opts) {
      seen.push(
        `${key}:${opts?.headers?.[BACKGROUND_REQUEST_HEADER] ? 'bg' : 'render'}`
      )
      return new Uint8Array(100)
    },
  }
  const store = new CachingStore(base, 1e6, { markBackground: true })
  layer.zarrStore = { cachingStore: store }
  layer.attachCachingStore(store)
  let step = 0
  layer.mode = {
    setSelector: async () => {},
    dispose() {},
    async prefetchTimeSteps(indices, _dim, signal) {
      await store.get(`/v/c/${indices[0]}/${step}`, { signal })
      return true
    },
  }
  const prefetchOnce = async (i) => {
    layer.prefetchTimeSteps([i])
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  }
  await prefetchOnce(3)
  await store.get('/v/c/0/0', { signal: new AbortController().signal })
  await store.get('/v/c/0/1') // no signal
  layer.setBackgroundReads(false)
  step = 1
  await prefetchOnce(4)
  await store.get('/v/c/0/2', { signal: new AbortController().signal })
  await store.get('/v/c/0/3')
  layer.setBackgroundReads(true)
  await store.get('/v/c/0/4')
  assert.deepEqual(seen, [
    '/v/c/3/0:bg',
    '/v/c/0/0:bg',
    '/v/c/0/1:bg',
    '/v/c/4/1:bg',
    '/v/c/0/2:render',
    '/v/c/0/3:render',
    '/v/c/0/4:bg',
  ])
})

test("ZarrLayer: with a capped gate, a background-reads layer's render reads wait behind a visible layer's and keep the reserve", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { ZarrLayer } = await loadSrc('src/zarr-layer.ts')
  const gate = new RequestGate({ maxRequestsPerSecond: 5, burst: 4 })
  const sent = []
  const fetchStore = new zarr.FetchStore('http://h.invalid/s.zarr', {
    fetch: gatedFetch(
      async (request) => {
        sent.push(new URL(request.url).pathname.replace('/s.zarr', ''))
        const m = /bytes=(\d+)-(\d+)/.exec(request.headers.get('Range') ?? '')
        return new Response(new Uint8Array(+m[2] - +m[1] + 1), { status: 206 })
      },
      () => gate
    ),
  })
  // One shared fetch store (as the store cache gives two layers on one
  // source), one CachingStore per layer
  const base = withRangeCoalescing(fetchStore)
  const stack = (backgroundReads) => {
    const layer = makeLayer(ZarrLayer, { backgroundReads })
    const store = new CachingStore(base, 1e6, {
      rangeRequests: true,
      markBackground: true,
      retryDelayMs: () => 0,
    })
    layer.zarrStore = { cachingStore: store }
    layer.attachCachingStore(store)
    return store
  }
  const hidden = stack(true)
  const visible = stack(false)
  const range = { offset: 0, length: 4 }
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  }
  // Full bucket (4 tokens): the hidden layer's render reads leave 2 for
  // render reads, so only 2 of its 4 go
  const reads = []
  for (let i = 0; i < 4; i++) reads.push(hidden.getRange(`/h/${i}`, range))
  await settle()
  assert.deepEqual(sent, ['/h/0', '/h/1'], 'the reserve is kept')
  // The visible layer's render reads take the reserve at once and queue
  // ahead of the hidden layer's
  for (let i = 0; i < 3; i++) reads.push(visible.getRange(`/v/${i}`, range))
  await settle()
  assert.deepEqual(sent, ['/h/0', '/h/1', '/v/0', '/v/1'])
  // Next token (200 ms) goes to the visible read; the hidden ones then need
  // 1 + RENDER_RESERVE tokens
  t.mock.timers.tick(200)
  await settle()
  assert.deepEqual(sent.slice(4), ['/v/2'])
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(100)
    await settle()
  }
  await Promise.all(reads)
  assert.deepEqual(sent.slice(5), ['/h/2', '/h/3'])
})
