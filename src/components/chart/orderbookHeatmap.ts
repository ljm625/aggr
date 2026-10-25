import { DepthAggregate, IndicatorApi, Renderer } from './chart.d'

interface HeatmapCell {
  id: string
  slot: number
  amount: number
  color: string
  time: number
  price: number
}

export interface HeatmapState {
  cells?: { [key: string]: HeatmapCell }
  boundaries?: { [id: string]: number }
  slots?: { lastBar: number; active: boolean }[]
  sequence?: number
}

export interface HeatmapOptions {
  minimumAmount: number
  maximumAmount: number
  maxLevels: number
  opacity: number
}

// Fixed scale: the same amount always has the same color, independent of the
// largest order currently on screen. Values above maximum saturate at yellow.
export function heatmapColor(amount: number, options: HeatmapOptions) {
  const minimum = Math.max(0, +options.minimumAmount || 0)
  const maximum = Math.max(minimum, +options.maximumAmount || minimum)
  const ratio =
    maximum > minimum
      ? Math.max(0, Math.min(1, (amount - minimum) / (maximum - minimum)))
      : 1
  const stops = [
    [68, 1, 84],
    [49, 104, 142],
    [53, 183, 121],
    [253, 231, 37]
  ]
  const position = ratio * (stops.length - 1)
  const index = Math.min(stops.length - 2, Math.floor(position))
  const fraction = position - index
  const rgb = stops[index].map((value, channel) =>
    Math.round(value + (stops[index + 1][channel] - value) * fraction)
  )
  const opacity = isFinite(+options.opacity)
    ? Math.max(0, Math.min(1, +options.opacity))
    : 0.85
  return `rgba(${rgb.join(',')},${opacity})`
}

/** One birth point per unchanged price/amount, extended until its book changes.
 * Slots are recycled with a gap so the chart never joins unrelated prices.
 * Realtime updates in the same candle overwrite that candle's birth point.
 */
export function orderbookHeatmap(
  state: HeatmapState,
  renderer: Renderer,
  series: IndicatorApi[],
  book: DepthAggregate | null,
  options: HeatmapOptions
) {
  // computeBar starts with an empty map; updateBar retains previous points.
  // Clear our transient points here so duplicated/custom indicators work too.
  for (const api of series) {
    if (renderer.series[api.id]) {
      renderer.series[api.id] = { time: renderer.localTimestamp }
    }
  }
  if (!state.cells) {
    state.cells = {}
    state.boundaries = {}
    state.slots = series.map(() => ({ lastBar: -Infinity, active: false }))
    state.sequence = 0
    series.forEach(api => api.setExtensionsBoundaries(state.boundaries))
  }

  const minimum = Math.max(0, +options.minimumAmount || 0)
  // Two slots per visible level allow every level to change on every bar.
  const limit = Math.max(
    1,
    Math.min(
      Math.floor(series.length / 2),
      Math.floor(+options.maxLevels || 100)
    )
  )
  const candidates: { key: string; price: number; amount: number }[] = []
  for (const side of ['bids', 'asks']) {
    for (const priceText in (book && book[side]) || {}) {
      const amount = +book[side][priceText]
      const price = +priceText
      if (
        isFinite(price) &&
        price > 0 &&
        isFinite(amount) &&
        amount > 0 &&
        amount >= minimum
      ) {
        candidates.push({ key: `${side}:${price}`, price, amount })
      }
    }
  }
  candidates.sort(
    (a, b) =>
      b.amount - a.amount || a.price - b.price || a.key.localeCompare(b.key)
  )
  const selected = candidates.slice(0, limit)
  const wanted = new Set(selected.map(level => level.key))
  const barIndex = renderer.length - 1
  // The chart treats a boundary of zero as missing. A tiny fraction also ends
  // segments that disappear during the very first candle.
  const boundary = Math.max(1e-8, barIndex)
  const close = (key: string) => {
    const cell = state.cells[key]
    state.boundaries[cell.id] = boundary
    state.slots[cell.slot].active = false
    delete state.cells[key]
  }

  for (const key in state.cells) {
    if (!wanted.has(key)) close(key)
  }

  for (const level of selected) {
    let cell = state.cells[level.key]
    const color = heatmapColor(level.amount, options)
    if (cell && cell.amount === level.amount && cell.color === color) {
      state.boundaries[cell.id] = boundary
      continue
    }
    // Overwrite only the current candle; keep all previous candles intact.
    const sameBar = cell && cell.time === renderer.localTimestamp
    let slot = sameBar ? cell.slot : -1
    if (cell && !sameBar) close(level.key)
    if (slot === -1) {
      slot = state.slots.findIndex(
        candidate =>
          !candidate.active && candidate.lastBar < renderer.length - 1
      )
    }
    if (slot === -1) continue
    const id = sameBar ? cell.id : `depth-${++state.sequence}`
    cell = {
      id,
      slot,
      amount: level.amount,
      color,
      time: renderer.localTimestamp,
      price: level.price
    }
    state.cells[level.key] = cell
    state.slots[slot] = { active: true, lastBar: renderer.length }
    state.boundaries[id] = boundary
  }
  // updateBar clears transient series points before each execution. Re-emit
  // births in this candle so a second tick cannot replace them with whitespace.
  for (const key in state.cells) {
    const cell = state.cells[key]
    if (cell.time !== renderer.localTimestamp) continue
    renderer.series[series[cell.slot].id] = {
      id: cell.id,
      time: cell.time,
      lowerValue: cell.price,
      higherValue: cell.price,
      extendRight: true,
      color: cell.color
    }
  }
}
