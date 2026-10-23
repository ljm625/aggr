import { DBSchema, IDBPDatabase, openDB } from 'idb'

interface DepthCacheEntry {
  key: string
  storedAt: number
  expiresAt: number
  size: number
  body: Blob
}

interface DepthCacheDB extends DBSchema {
  responses: { key: string; value: DepthCacheEntry }
}

export interface DepthResponseCache {
  get(key: string): Promise<string | null>
  put(key: string, body: string): Promise<void>
  delete(key: string): Promise<void>
}

const MAX_CACHE_BYTES = 384 * 1024 * 1024
const MAX_CACHE_ENTRIES = 40
const CACHE_LIFETIME = 7 * 86400000

// Derived depth data is separate from workspace settings. A denied/full
// database must never prevent charts from fetching network data.
class DepthCache implements DepthResponseCache {
  private database: Promise<IDBPDatabase<DepthCacheDB> | null> | null = null

  private open() {
    if (!this.database) {
      this.database =
        typeof indexedDB === 'undefined'
          ? Promise.resolve(null)
          : openDB<DepthCacheDB>('aggr-depth-cache', 1, {
              upgrade(db) {
                db.createObjectStore('responses', { keyPath: 'key' })
              }
            }).catch(() => null)
    }
    return this.database
  }

  async get(key: string) {
    try {
      const db = await this.open()
      if (!db) return null
      const entry = await db.get('responses', key)
      if (!entry) return null
      if (entry.expiresAt <= Date.now()) {
        await db.delete('responses', key)
        return null
      }
      return await entry.body.text()
    } catch (_error) {
      return null
    }
  }

  async put(key: string, text: string) {
    try {
      const db = await this.open()
      if (!db) return
      const body = new Blob([text], { type: 'application/json' })
      if (body.size > MAX_CACHE_BYTES) return
      const now = Date.now()
      const entry = {
        key,
        storedAt: now,
        expiresAt: now + CACHE_LIFETIME,
        size: body.size,
        body
      }
      const tx = db.transaction('responses', 'readwrite')
      const done = tx.done
      done.catch(() => undefined)
      const entries = (await tx.store.getAll()).filter(
        existing => existing.key !== key
      )
      entries.sort((a, b) => a.storedAt - b.storedAt)
      let bytes =
        entries.reduce((sum, existing) => sum + existing.size, 0) + body.size
      let count = entries.length + 1
      for (const existing of entries) {
        if (
          existing.expiresAt <= now ||
          bytes > MAX_CACHE_BYTES ||
          count > MAX_CACHE_ENTRIES
        ) {
          await tx.store.delete(existing.key)
          bytes -= existing.size
          count--
        }
      }
      await tx.store.put(entry)
      await done
    } catch (_error) {
      // Cache capacity and private browsing restrictions are non-fatal.
    }
  }

  async delete(key: string) {
    try {
      const db = await this.open()
      if (db) await db.delete('responses', key)
    } catch (_error) {
      // The next request can always use the network.
    }
  }
}

export default new DepthCache()
