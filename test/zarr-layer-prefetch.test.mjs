// ZarrLayer / UntiledMode prefetch primitives, loaded from src via esbuild.
// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc } from './load-src.mjs'

const { ZarrLayer } = await loadSrc('src/zarr-layer.ts')
const { UntiledMode } = await loadSrc('src/untiled-mode.ts')

const tick = () => new Promise((r) => setTimeout(r, 0))

// A layer with a fake mode and chunk cache. The mode's per-step fetch
// records the member it was fetched for and stays in flight until released
// (or aborted). On release it "reads" the step's chunks through the layer's
// access attribution, like CachingStore's listener does: `chunksFor(member,
// idx)` names them (default one chunk per member and step).
function fakeLayer({ chunksFor = (m, t) => [`m${m}/t${t}`] } = {}) {
  const layer = new ZarrLayer({
    id: 'test',
    source: 'http://example.invalid/store.zarr',
    variable: 'v',
    clim: [0, 1],
    colormap: ['#000000', '#ffffff'],
    selector: { time: 0, member: 0 },
  })
  const resident = new Set()
  const fetches = []
  layer.zarrStore = {
    cachingStore: {
      has: (k) => resident.has(k),
      maxBytes: 1000,
      getTotalBytes: () => resident.size * 10,
      get size() {
        return resident.size
      },
    },
  }
  layer.mode = {
    setSelector: async () => {},
    dispose() {},
    prefetchTimeSteps(indices, dim, signal) {
      const idx = indices[0]
      const member = layer.normalizedSelector.member.selected
      return new Promise((resolve) => {
        const entry = { idx, member, signal, aborted: false }
        // Like zarrita: every store access of this request carries its signal
        entry.release = () => {
          for (const key of chunksFor(member, idx)) {
            resident.add(key)
            layer.attributeChunkAccess(key, { signal })
          }
          resolve(true)
        }
        signal.addEventListener('abort', () => {
          entry.aborted = true
          resolve(true)
        })
        fetches.push(entry)
      })
    },
  }
  // Fetch one step for the current member and wait for it to land
  const fetchStep = async (idx) => {
    layer.prefetchTimeSteps([idx])
    await tick()
    fetches.at(-1).release()
    await tick()
  }
  return { layer, fetches, resident, fetchStep }
}

test('cache status is per member: B is prefetched, switching back to A needs no fetch', async () => {
  const { layer, fetches, fetchStep } = fakeLayer()
  await fetchStep(2) // member 0 (A)
  assert.equal(layer.isTimeStepCached(2), true)

  await layer.setSelector({ time: 0, member: 1 })
  assert.equal(
    layer.isTimeStepCached(2),
    false,
    "A's chunks must not count for B"
  )
  assert.deepEqual(layer.getCacheStatus([2]), { 2: 'missing' })

  await fetchStep(2)
  assert.deepEqual([fetches[1].idx, fetches[1].member], [2, 1])
  assert.equal(layer.isTimeStepCached(2), true)

  await layer.setSelector({ time: 0, member: 0 })
  assert.equal(layer.isTimeStepCached(2), true, "A's chunks are still resident")
  layer.prefetchTimeSteps([2])
  await tick()
  assert.equal(fetches.length, 2, 'no refetch for A')
})

test('chunks shared by members are recorded per member; eviction downgrades both', async () => {
  const { layer, fetches, resident, fetchStep } = fakeLayer({
    chunksFor: (m, t) => [`shared/t${t}`],
  })
  await fetchStep(3) // member 0
  await layer.setSelector({ time: 0, member: 1 })
  // Nothing recorded for member 1 yet, although the chunk is resident
  assert.equal(layer.isTimeStepCached(3), false)
  await fetchStep(3) // a cache hit in reality; records member 1's keys
  assert.equal(fetches.length, 2)
  assert.equal(layer.isTimeStepCached(3), true)

  resident.delete('shared/t3')
  assert.equal(layer.isTimeStepCached(3), false)
  await layer.setSelector({ time: 0, member: 0 })
  assert.equal(layer.isTimeStepCached(3), false)
})

test('time-only selector change keeps state and the queue', async () => {
  const { layer, fetches, fetchStep } = fakeLayer()
  await fetchStep(2)
  layer.prefetchTimeSteps([4, 5])
  await tick()
  await layer.setSelector({ time: 5, member: 0 })
  assert.equal(layer.isTimeStepCached(2), true)
  assert.equal(fetches.at(-1).aborted, false)
  assert.equal(fetches.at(-1).idx, 4)
  assert.deepEqual(layer.prefetchQueue.pendingIndices, [5])
})

test('member change aborts the in-flight step and drops the queue', async () => {
  const { layer, fetches } = fakeLayer()
  layer.prefetchTimeSteps([3, 4])
  await tick()
  assert.equal(fetches.length, 1)
  assert.equal(fetches[0].member, 0)

  await layer.setSelector({ time: 0, member: 1 })
  await tick()
  assert.equal(fetches[0].aborted, true)
  assert.equal(fetches.length, 1, 'step 4 (old member) must not start')
})

test('getCacheDebugInfo: byte fields from the cache, step fields for the current member', async () => {
  const { layer, fetchStep } = fakeLayer()
  await fetchStep(1)
  await fetchStep(2)
  await layer.setSelector({ time: 0, member: 1 })
  await fetchStep(1)
  const info = layer.getCacheDebugInfo()
  assert.equal(info.maxBytes, 1000)
  assert.equal(info.usedBytes, 30)
  assert.equal(info.chunksInCache, 3)
  assert.equal(info.timestepsRecorded, 1)
  assert.deepEqual(info.perTimestepHits, [
    { timeIndex: 1, recorded: 1, hits: 1 },
  ])
  assert.equal(info.avgChunksPerTimestep, 1)
})

test('a render access during an in-flight prefetch is recorded under the displayed step', async () => {
  const { layer, fetches, resident } = fakeLayer()
  // Displayed step: time index 0 (index selectors drive render attribution)
  await layer.setSelector({ time: { selected: 0, type: 'index' }, member: 0 })
  layer.prefetchTimeSteps([7])
  await tick()
  assert.equal(fetches.length, 1)
  // The map renders the displayed step (time 0) with its own request signal
  resident.add('m0/t0')
  layer.attributeChunkAccess('m0/t0', { signal: new AbortController().signal })
  // ...and an access without options (e.g. a metadata read)
  layer.attributeChunkAccess('m0/t0')
  fetches[0].release()
  await tick()
  assert.equal(layer.isTimeStepCached(0), true, 'displayed step recorded')
  const recorded = layer.getCacheDebugInfo().perTimestepHits
  assert.deepEqual(recorded, [
    { timeIndex: 0, recorded: 1, hits: 1 },
    { timeIndex: 7, recorded: 1, hits: 1 },
  ])
  // Evicting the displayed step's chunk must not downgrade step 7
  resident.delete('m0/t0')
  assert.equal(layer.isTimeStepCached(7), true)
})

test('prefetch waits while metadata loads (setVariable) and then fetches', async () => {
  const { layer, fetches } = fakeLayer()
  layer.metadataLoading = true // setVariable in progress; old mode still set
  layer.prefetchTimeSteps([2])
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(fetches.length, 0, 'must not fetch through the old mode')
  layer.metadataLoading = false
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(fetches.length, 1)
  assert.equal(fetches[0].idx, 2)
  fetches[0].release()
})

// UntiledMode.prefetchTimeSteps readiness contract, on a minimal fake `this`
function modeState(overrides) {
  return {
    zarrArray: { shape: [1, 1, 1] },
    baseSliceArgsReady: true,
    lastVisibleRegions: [],
    lastVisibleRegionsLevel: 0,
    currentLevelIndex: 0,
    regionSize: [1, 1],
    height: 1,
    width: 1,
    dimIndices: {},
    selector: {},
    ...overrides,
  }
}

async function runPrimitive(state) {
  const started = []
  const result = await UntiledMode.prototype.prefetchTimeSteps.call(
    state,
    [1],
    'time',
    new AbortController().signal,
    (i) => started.push(i)
  )
  return { result, started }
}

test('UntiledMode primitive: not ready until a visible-region pass ran for the current level', async () => {
  for (const overrides of [
    { zarrArray: null },
    { baseSliceArgsReady: false },
    { lastVisibleRegionsLevel: -1, currentLevelIndex: -1 },
    { lastVisibleRegionsLevel: -1, currentLevelIndex: 0 },
    { lastVisibleRegionsLevel: 0, currentLevelIndex: 1 },
  ]) {
    const { result, started } = await runPrimitive(modeState(overrides))
    assert.equal(result, false, JSON.stringify(overrides))
    assert.deepEqual(started, [])
  }
})

test('UntiledMode primitive: a completed pass with nothing visible is a done no-op', async () => {
  const { result, started } = await runPrimitive(
    modeState({
      lastVisibleRegions: [],
      lastVisibleRegionsLevel: 2,
      currentLevelIndex: 2,
    })
  )
  assert.equal(result, true)
  assert.deepEqual(started, [])
})
