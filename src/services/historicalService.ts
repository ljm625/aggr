import { Bar } from '@/components/chart/chart.d'
import {
  floorTimestampToTimeframe,
  getApiUrl,
  handleFetchError,
  isOddTimeframe
} from '@/utils/helpers'
import EventEmitter from 'eventemitter3'

import store from '../store'
import { parseMarket } from './productsService'

export type InitialPrices = { [market: string]: number }

export interface HistoricalResponse {
  from: number
  to: number
  data: Bar[]
  initialPrices: InitialPrices
}

class HistoricalService extends EventEmitter {
  url: string
  promisesOfData: { [keyword: string]: Promise<HistoricalResponse> } = {}

  constructor() {
    super()

    this.url = getApiUrl('historical')
  }

  filterOutUnavailableMarkets(markets: string[]) {
    return markets.filter(
      market => store.state.app.historicalMarkets.indexOf(market) !== -1
    )
  }

  getApiUrl(from, to, timeframe, markets) {
    const params = [from, to, (timeframe * 1000).toString()]

    if (markets && markets.length) {
      params.push(encodeURIComponent(markets.join('+')))
    }

    return `${this.url}/${params.join('/')}`
  }

  fetch(
    from: number,
    to: number,
    timeframe: number,
    markets: string[]
  ): Promise<HistoricalResponse> {
    const url = this.getApiUrl(from, to, timeframe, markets)

    if (this.promisesOfData[url]) {
      return this.promisesOfData[url]
    }

    this.promisesOfData[url] = fetch(url)
      .then(async response => {
        const contentType = response.headers.get('content-type')
        let json

        if (contentType && contentType.indexOf('application/json') !== -1) {
          json = await response.json()
        } else {
          // text = error
          throw new Error(await response.text())
        }

        json.status = response.status
        return json
      })
      .then(json => {
        if (!json || json.error) {
          throw new Error(json && json.error ? json.error : 'empty-response')
        }

        if (json.format !== 'point') {
          throw new Error('Bad data')
        }

        if (!json.results.length) {
          throw new Error('No more data')
        }

        return this.normalizePoints(
          json.results,
          json.columns,
          timeframe,
          markets
        )
      })
      .catch(err => {
        handleFetchError(err)

        throw err
      })
      .then(data => {
        store.commit('app/TOGGLE_LOADING', false)
        delete this.promisesOfData[url]

        return data
      })

    return this.promisesOfData[url]
  }
  normalizePoints(data, columns, timeframe, markets: string[]) {
    const lastClosedBars = {}
    const initialPrices = {}

    markets = markets.slice()

    if (!data || !data.length) {
      return data
    }

    // base timestamp of results
    let firstBarTimestamp: number

    if (Array.isArray(data[0])) {
      firstBarTimestamp = data[0][0]
    } else {
      firstBarTimestamp = +new Date(data[0].time) / 1000
    }

    markets = [...markets]

    const isOdd = isOddTimeframe(timeframe)
    const preferQuoteCurrencySize = store.state.settings.preferQuoteCurrencySize
    const currentOpenTimestamp = floorTimestampToTimeframe(
      Date.now() / 1000,
      timeframe,
      isOdd
    )

    for (let i = 0; i < data.length; i++) {
      if (!data[i].time && data[i][0]) {
        // new format is array, transform into objet
        data[i] = {
          time:
            typeof columns['time'] !== 'undefined'
              ? data[i][columns['time']]
              : 0,
          cbuy:
            typeof columns['cbuy'] !== 'undefined'
              ? data[i][columns['cbuy']]
              : 0,
          close:
            typeof columns['close'] !== 'undefined'
              ? data[i][columns['close']]
              : 0,
          csell:
            typeof columns['csell'] !== 'undefined'
              ? data[i][columns['csell']]
              : 0,
          high:
            typeof columns['high'] !== 'undefined'
              ? data[i][columns['high']]
              : 0,
          lbuy:
            typeof columns['lbuy'] !== 'undefined'
              ? data[i][columns['lbuy']]
              : 0,
          low:
            typeof columns['low'] !== 'undefined' ? data[i][columns['low']] : 0,
          lsell:
            typeof columns['lsell'] !== 'undefined'
              ? data[i][columns['lsell']]
              : 0,
          oi:
            typeof columns['oi'] !== 'undefined'
              ? data[i][columns['oi']]
              : null,
          market:
            typeof columns['market'] !== 'undefined'
              ? data[i][columns['market']]
              : 0,
          open:
            typeof columns['open'] !== 'undefined'
              ? data[i][columns['open']]
              : 0,
          vbuy:
            typeof columns['vbuy'] !== 'undefined'
              ? data[i][columns['vbuy']]
              : 0,
          vsell:
            typeof columns['vsell'] !== 'undefined'
              ? data[i][columns['vsell']]
              : 0
        }
      } else {
        // pending bar was sent
        if (!lastClosedBars[data[i].market]) {
          // get latest bar for that market
          for (let j = i - 1; j >= 0; j--) {
            if (data[j].market === data[i].market) {
              lastClosedBars[data[i].market] = data[j]
              break
            }
          }
        }

        // format pending bar time floored to timeframe
        data[i].time = floorTimestampToTimeframe(
          data[i].time / 1000,
          timeframe,
          isOdd
        )

        // Drop the still-forming current bucket on initial/history loads.
        // Realtime trades will rebuild the live bar without creating phantom
        // future candles that depend on the page-open second.
        if (data[i].time >= currentOpenTimestamp) {
          data.splice(i, 1)
          i--
          continue
        }

        if (
          !preferQuoteCurrencySize &&
          (data[i].vbuy || data[i].vsell) &&
          data[i].close
        ) {
          data[i].vbuy = data[i].vbuy / data[i].close
          data[i].vsell = data[i].vsell / data[i].close
        }

        if (
          !lastClosedBars[data[i].market] ||
          lastClosedBars[data[i].market].time < data[i].time
        ) {
          // store reference bar for this market (either because it didn't exist or because reference bar time is < than pending bar time)
          lastClosedBars[data[i].market] = data[i]
        } else if (lastClosedBars[data[i].market] !== data[i]) {
          lastClosedBars[data[i].market].vbuy += data[i].vbuy
          lastClosedBars[data[i].market].vsell += data[i].vsell
          lastClosedBars[data[i].market].cbuy += data[i].cbuy
          lastClosedBars[data[i].market].csell += data[i].csell
          lastClosedBars[data[i].market].lbuy += data[i].lbuy
          lastClosedBars[data[i].market].lsell += data[i].lsell

          if (data[i].high !== null && typeof data[i].high !== 'undefined') {
            lastClosedBars[data[i].market].high =
              lastClosedBars[data[i].market].high === null
                ? data[i].high
                : Math.max(data[i].high, lastClosedBars[data[i].market].high)
          }

          if (data[i].low !== null && typeof data[i].low !== 'undefined') {
            lastClosedBars[data[i].market].low =
              lastClosedBars[data[i].market].low === null
                ? data[i].low
                : Math.min(data[i].low, lastClosedBars[data[i].market].low)
          }

          if (data[i].close !== null && typeof data[i].close !== 'undefined') {
            lastClosedBars[data[i].market].close = data[i].close
          }

          if (typeof data[i].oi === 'number') {
            lastClosedBars[data[i].market].oi = data[i].oi
          }

          data.splice(i, 1)
          i--
          continue
        }
      }

      if (!initialPrices[data[i].market]) {
        initialPrices[data[i].market] = data[i].close
      }

      if (
        !preferQuoteCurrencySize &&
        (data[i].vbuy || data[i].vsell) &&
        data[i].close
      ) {
        data[i].vbuy = data[i].vbuy / data[i].close
        data[i].vsell = data[i].vsell / data[i].close
      }

      if (data[i].time === firstBarTimestamp) {
        const marketIndex = markets.indexOf(data[i].market)

        markets.splice(marketIndex, 1)
      }

      const [exchange, pair] = parseMarket(data[i].market)
      data[i].exchange = exchange
      data[i].pair = pair
    }

    if (!data.length) {
      throw new Error('No more data')
    }

    return {
      data,
      markets,
      from: data[0].time,
      to: data[data.length - 1].time,
      initialPrices
    }
  }
}

export default new HistoricalService()
