// A small in-memory zarr v3 store with consolidated metadata, shaped like
// ace-viz's 3 km stores: `time`, `ensemble`, `latitude`, `longitude`
// coordinates and a sharded data variable `v` (time, ensemble, lat, lon) with
// an uncompressed `bytes` + `crc32c` shard index. Served over a fake HTTP
// `fetch` that logs every request and honours Range (suffix and byte ranges).
// Missing objects are 404. Used by the request-count tests (ace-viz task 52).

const enc = new TextEncoder()

let stores = 0

const bytesCodec = { name: 'bytes', configuration: { endian: 'little' } }

function coordMeta(name, n, dtype = 'float64') {
  return {
    zarr_format: 3,
    node_type: 'array',
    shape: [n],
    data_type: dtype,
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [n] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 0,
    codecs: [bytesCodec],
    attributes: {},
    dimension_names: [name],
  }
}

/**
 * @param {object} [opts]
 * @param {number} [opts.steps]  time steps (shards hold 4)
 * @param {string} [opts.base]  store URL (default: a new one per call, so
 *   zarr-layer's store cache, keyed by URL, never carries over)
 * @returns {{ base: string, objects: Map<string, Uint8Array>, rootMeta: object }}
 */
export function buildFakeV3Store({
  steps = 8,
  base = `http://example.invalid/store-${++stores}.zarr`,
} = {}) {
  const nLat = 4
  const nLon = 8
  const shard = [4, 1, nLat, nLon]
  const inner = [1, 1, 2, 4]
  const objects = new Map()
  const coords = {
    time: Float64Array.from({ length: steps }, (_, i) => i * 6),
    ensemble: Float64Array.from([0]),
    latitude: Float64Array.from({ length: nLat }, (_, i) => -45 + i * 30),
    longitude: Float64Array.from({ length: nLon }, (_, i) => -157.5 + i * 45),
  }
  const consolidated = {}
  for (const [name, values] of Object.entries(coords)) {
    consolidated[name] = coordMeta(name, values.length)
    objects.set(`${name}/c/0`, new Uint8Array(values.buffer))
  }
  consolidated.v = {
    zarr_format: 3,
    node_type: 'array',
    shape: [steps, 1, nLat, nLon],
    data_type: 'float32',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: shard } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 'NaN',
    codecs: [
      {
        name: 'sharding_indexed',
        configuration: {
          chunk_shape: inner,
          codecs: [bytesCodec],
          index_codecs: [bytesCodec, { name: 'crc32c' }],
          index_location: 'end',
        },
      },
    ],
    attributes: {},
    dimension_names: ['time', 'ensemble', 'latitude', 'longitude'],
  }
  // Shards: inner chunks back to back, then the index (offset, length pairs)
  // and a 4-byte checksum (zarrita does not verify it)
  const innerCount = shard.map((s, i) => s / inner[i])
  const nInner = innerCount.reduce((a, b) => a * b, 1)
  const innerBytes = inner.reduce((a, b) => a * b, 1) * 4
  for (let s = 0; s < Math.ceil(steps / shard[0]); s++) {
    const body = new Uint8Array(nInner * innerBytes + nInner * 16 + 4)
    const index = new BigUint64Array(nInner * 2)
    for (let i = 0; i < nInner; i++) {
      const chunk = new Float32Array(innerBytes / 4).fill(s * 100 + i)
      body.set(new Uint8Array(chunk.buffer), i * innerBytes)
      index[2 * i] = BigInt(i * innerBytes)
      index[2 * i + 1] = BigInt(innerBytes)
    }
    body.set(new Uint8Array(index.buffer), nInner * innerBytes)
    objects.set(`v/c/${s}/0/0/0`, body)
  }
  const rootMeta = {
    zarr_format: 3,
    node_type: 'group',
    attributes: {},
    consolidated_metadata: {
      kind: 'inline',
      must_understand: false,
      metadata: consolidated,
    },
  }
  objects.set('zarr.json', enc.encode(JSON.stringify(rootMeta)))
  return { base, objects, rootMeta }
}

/**
 * A fake `fetch` over `objects` (keys relative to `base`) that answers in
 * waves: requests wait until `wave()` releases every request pending at that
 * moment. So the requests of wave n could only be issued once wave n - 1 was
 * answered, and the number of waves before a request is the length of the
 * chain of dependent round trips it waited on. Each request is logged as
 * `{ key, range, wave }` (wave counted from 1) in `requests`.
 */
export function fakeFetch(base, objects) {
  const requests = []
  let pending = []
  let waveNo = 0
  const respond = (request, key) => {
    const body = objects.get(key)
    if (!body) return new Response(null, { status: 404 })
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { 'Content-Length': String(body.length) },
      })
    }
    const range = request.headers.get('Range')
    if (!range) return new Response(body.slice(), { status: 200 })
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    const size = body.length
    const [start, end] =
      m[1] === ''
        ? [size - Number(m[2]), size - 1]
        : [Number(m[1]), Number(m[2])]
    return new Response(body.slice(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${size}` },
    })
  }
  const fetch = (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const key = request.url.startsWith(`${base}/`)
      ? request.url.slice(base.length + 1)
      : request.url
    const entry = { key, range: request.headers.get('Range'), wave: waveNo + 1 }
    requests.push(entry)
    return new Promise((resolve) => {
      pending.push(() => resolve(respond(request, key)))
    })
  }
  const settle = () => new Promise((r) => setTimeout(r, 5))
  /** Let the client run, then answer every pending request. */
  const wave = async () => {
    await settle()
    const batch = pending
    pending = []
    waveNo++
    for (const answer of batch) answer()
    await settle()
    return batch.length
  }
  /** Answer waves until `promise` settles (or `max` waves). */
  const runUntil = async (promise, max = 20) => {
    let done = false
    const p = promise.finally(() => {
      done = true
    })
    for (let i = 0; i < max && !done; i++) await wave()
    return p
  }
  return { fetch, requests, wave, runUntil }
}
