import { Trade } from '@/types/types'
import Exchange from '../exchange'

export default class DERIBIT extends Exchange {
  id = 'DERIBIT'

  private types: { [pair: string]: 'reversed' | 'linear' }

  protected endpoints = {
    PRODUCTS: [
      'https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=future',
      'https://www.deribit.com/api/v2/public/get_instruments?currency=ETH&kind=future',
      'https://www.deribit.com/api/v2/public/get_instruments?currency=USDC&kind=future'
    ]
  }

  async getUrl() {
    return `wss://www.deribit.com/ws/api/v2`
  }

  formatProducts(response) {
    const products = []
    const types = {}

    for (const data of response) {
      for (const product of data.result) {
        if (!product.is_active) {
          continue
        }

        types[product.instrument_name] = product.future_type

        products.push(product.instrument_name)
      }
    }

    return { products, types }
  }

  validateProducts(data) {
    if (!data || !data.types) {
      return false
    }

    return true
  }

  supportsOpenInterest() {
    return true
  }

  async fetchOpenInterest(pair) {
    const response = await this.fetchJson<{
      result?: Array<{ open_interest: string; mark_price?: string }>
    }>(
      `https://www.deribit.com/api/v2/public/get_book_summary_by_instrument?instrument_name=${encodeURIComponent(
        pair
      )}`
    )
    const summary = response.result && response.result[0]

    if (!summary) {
      return null
    }

    const openInterest = +summary.open_interest

    if (!isFinite(openInterest)) {
      return null
    }

    if (this.types[pair] === 'reversed') {
      return openInterest
    }

    const markPrice = +summary.mark_price

    if (!markPrice) {
      return null
    }

    return openInterest * markPrice
  }

  /**
   * Sub
   * @param {WebSocket} api
   * @param {string} pair
   */
  async subscribe(api, pair) {
    if (!(await super.subscribe(api, pair))) {
      return
    }

    api.send(
      JSON.stringify({
        method: 'public/subscribe',
        params: {
          channels: ['trades.' + pair + '.100ms']
        }
      })
    )

    return true
  }

  /**
   * Sub
   * @param {WebSocket} api
   * @param {string} pair
   */
  async unsubscribe(api, pair) {
    if (!(await super.unsubscribe(api, pair))) {
      return
    }

    api.send(
      JSON.stringify({
        method: 'public/unsubscribe',
        params: {
          channels: ['trades.' + pair + '.raw']
        }
      })
    )

    return true
  }

  onMessage(event, api) {
    const json = JSON.parse(event.data)

    if (
      !json ||
      !json.params ||
      !json.params.data ||
      !json.params.data.length
    ) {
      return
    }

    const trades = []
    const liquidations = []

    for (let i = 0; i < json.params.data.length; i++) {
      const trade = json.params.data[i]
      let size = trade.amount

      if (this.types[trade.instrument_name] === 'reversed') {
        size /= trade.price
      }

      const output: Trade = {
        exchange: this.id,
        pair: trade.instrument_name,
        timestamp: +trade.timestamp,
        price: +trade.price,
        size: size,
        side: trade.direction
      }

      if (trade.liquidation) {
        output.liquidation = true

        liquidations.push(output)
      } else {
        trades.push(output)
      }
    }

    if (trades.length) {
      this.emitTrades(api.id, trades)
    }

    if (liquidations.length) {
      this.emitLiquidations(api.id, liquidations)
    }

    return true
  }

  onApiCreated(api) {
    this.startKeepAlive(api, { method: 'public/ping' }, 45000)
  }

  onApiRemoved(api) {
    this.stopKeepAlive(api)
  }
}
