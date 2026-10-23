const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test, afterEach } = require('node:test')
const { setTimeout: sleep } = require('node:timers/promises')
const frontendRoot = process.env.AGGR_FRONTEND_ROOT || path.resolve(__dirname, '..')
const sourceRoot = process.env.AGGR_DEPTH_SOURCE_ROOT || frontendRoot
const ts = require(path.join(frontendRoot, 'node_modules/typescript'))
const errors = []
const noopCache = { get: async () => null, put: async () => {}, delete: async () => {} }
function loadService() {
  const filename = path.join(sourceRoot, 'src/services/depthService.ts')
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, console, Date, Set, Map, Promise, Number, Array, Error,
    fetch: (...args) => global.fetch(...args),
    require: name => {
      if (name === '@/utils/helpers') return { getApiUrl: () => 'https://depth.test/api/depth', handleFetchError: error => errors.push(error) }
      if (name === './depthCache') return { default: noopCache }
      throw new Error('Unexpected module '+name)
    }
  }, {filename})
  return module.exports
}
const { DepthService, splitDepthRange, DEPTH_DAY_MS: DAY } = loadService()
const originalFetch = global.fetch
const now = Date.now
const end = Date.UTC(2026, 9, 23)
afterEach(() => { global.fetch = originalFetch; Date.now = now; errors.length = 0 })
const memoryCache = () => {
  const entries = new Map()
  return { entries, get: async key => entries.get(key) ?? null, put: async (key, body) => { entries.set(key, body) }, delete: async key => { entries.delete(key) } }
}
const parseUrl = url => {
  const parts = new URL(url).pathname.split('/')
  return { from: +parts[3], to: +parts[4], markets: decodeURIComponent(parts[5]).split('+') }
}
const reply = (range, markets = ['TEST:BTC'], status = 200) => new Response(JSON.stringify(status === 200 ? {
  format: 'depth', results: markets.map(market => ({ time: range.from, market, mid: 100, priceStep: 1, bids: {99:2}, asks: {101:3}, rangePercent:10 }))
} : {error:status===404?'no results':'backend failed'}), {status, headers:{'content-type':'application/json'}})

test('seven-day rolling range splits at UTC midnight without gaps or expanded edges', () => {
  const from = end - 7*DAY + 123000, to = end + 123000
  const ranges = splitDepthRange(from, to)
  assert.equal(ranges.length, 8)
  assert.equal(ranges[0].from, from)
  assert.equal(ranges[ranges.length-1].to, to)
  for (let i=0; i<ranges.length; i++) {
    assert.ok(ranges[i].to-ranges[i].from <= DAY)
    if(i) assert.equal(ranges[i].from, ranges[i-1].to)
  }
  assert.equal(splitDepthRange(from, from).length,0)
  assert.throws(()=>splitDepthRange(NaN,to))
})

test('concurrent charts share a two-request limit and return all seven days in order', async () => {
  let active=0,peak=0,calls=0
  global.fetch=async url=>{calls++;active++;peak=Math.max(peak,active);await sleep(5);active--;const range=parseUrl(url);return reply(range,range.markets)}
  const service=new DepthService('https://depth.test/api/depth',noopCache)
  const [left,right]=await Promise.all([service.fetch(end-7*DAY,end,['TEST:A']),service.fetch(end-7*DAY,end,['TEST:B'])])
  assert.equal(calls,14)
  assert.equal(peak,2)
  assert.equal(left.length,7)
  assert.equal(right.length,7)
  for(let i=0;i<7;i++) assert.equal(left[i].time,(end-(7-i)*DAY)/1000)
  assert.equal(Object.keys(service.promisesOfData).length,0)
})

test('closed dates survive a new service instance; current day stays live', async () => {
  Date.now=()=>end+DAY/2
  const cache=memoryCache();let calls=0
  global.fetch=async url=>{calls++;const range=parseUrl(url);return reply(range,range.markets)}
  await new DepthService('https://depth.test/api/depth',cache).fetch(end-2*DAY,end+1000,['TEST:BTC'])
  assert.equal(calls,3)
  assert.equal(cache.entries.size,2)
  await new DepthService('https://depth.test/api/depth',cache).fetch(end-2*DAY,end+1000,['TEST:BTC'])
  assert.equal(calls,4)
  // The source endpoint is part of the key, so another server is never reused.
  await new DepthService('https://other.test/api/depth',cache).fetch(end-DAY,end,['TEST:BTC'])
  assert.equal(calls,5)
})

test('identical queries deduplicate despite market order or duplicate market names', async () => {
  let calls=0
  global.fetch=async url=>{calls++;await sleep(5);const range=parseUrl(url);return reply(range,range.markets)}
  const service=new DepthService('https://depth.test/api/depth',noopCache)
  const result=await Promise.all([service.fetch(end-DAY,end,['TEST:B','TEST:A','TEST:A']),service.fetch(end-DAY,end,['TEST:A','TEST:B'])])
  assert.equal(calls,1)
  assert.equal(result[0].length,2)
})

test('failed/empty responses do not poison the cache and later requests retry', async () => {
  const cache=memoryCache();let calls=0
  global.fetch=async url=>{calls++;return reply(parseUrl(url),undefined,calls===1?500:calls===2?404:200)}
  const service=new DepthService('https://depth.test/api/depth',cache)
  await assert.rejects(service.fetch(end-DAY,end,['TEST:BTC']),/backend failed/)
  assert.equal(cache.entries.size,0)
  assert.equal((await service.fetch(end-DAY,end,['TEST:BTC'])).length,0)
  assert.equal(cache.entries.size,0)
  assert.equal((await service.fetch(end-DAY,end,['TEST:BTC'])).length,1)
  assert.equal(cache.entries.size,1)
})

test('corrupt cache data is evicted and replaced from the network', async () => {
  const cache=memoryCache(),service=new DepthService('https://depth.test/api/depth',cache)
  cache.entries.set(service.getApiUrl(end-DAY,end,['TEST:BTC']),'{bad')
  let calls=0
  global.fetch=async url=>{calls++;return reply(parseUrl(url))}
  assert.equal((await service.fetch(end-DAY,end,['TEST:BTC'])).length,1)
  assert.equal(calls,1)
})

test('cancelled chart deliveries do not cancel data shared by another chart', async () => {
  const service=new DepthService('https://depth.test/api/depth',noopCache)
  let cancelled=false,deliveries=0,calls=0
  global.fetch=async url=>{calls++;await sleep(10);return reply(parseUrl(url))}
  const first=service.fetchBatches(end-7*DAY,end,['TEST:BTC'],()=>{deliveries++},()=>cancelled)
  const second=service.fetch(end-7*DAY,end,['TEST:BTC'])
  cancelled=true
  await first
  assert.equal((await second).length,7)
  assert.equal(deliveries,0)
  assert.equal(calls,7)
})

test('realtime work takes the next free slot ahead of queued history', async () => {
  Date.now=()=>end+DAY/2
  const service=new DepthService('https://depth.test/api/depth',noopCache),started=[],releases=[]
  global.fetch=url=>{const range=parseUrl(url);started.push(range.from);return new Promise(resolve=>{releases.push(()=>resolve(reply(range)))})}
  const a=service.fetch(end-DAY,end,['TEST:A'])
  const b=service.fetch(end-DAY,end,['TEST:B'])
  const old=service.fetch(end-2*DAY,end-DAY,['TEST:C'])
  const live=service.fetch(end,end+1000,['TEST:D'])
  await sleep(0)
  releases.shift()()
  await sleep(0)
  assert.equal(started[2],end)
  while(releases.length) {releases.shift()();await sleep(0)}
  await Promise.all([a,b,old,live])
})

// Compile the actual chart and isolate only its depth methods; no UI singleton
// or exchange connection is initialized by these merge/lifecycle tests.
const chartSource=ts.transpileModule(fs.readFileSync(path.join(sourceRoot,'src/components/chart/chart.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2018,module:ts.ModuleKind.CommonJS}}).outputText
function chartMethod(name) {
  const marker='    '+name+'('
  const start=chartSource.indexOf(marker)
  assert.notEqual(start,-1)
  const finish=chartSource.indexOf('\n    }',start)+6
  return vm.runInNewContext('({'+chartSource.slice(start,finish).trim()+'})',{Map,Array,console,depthService_1:{default:{}}})[name]
}

test('chart batch merge preserves timestamp order and replaces duplicate snapshots', () => {
  const merge=chartMethod('mergeDepthSnapshots')
  const chart={depthSnapshots:{'TEST:A':[{market:'TEST:A',time:2,mid:1}]}}
  merge.call(chart,[{market:'TEST:A',time:1,mid:2},{market:'TEST:A',time:2,mid:3},{market:'TEST:B',time:4,mid:4}])
  assert.deepEqual(chart.depthSnapshots['TEST:A'].map(row=>row.time),[1,2])
  assert.equal(chart.depthSnapshots['TEST:A'][1].mid,3)
  assert.equal(chart.depthSnapshots['TEST:B'][0].time,4)
})
