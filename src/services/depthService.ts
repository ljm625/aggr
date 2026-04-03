import { DepthSnapshot } from '@/components/chart/chart.d'
import { getApiUrl, handleFetchError } from '@/utils/helpers'

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

class DepthService {
  url: string
  promisesOfData: { [keyword: string]: Promise<DepthSnapshot[]> } = {}

  constructor() {
    this.url = getApiUrl('depth')
  }

  getApiUrl(from, to, markets: string[]) {
    const params = [from, to]

    if (markets && markets.length) {
      params.push(encodeURIComponent(markets.join('+')))
    }

    return `${this.url}/${params.join('/')}`
  }

  fetch(from: number, to: number, markets: string[]): Promise<DepthSnapshot[]> {
    const url = this.getApiUrl(from, to, markets)

    if (this.promisesOfData[url]) {
      return this.promisesOfData[url]
    }

    this.promisesOfData[url] = fetch(url)
      .then(async response => {
        const contentType = response.headers.get('content-type')

        if (!contentType || contentType.indexOf('application/json') === -1) {
          throw new Error(await response.text())
        }

        return response.json()
      })
      .then((json: DepthResponse) => {
        if (!json || json.format !== 'depth' || !Array.isArray(json.results)) {
          throw new Error('Bad data')
        }

        return json.results.map(snapshot => ({
          time: Math.floor(snapshot.time / 1000),
          market: snapshot.market,
          mid: +snapshot.mid,
          priceStep: +snapshot.priceStep,
          bids: this.normalizeDepthLevelMap(snapshot.bids),
          asks: this.normalizeDepthLevelMap(snapshot.asks),
          rangePercent: +snapshot.rangePercent
        }))
      })
      .catch(error => {
        handleFetchError(error)
        throw error
      })
      .finally(() => {
        delete this.promisesOfData[url]
      })

    return this.promisesOfData[url]
  }

  normalizeDepthLevelMap(levels?: { [price: string]: number }) {
    if (!levels || typeof levels !== 'object' || Array.isArray(levels)) {
      return {}
    }

    return Object.entries(levels).reduce((output, [price, value]) => {
      const numericPrice = +price
      const numericValue = +value

      if (
        !isFinite(numericPrice) ||
        numericPrice <= 0 ||
        !isFinite(numericValue) ||
        numericValue <= 0
      ) {
        return output
      }

      output[price] = numericValue
      return output
    }, {} as { [price: string]: number })
  }
}

export default new DepthService()
