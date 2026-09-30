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
