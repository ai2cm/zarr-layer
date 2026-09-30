// Range reads over HTTP semantics: zarrita's FetchStore wrapped like
// createFetchStore does in range mode (suffix requests, checkRangeResponses)
// under a range-mode CachingStore, against a fake server that honours,
// ignores or rejects Range. Loaded from src via esbuild. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as zarr from 'zarrita'
import { loadSrc } from './load-src.mjs'

const { checkRangeResponses } = await loadSrc('src/zarr-store.ts')
const { CachingStore } = await loadSrc('src/caching-store.ts')

const SIZE = 1000
const body = Uint8Array.from({ length: SIZE }, (_, i) => i % 251)

// `mode`: 'honor' (206 with Content-Range), 'ignore' (200, whole body), '416'
function fakeServer(mode) {
  const requests = []
  const fetch = async (request) => {
    const range = request.headers.get('Range')
    requests.push({ method: request.method, range })
    if (!range || mode === 'ignore') {
      return new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers: { 'Content-Length': String(SIZE) },
      })
    }
    if (mode === '416') return new Response('no', { status: 416 })
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    const [start, end] =
      m[1] === ''
        ? [SIZE - Number(m[2]), SIZE - 1]
        : [Number(m[1]), Number(m[2])]
    return new Response(body.slice(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${SIZE}` },
    })
  }
  return { fetch, requests }
}

const makeStore = (server) =>
  new CachingStore(
    new zarr.FetchStore('http://example.invalid/s.zarr', {
      useSuffixRequest: true,
      fetch: checkRangeResponses(server.fetch),
    }),
    100_000,
    { rangeRequests: true }
  )

test('a Range-honouring server: one suffix request for the index, one range per chunk', async () => {
  const server = fakeServer('honor')
  const store = makeStore(server)
  const idx = await store.getRange('/v/c/0', { suffixLength: 16 })
  assert.deepEqual(idx, body.slice(SIZE - 16))
  const chunk = await store.getRange('/v/c/0', { offset: 100, length: 50 })
  assert.deepEqual(chunk, body.slice(100, 150))
  assert.deepEqual(server.requests, [
    { method: 'GET', range: 'bytes=-16' },
    { method: 'GET', range: 'bytes=100-149' },
  ])
  assert.equal(store.getTotalBytes(), 66)
  assert.equal(store.rangeRequests, true)
})

test('a Range-dropping proxy (200): the first body is kept whole, no second download', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const server = fakeServer('ignore')
  const store = makeStore(server)
  const idx = await store.getRange('/v/c/0', { suffixLength: 16 })
  assert.deepEqual(idx, body.slice(SIZE - 16))
  const chunk = await store.getRange('/v/c/0', { offset: 100, length: 50 })
  assert.deepEqual(chunk, body.slice(100, 150))
  assert.equal(server.requests.length, 1)
  assert.equal(store.getEntryBytes('/v/c/0'), SIZE)
  assert.equal(store.rangeRequests, false)
  // Other objects: plain GETs
  await store.getRange('/v/c/1', { offset: 0, length: 10 })
  assert.deepEqual(server.requests.at(-1), { method: 'GET', range: null })
})

test('a server rejecting Range (416): full GET, then whole objects', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const server = fakeServer('416')
  const store = makeStore(server)
  const chunk = await store.getRange('/v/c/0', { offset: 100, length: 50 })
  assert.deepEqual(chunk, body.slice(100, 150))
  assert.deepEqual(server.requests, [
    { method: 'GET', range: 'bytes=100-149' },
    { method: 'GET', range: null },
  ])
  assert.equal(store.rangeRequests, false)
})

test('checkRangeResponses passes requests without Range through untouched', async () => {
  const server = fakeServer('ignore')
  const f = checkRangeResponses(server.fetch)
  const res = await f(new Request('http://example.invalid/x'))
  assert.equal(res.status, 200)
})

// ---- the real range-mode stack: createFetchStore + withRangeCoalescing ----

const { createFetchStore } = await loadSrc('src/zarr-store.ts')
const { withRangeCoalescing } = await loadSrc('src/range-coalescing.ts')

// globalThis.fetch answering ranges of `body` after `delayMs`, honouring
// the request's signal. `statusFor(n)` can force a status for request n.
function stubGlobalFetch({ delayMs = 20, statusFor = () => null } = {}) {
  const requests = []
  const original = globalThis.fetch
  globalThis.fetch = (request) => {
    const n = requests.length
    const entry = { range: request.headers.get('Range'), aborted: false }
    requests.push(entry)
    return new Promise((resolve, reject) => {
      const signal = request.signal
      const timer = setTimeout(() => {
        const forced = statusFor(n)
        if (forced) return resolve(new Response(null, { status: forced }))
        const m = /^bytes=(\d*)-(\d*)$/.exec(entry.range)
        const [start, end] =
          m[1] === ''
            ? [SIZE - Number(m[2]), SIZE - 1]
            : [Number(m[1]), Number(m[2])]
        resolve(new Response(body.slice(start, end + 1), { status: 206 }))
      }, delayMs)
      signal?.addEventListener('abort', () => {
        entry.aborted = true
        clearTimeout(timer)
        reject(new DOMException('aborted', 'AbortError'))
      })
    })
  }
  return { requests, restore: () => (globalThis.fetch = original) }
}

async function realStack() {
  const base = await zarr.extendStore(
    createFetchStore('http://example.invalid/s.zarr', undefined, true),
    (s) => withRangeCoalescing(s)
  )
  return new CachingStore(base, 100_000, { rangeRequests: true })
}

test('real stack: adjacent ranges read together go out as one coalesced request', async () => {
  const net = stubGlobalFetch()
  try {
    const store = await realStack()
    const [a, b] = await Promise.all([
      store.getRange('/v/c/0', { offset: 0, length: 100 }),
      store.getRange('/v/c/0', { offset: 100, length: 100 }),
    ])
    assert.deepEqual(a, body.slice(0, 100))
    assert.deepEqual(b, body.slice(100, 200))
    assert.deepEqual(
      net.requests.map((r) => r.range),
      ['bytes=0-199']
    )
    assert.equal(store.size, 2)
  } finally {
    net.restore()
  }
})

test('real stack: aborting one coalesced read does not fail its sibling', async () => {
  const net = stubGlobalFetch()
  try {
    const store = await realStack()
    const a = new AbortController()
    const b = new AbortController()
    const pa = store.getRange(
      '/v/c/0',
      { offset: 0, length: 100 },
      { signal: a.signal }
    )
    const pb = store.getRange(
      '/v/c/0',
      { offset: 100, length: 100 },
      { signal: b.signal }
    )
    setTimeout(() => a.abort(), 5)
    await assert.rejects(pa, { name: 'AbortError' })
    assert.deepEqual(await pb, body.slice(100, 200))
    assert.equal(net.requests.length, 1)
    assert.equal(net.requests[0].aborted, false)
  } finally {
    net.restore()
  }
})

test('real stack: when every read of a group aborts, the request is cancelled', async () => {
  const net = stubGlobalFetch()
  try {
    const store = await realStack()
    const a = new AbortController()
    const b = new AbortController()
    const pa = store.getRange(
      '/v/c/0',
      { offset: 0, length: 100 },
      { signal: a.signal }
    )
    const pb = store.getRange(
      '/v/c/0',
      { offset: 100, length: 100 },
      { signal: b.signal }
    )
    setTimeout(() => {
      a.abort()
      b.abort()
    }, 5)
    await assert.rejects(pa, { name: 'AbortError' })
    await assert.rejects(pb, { name: 'AbortError' })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(net.requests[0].aborted, true)
    assert.equal(store.size, 0)
  } finally {
    net.restore()
  }
})

test('real stack: a 503 is retried once, then thrown; no whole-object GET', async () => {
  const net = stubGlobalFetch({ statusFor: () => 503 })
  try {
    const store = await realStack()
    await assert.rejects(
      store.getRange('/v/c/0', { offset: 0, length: 100 }),
      /503/
    )
    assert.deepEqual(
      net.requests.map((r) => r.range),
      ['bytes=0-99', 'bytes=0-99']
    )
    assert.equal(store.rangeRequests, true)
  } finally {
    net.restore()
  }
})

test('real stack: a 429 is thrown at once, not retried', async () => {
  const net = stubGlobalFetch({ statusFor: () => 429 })
  try {
    const store = await realStack()
    await assert.rejects(store.getRange('/v/c/0', { offset: 0, length: 100 }), {
      name: 'RangeRateLimitedError',
    })
    assert.equal(net.requests.length, 1)
  } finally {
    net.restore()
  }
})

test('real stack: a network dropout after ranges worked keeps range mode (no whole GET)', async () => {
  let offline = false
  const net = stubGlobalFetch()
  const online = globalThis.fetch
  globalThis.fetch = (request) =>
    offline
      ? (net.requests.push({ range: request.headers.get('Range') }),
        Promise.reject(new TypeError('Failed to fetch')))
      : online(request)
  try {
    const store = await realStack()
    await store.getRange('/v/c/0', { offset: 0, length: 100 })
    offline = true
    await assert.rejects(
      store.getRange('/v/c/0', { offset: 200, length: 100 }),
      { name: 'TypeError' }
    )
    offline = false
    assert.equal(store.rangeRequests, true)
    const r = await store.getRange('/v/c/0', { offset: 200, length: 100 })
    assert.deepEqual(r, body.slice(200, 300))
    assert.ok(
      net.requests.every((q) => q.range !== null),
      'no whole GET'
    )
  } finally {
    net.restore()
  }
})

test('coalescing: a read aborted before the flush does not widen the group', async () => {
  const net = stubGlobalFetch()
  try {
    const store = await realStack()
    const a = new AbortController()
    const pa = store.getRange(
      '/v/c/0',
      { offset: 500, length: 100 },
      { signal: a.signal }
    )
    const pb = store.getRange('/v/c/0', { offset: 0, length: 100 })
    a.abort()
    await assert.rejects(pa, { name: 'AbortError' })
    assert.deepEqual(await pb, body.slice(0, 100))
    assert.deepEqual(
      net.requests.map((r) => r.range),
      ['bytes=0-99']
    )
  } finally {
    net.restore()
  }
})
