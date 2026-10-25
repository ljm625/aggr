const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
function load(relative, imports = {}) {
  const filename = path.join(root, relative)
  const code = ts.transpileModule(
    fs.readFileSync(filename, 'utf8').replace(/import\.meta\.env/g, '({})'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019
      }
    }
  ).outputText
  const module = { exports: {} }
  vm.runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      console,
      Map,
      Set,
      Math,
      Number,
      require: name => {
        if (name in imports) return imports[name]
        throw new Error('Unexpected import ' + name)
      }
    },
    { filename }
  )
  return module.exports
}
const heatmap = load('src/components/chart/orderbookHeatmap.ts')
const { heatmapColor, orderbookHeatmap } = heatmap
const options = {
  minimumAmount: 10,
  maximumAmount: 100,
  maxLevels: 2,
  opacity: 0.85
}
const book = (bids = { 99: 50 }, asks = { 101: 100 }) => ({
  bids,
  asks,
  priceStep: 1,
  mid: 100
})
function harness(count = 4) {
  const state = {},
    renderer = { length: 1, localTimestamp: 1000, series: {} }
  const series = Array.from({ length: count }, (_, i) => ({
    id: 'slot' + i,
    setExtensionsBoundaries(value) {
      this.boundaries = value
    }
  }))
  return {
    state,
    renderer,
    series,
    run(value = book(), next = true) {
      if (next) renderer.series = {}
      orderbookHeatmap(state, renderer, series, value, options)
      return Object.values(renderer.series)
    },
    advance() {
      renderer.length++
      renderer.localTimestamp += 60
    }
  }
}

test('fixed color thresholds clamp excess and handle invalid maximum and opacity', () => {
  assert.equal(heatmapColor(10, options), 'rgba(68,1,84,0.85)')
  assert.equal(heatmapColor(100, options), 'rgba(253,231,37,0.85)')
  assert.equal(heatmapColor(1000, options), heatmapColor(100, options))
  assert.equal(
    heatmapColor(10, { ...options, maximumAmount: 0, opacity: 2 }),
    'rgba(253,231,37,1)'
  )
})

test('unchanged liquidity is a single horizontal segment, including repeated realtime ticks', () => {
  const h = harness(),
    initial = h.run()
  assert.equal(initial.length, 2)
  assert.equal(h.run().length, 2) // current candle cannot be erased by a second tick
  h.advance()
  assert.equal(h.run().length, 0) // no new birth points
  assert.equal(h.state.sequence, 2)
  for (const point of initial) {
    assert.equal(point.lowerValue, point.higherValue)
    assert.equal(h.state.boundaries[point.id], 1)
  }
  h.advance()
  h.run()
  assert.equal(h.state.boundaries[initial[0].id], 2)
})

test('amount changes retain history, recolor at the change, and withdrawals stop extensions', () => {
  const h = harness(),
    initial = h.run()
  h.advance()
  const changed = h.run(book({ 99: 80 }))
  assert.equal(changed.length, 1)
  assert.notEqual(changed[0].id, initial[0].id)
  assert.notEqual(changed[0].color, initial[0].color)
  assert.equal(h.state.boundaries[initial[0].id], 1)
  h.advance()
  h.run(book({ 99: 9 }, {}))
  assert.equal(Object.keys(h.state.cells).length, 0)
  assert.equal(h.state.boundaries[changed[0].id], 2)
  h.advance()
  h.run(book({}, {}))
  assert.equal(h.state.boundaries[changed[0].id], 2)
})

test('same-candle amount changes reuse the point and full replays are deterministic', () => {
  const h = harness(),
    initial = h.run().find(point => point.lowerValue === 99)
  const point = h.run(book({ 99: 90 })).find(point => point.lowerValue === 99)
  assert.equal(point.id, initial.id)
  assert.equal(point.time, initial.time)
  assert.equal(point.color, heatmapColor(90, options))
  const replay = harness()
  assert.deepEqual(replay.run(book({ 99: 90 })), h.run(book({ 99: 90 })))
})

test('slot recycling tolerates all levels changing each candle without joining adjacent prices', () => {
  const h = harness()
  const lastWrite = new Map()
  for (let i = 0; i < 100; i++) {
    const points = h.run(book({ [90 + i]: 50 + i }, { [200 + i]: 100 + i }))
    assert.equal(points.length, 2)
    for (const [slot, point] of Object.entries(h.renderer.series)) {
      if (lastWrite.has(slot))
        assert.ok(point.time - lastWrite.get(slot) >= 120)
      lastWrite.set(slot, point.time)
    }
    h.advance()
  }
})

test('the level cap keeps strongest orders and invalid or below-threshold entries never draw', () => {
  const h = harness()
  const points = h.run(
    book(
      { 99: 10, 98: 50, 97: NaN, 96: -1, 95: 9 },
      { 101: 100, 102: 200, bad: 500 }
    )
  )
  assert.deepEqual(
    points.map(point => point.lowerValue),
    [102, 101]
  )
  h.advance()
  h.run(null)
  assert.equal(Object.keys(h.state.cells).length, 0)
})

test('custom indicator realtime points cannot resend old births or retain a withdrawn current-candle level', () => {
  const h = harness()
  h.run()
  const bidSlot = h.state.cells['bids:99'].slot
  const bidId = h.series[bidSlot].id
  h.run(book({}, {101:100}), false)
  assert.equal(h.renderer.series[bidId].lowerValue, undefined)
  assert.equal(h.renderer.series[bidId].time, 1000)
  h.advance()
  h.run(book({}, {101:100}), false)
  for (const point of Object.values(h.renderer.series)) {
    assert.equal(point.time, 1060)
    assert.equal(point.lowerValue, undefined)
  }
})

// Exercise the actual indicator compiler and both shipped scripts, including
// persistent variables, plot allocation, library IDs and renderer.depth access.
const helpers = load('src/utils/helpers.ts', {
  vue: { default: {} },
  '@/store': { default: {} }
})
const utils = { orderbookHeatmap }
const compiler = load('src/components/chart/buildUtils.ts', {
  './serieUtils': { default: utils },
  '@/store': { default: { state: {} } },
  '@/utils/helpers': helpers,
  './options': { plotTypesMap: { brokenarea: 'broken-area' } }
})
const defaults = JSON.parse(
  fs.readFileSync(path.join(root, 'src/store/defaultIndicators.json'), 'utf8')
)
for (const group of ['spot', 'perp']) {
  test(
    group + ' installed indicator compiles and selects its own fixed book',
    () => {
      const id = 'orderbook-heatmap-' + group
      const indicator = {
        ...defaults[id],
        id,
        libraryId: id,
        options: { ...defaults[id].options, ...options }
      }
      indicator.model = compiler.build(indicator, {})
      assert.equal(indicator.model.plots.length, 256)
      assert.equal(
        indicator.model.options.minimumAmount.label,
        '起始显示量（计价币）'
      )
      const data = compiler.getRendererIndicatorData(indicator)
      const adapter = compiler.getBuildedIndicator(
        indicator.model,
        {},
        indicator.options
      )
      const series = indicator.model.plots.map(plot => ({
        id: plot.id,
        setExtensionsBoundaries() {}
      }))
      const renderer = {
        length: 1,
        localTimestamp: 1000,
        series: {},
        depth: {
          spotBook: book({ 99: 50 }, {}),
          perpBook: book({ 109: 90 }, {})
        }
      }
      adapter(
        renderer,
        data.functions,
        data.variables,
        series,
        indicator.options,
        utils
      )
      assert.deepEqual(
        Object.values(renderer.series).map(point => point.lowerValue),
        [group === 'spot' ? 99 : 109]
      )
      renderer.series = {}
      adapter(
        renderer,
        data.functions,
        data.variables,
        series,
        indicator.options,
        utils
      )
      assert.equal(Object.values(renderer.series).length, 1)
    }
  )
}
