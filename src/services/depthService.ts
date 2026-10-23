import { DepthSnapshot } from '@/components/chart/chart.d'
import { getApiUrl, handleFetchError } from '@/utils/helpers'
import depthCache, { DepthResponseCache } from './depthCache'

export const DEPTH_DAY_MS = 86400000
export const DEPTH_INTERVAL_MS = 5 * 60 * 1000
export const DEPTH_HISTORY_MS = 30 * DEPTH_DAY_MS
export function getDepthHistoryStart(now = Date.now()) {
  return (
    Math.ceil((now - DEPTH_HISTORY_MS) / DEPTH_INTERVAL_MS) * DEPTH_INTERVAL_MS
  )
}
const CLOSED_DAY_DELAY_MS = 5 * 60 * 1000

export interface DepthRange {
  from: number
  to: number
}

export interface DepthResponse {
  format: string
  results: Array<{
    time: number
    market: string
    mid: number
    priceStep: number
    bids: { [price: string]: number }
    asks: { [price: string]: number }
    rangePercent: number
  }>
}

// UTC [from, to) boundaries avoid timezone/DST gaps. Partial first/last days
// never expand a small query into a full-day response.
export function splitDepthRange(from: number, to: number): DepthRange[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to)
    throw new Error('Invalid depth range')
  const ranges: DepthRange[] = []
  for (let start = from; start < to; ) {
    const end = Math.min(
      to,
      (Math.floor(start / DEPTH_DAY_MS) + 1) * DEPTH_DAY_MS
    )
    ranges.push({ from: start, to: end })
    start = end
  }
  return ranges
}

export class DepthService {
  url: string
  promisesOfData: { [keyword: string]: Promise<DepthSnapshot[]> } = {}
  private activeRequests = 0
  private queue: Array<{ priority: number; run: () => void }> = []

  constructor(
    url = getApiUrl('depth'),
    private cache: DepthResponseCache = depthCache
  ) {
    this.url = url
  }

  getApiUrl(from: number, to: number, markets: string[]) {
    const params: Array<string | number> = [from, to]
    if (markets.length) params.push(encodeURIComponent(markets.join('+')))
    return `${this.url}/${params.join('/')}?interval=${DEPTH_INTERVAL_MS}`
  }

  private schedule<T>(work: () => Promise<T>, priority: number): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        priority,
        run: () => {
          this.activeRequests++
          work()
            .then(resolve, reject)
            .finally(() => {
              this.activeRequests--
              this.drain()
            })
        }
      })
      this.queue.sort((a, b) => b.priority - a.priority)
      this.drain()
    })
  }

  private drain() {
    while (this.activeRequests < 2 && this.queue.length)
      this.queue.shift().run()
  }

  async fetch(
    from: number,
    to: number,
    markets: string[]
  ): Promise<DepthSnapshot[]> {
    const results: DepthSnapshot[] = []
    await this.fetchBatches(from, to, markets, snapshots => {
      for (const snapshot of snapshots) results.push(snapshot)
    })
    return results.sort(
      (a, b) => a.time - b.time || a.market.localeCompare(b.market)
    )
  }

  async fetchBatches(
    from: number,
    to: number,
    markets: string[],
    onBatch: (snapshots: DepthSnapshot[], range: DepthRange) => void,
    isCancelled: () => boolean = () => false
  ): Promise<void> {
    const normalizedMarkets = Array.from(
      new Set(markets.map(market => market.trim()).filter(Boolean))
    ).sort()
    if (!normalizedMarkets.length) return
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to)
      throw new Error('Invalid depth range')
    const cutoff = getDepthHistoryStart()
    to = Math.min(to, Date.now() + 60000)
    if (to <= Math.max(from, cutoff)) return
    const ranges = splitDepthRange(Math.max(from, cutoff), to).reverse()
    let next = 0
    let failed = false
    const worker = async () => {
      while (next < ranges.length && !failed && !isCancelled()) {
        const range = ranges[next++]
        try {
          const snapshots = await this.fetchRange(range, normalizedMarkets)
          if (!failed && !isCancelled()) onBatch(snapshots, range)
        } catch (error) {
          failed = true
          throw error
        }
      }
    }
    try {
      await Promise.all([worker(), worker()])
    } catch (error) {
      handleFetchError(error)
      throw error
    }
  }

  private fetchRange(range: DepthRange, markets: string[]) {
    const url = this.getApiUrl(range.from, range.to, markets)
    if (this.promisesOfData[url]) return this.promisesOfData[url]
    const dayEnd =
      (Math.floor((range.to - 1) / DEPTH_DAY_MS) + 1) * DEPTH_DAY_MS
    const cacheable = dayEnd <= Date.now() - CLOSED_DAY_DELAY_MS
    this.promisesOfData[url] = this.schedule(
      async () => {
        if (cacheable) {
          const cached = await this.cache.get(url)
          if (cached !== null) {
            try {
              return this.normalizeResponse(cached)
            } catch (_error) {
              await this.cache.delete(url)
            }
          }
        }
        const response = await fetch(url)
        const text = await response.text()
        const contentType = response.headers.get('content-type') || ''
        if (contentType.indexOf('application/json') === -1)
          throw new Error(text)
        if (!response.ok) {
          const error = JSON.parse(text)
          if (response.status === 404 && error.error === 'no results') return []
          throw new Error(
            error.error || `Depth request failed (${response.status})`
          )
        }
        const snapshots = this.normalizeResponse(text)
        if (cacheable && snapshots.length) await this.cache.put(url, text)
        return snapshots
      },
      cacheable ? 0 : 1
    ).finally(() => {
      delete this.promisesOfData[url]
    })
    return this.promisesOfData[url]
  }

  private normalizeResponse(text: string): DepthSnapshot[] {
    const json: DepthResponse = JSON.parse(text)
    if (!json || json.format !== 'depth' || !Array.isArray(json.results))
      throw new Error('Bad data')
    return json.results.map(snapshot => ({
      time: Math.floor(snapshot.time / 1000),
      market: snapshot.market,
      mid: +snapshot.mid,
      priceStep: +snapshot.priceStep,
      bids: this.normalizeDepthLevelMap(snapshot.bids),
      asks: this.normalizeDepthLevelMap(snapshot.asks),
      rangePercent: +snapshot.rangePercent
    }))
  }

  normalizeDepthLevelMap(levels?: { [price: string]: number }) {
    const output: { [price: string]: number } = {}
    if (!levels || typeof levels !== 'object' || Array.isArray(levels))
      return output
    for (const price in levels) {
      const value = +levels[price]
      if (isFinite(+price) && +price > 0 && isFinite(value) && value > 0)
        output[price] = value
    }
    return output
  }
}

export default new DepthService()
