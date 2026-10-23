const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test, beforeEach, afterEach } = require('node:test')
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
const { DepthService, splitDepthRange, getDepthHistoryStart, DEPTH_INTERVAL_MS, DEPTH_HISTORY_MS, DEPTH_DAY_MS: DAY } = loadService()
const originalFetch = global.fetch
const now = Date.now
const end = Date.UTC(2026, 9, 23)
beforeEach(() => { Date.now = () => end + 300000 })
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
function chartMethod(name,extra={}) {
  const marker='    '+name+'('
  const start=chartSource.indexOf(marker)
  assert.notEqual(start,-1)
  const finish=chartSource.indexOf('\n    }',start)+6
  return vm.runInNewContext('({'+chartSource.slice(start,finish).trim()+'})',{Map,Array,Set,Date,console,depthService_1:{default:{}, getDepthHistoryStart, DEPTH_INTERVAL_MS},...extra})[name]
}

test('chart batch merge preserves timestamp order and replaces duplicate snapshots', () => {
  const merge=chartMethod('mergeDepthSnapshots')
  const base=end/1000-DAY/1000
  const chart={_depthRevision:0,depthSnapshotsEqual:chartMethod('depthSnapshotsEqual'),depthSnapshots:{'TEST:A':[{market:'TEST:A',time:base+600,mid:1}]}}
  merge.call(chart,[{market:'TEST:A',time:base+300,mid:2},{market:'TEST:A',time:base+600,mid:3},{market:'TEST:B',time:base+900,mid:4}])
  assert.deepEqual(chart.depthSnapshots['TEST:A'].map(row=>row.time),[base+300,base+600])
  assert.equal(chart.depthSnapshots['TEST:A'][1].mid,3)
  assert.equal(chart.depthSnapshots['TEST:B'][0].time,base+900)
})

test('month history is bounded to 30 days and every request asks the backend for 5 minute snapshots', async () => {
  Date.now=()=>end
  const requests=[]
  global.fetch=async url=>{requests.push(url);return reply(parseUrl(url))}
  const service=new DepthService('https://depth.test/api/depth',noopCache)
  await service.fetch(end-100*DAY,end,['TEST:BTC'])
  assert.equal(requests.length,30)
  const ranges=requests.map(parseUrl).sort((a,b)=>a.from-b.from)
  assert.equal(ranges[0].from,end-30*DAY)
  assert.equal(ranges.at(-1).to,end)
  for (const url of requests) assert.equal(new URL(url).searchParams.get('interval'),'300000')
  await service.fetch(end-100*DAY,end-31*DAY,['TEST:BTC'])
  assert.equal(requests.length,30)
  Date.now=()=>end+123000
  assert.equal(getDepthHistoryStart(),end-DEPTH_HISTORY_MS+DEPTH_INTERVAL_MS)
})

function makeChart() {
  const chart={
    depthSnapshots:{}, _depthRevision:0, _depthAggregateCache:new Map(), _depthAggregateLevels:0,
    activeRenderer:null, usesDepthSnapshots:()=>true,
    getDepthMarketGroup:market=>market.startsWith('SPOT:')?'spot':'perp', getPrice:()=>100
  }
  for (const name of ['depthSnapshotsEqual','mergeDepthSnapshots','getDepthSnapshotForMarket','getDepthSnapshotReferenceTime','getDepthPriceStepPrecision','formatDepthPriceKey','bucketDepthPrice','mergeDepthLevels','sumDepthLevels','finalizeDepthAggregate','getDepthReferencePrice','syncRendererDepth']) chart[name]=chartMethod(name)
  return chart
}
const snapshot = (time,market='SPOT:BTC') => ({time,market,mid:100,priceStep:1,rangePercent:10,bids:{99:2},asks:{101:3}})

test('live samples replace their 5 minute bucket, retain unchanged identities, and expire old history', () => {
  const chart=makeChart(),time=end/1000-300
  const first=snapshot(time)
  chart.mergeDepthSnapshots([first])
  const revision=chart._depthRevision
  chart.mergeDepthSnapshots([snapshot(time)])
  assert.equal(chart._depthRevision,revision)
  assert.equal(chart.depthSnapshots['SPOT:BTC'][0],first)
  chart.mergeDepthSnapshots([snapshot(time+60),snapshot(time-60),snapshot(end/1000-31*DAY/1000)])
  assert.deepEqual(chart.depthSnapshots['SPOT:BTC'].map(row=>row.time),[time-60,time+60])
  chart.mergeDepthSnapshots([snapshot(time+30)])
  assert.equal(chart.depthSnapshots['SPOT:BTC'][1].time,time+60)
  Date.now=()=>end+31*DAY
  chart.mergeDepthSnapshots([])
  assert.equal(chart.depthSnapshots['SPOT:BTC'].length,0)
})

test('depth aggregation preserves totals/groups and invalidates when price or the source book changes', () => {
  const chart=makeChart(),time=end/1000-600
  chart.mergeDepthSnapshots([snapshot(time),{...snapshot(time,'PERP:BTC'),bids:{98:4},asks:{102:1}}])
  const renderer={timestamp:time,sources:{'SPOT:BTC':{active:true},'PERP:BTC':{active:true}},bar:{close:100},series:{}}
  chart.syncRendererDepth(renderer)
  assert.equal(renderer.depth.totalBids,6)
  assert.equal(renderer.depth.totalAsks,4)
  assert.equal(renderer.depth.spot.totalBids,2)
  assert.equal(renderer.depth.perp.totalAsks,1)
  assert.equal(renderer.depth.future,renderer.depth.perp)
  const first=renderer.depth
  chart.syncRendererDepth(renderer)
  assert.equal(renderer.depth,first)
  renderer.bar.close=101
  chart.syncRendererDepth(renderer)
  assert.notEqual(renderer.depth,first)
  assert.deepEqual(Object.keys(renderer.depth.bids),['99','100'])
  const second=renderer.depth
  chart.mergeDepthSnapshots([{...snapshot(time),bids:{99:9}}])
  chart.syncRendererDepth(renderer)
  assert.notEqual(renderer.depth,second)
  assert.equal(renderer.depth.totalBids,13)
  assert.ok(chart._depthAggregateLevels>0)
})

test('optimized bucket merging matches original rounding across fractional steps, offsets and invalid levels', () => {
  const chart=makeChart()
  for(const step of [50,1,0.01,0.00003]) for(const offset of [-0.00004,0,0.00004,50.1234]) for(const side of ['bid','ask']) {
    const levels={};for(let i=0;i<50;i++)levels[(0.00003+i*1.231).toString()]=i+0.123456789
    Object.assign(levels,{invalid:2,'-5':1,'12345.67':NaN,'500':-4})
    const expected={},actual={},group={}
    for(const [text,value]of Object.entries(levels)) {
      const price=+text+offset,amount=+value
      if(!isFinite(price)||price<=0||!isFinite(amount)||amount<=0)continue
      const bucket=chart.bucketDepthPrice(price,step,side)
      if(!bucket||bucket<=0)continue
      const key=chart.formatDepthPriceKey(bucket,step)
      expected[key]=(expected[key]||0)+amount
    }
    chart.mergeDepthLevels(actual,levels,step,side,offset,group)
    assert.deepEqual(actual,expected)
    assert.deepEqual(group,expected)
  }
})

test('unchanged refreshes do not redraw; changed books do', async () => {
  const refresh=chartMethod('maybeRefreshDepthCoverage')
  let renders=0
  const chart={usesDepthSnapshots:()=>true,marketsFilters:{'TEST:BTC':true},activeRenderer:null,depthCacheRange:{to:null},_depthRefreshPromise:null,_lastDepthRefreshAt:0,timeframe:300,_depthRevision:1,isLoading:false,chartInstance:{},renderAll:()=>renders++,fetchDepth:async()=>{}}
  refresh.call(chart,end/1000)
  await chart._depthRefreshPromise
  assert.equal(renders,0)
  chart._lastDepthRefreshAt=0
  chart.fetchDepth=async()=>{chart._depthRevision++}
  refresh.call(chart,end/1000)
  await chart._depthRefreshPromise
  assert.equal(renders,1)
})

function loadCodec(native) {
  const filename=path.join(sourceRoot,'src/services/depthCache.ts')
  const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2019}}).outputText
  const module={exports:{}}
  vm.runInNewContext(code,{module,exports:module.exports,Blob,Response,Uint8Array,CompressionStream:native?CompressionStream:undefined,DecompressionStream:native?DecompressionStream:undefined,
    require:name=>name==='pako'?require(path.join(frontendRoot,'node_modules/pako')):{openDB:()=>{throw Error('not used')}}})
  return module.exports
}
test('compressed cache is lossless with native streams, fallback, and plain old entries', async () => {
  const native=loadCodec(true),fallback=loadCodec(false)
  const text=JSON.stringify({format:'depth',results:Array.from({length:1000},(_,i)=>({...snapshot(i),bids:{'123.456789':1.2345678912345}}))})
  for(const codec of [native,fallback]) {
    const body=await codec.compressDepth(text)
    assert.equal(body.type,'application/gzip')
    assert.ok(body.size<text.length/5)
    assert.equal(await native.decompressDepth(body),text)
    assert.equal(await fallback.decompressDepth(body),text)
  }
  assert.equal(await native.decompressDepth(new Blob([text],{type:'application/json'})),text)
})

test('derived cache stays bounded and clearing depth releases cached objects and pending redraws', () => {
  const chart=makeChart(),time=end/1000-600
  chart.mergeDepthSnapshots([snapshot(time)])
  const renderer={timestamp:time,sources:{'SPOT:BTC':{active:true}},bar:{close:100},series:{}}
  for(let i=0;i<4200;i++) {renderer.timestamp=time+i;chart.syncRendererDepth(renderer)}
  assert.equal(chart._depthAggregateCache.size,4096)
  let cancelled=false
  const clear=chartMethod('clearDepthData',{window:{clearTimeout:id=>{assert.equal(id,123);cancelled=true}}})
  Object.assign(chart,{_depthDataVersion:1,_depthRenderTimeout:123,depthCacheRange:{from:time,to:time+4200}})
  clear.call(chart)
  assert.equal(cancelled,true)
  assert.equal(chart._depthAggregateCache.size,0)
  assert.equal(chart._depthAggregateLevels,0)
  assert.equal(Object.keys(chart.depthSnapshots).length,0)
  assert.equal(chart._depthDataVersion,2)
})
