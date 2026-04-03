import Exchange from '../exchange'

export default class HYPERLIQUID extends Exchange {
  id = 'HYPERLIQUID'
  protected endpoints: { [id: string]: any } = {
    PRODUCTS: [
      {
        url: 'https://api.hyperliquid.xyz/info',
        method: 'POST',
        data: JSON.stringify({ type: 'meta' }),
        proxy: false
      }
    ]
  }

  async getUrl() {
    return 'wss://api.hyperliquid.xyz/ws'
  }

  formatProducts(response) {
    const products = []

    const perpResponse = response

    if (perpResponse && perpResponse.universe && perpResponse.universe.length) {
      for (const product of perpResponse.universe) {
        products.push(product.name)
      }
    }

    return {
      products
    }
  }

  supportsOpenInterest() {
    return true
  }

  async fetchOpenInterests(pairs) {
    const openInterests: { [pair: string]: number } = {}
    const response = await this.fetchJson<any>({
      url: 'https://api.hyperliquid.xyz/info',
      method: 'POST',
      data: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      proxy: false
    })
    const universe = response && response[0] && response[0].universe
    const contexts = response && response[1]

    if (!universe || !contexts) {
      return openInterests
    }

    const contextsByPair = universe.reduce(
      (output, product, index) => {
        output[product.name] = contexts[index]
        return output
      },
      {} as { [pair: string]: any }
    )

    for (const pair of pairs) {
      const context = contextsByPair[pair]

      if (!context) {
        continue
      }

      const openInterest = +context.openInterest
      const price = +context.markPx || +context.oraclePx

      if (!isFinite(openInterest) || !price) {
        continue
      }

      openInterests[pair] = openInterest * price
    }

    return openInterests
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
        method: 'subscribe',
        subscription: {
          type: 'trades',
          coin: pair
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
        method: 'unsubscribe',
        subscription: {
          type: 'trades',
          coin: pair
        }
      })
    )

    return true
  }

  onMessage(event, api) {
    const json = JSON.parse(event.data)

    if (json && json.channel === 'trades') {
      return this.emitTrades(
        api.id,
        json.data.map(t => this.formatResponse(t))
      )
    }
  }

  formatResponse(t) {
    return {
      exchange: this.id,
      pair: t.coin,
      timestamp: +new Date(t.time),
      price: +t.px,
      size: +t.sz,
      side: t.side === 'B' ? 'buy' : 'sell'
    }
  }
}
