import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {Duplex} from 'node:stream'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {allowedHmrUpgrade,createHmrRelay} from '../scripts/turnstile-browser/hmr-relay.mjs'
import {createProxy} from '../scripts/turnstile-browser/start.mjs'

const key='dGhlIHNhbXBsZSBub25jZQ=='
const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
const secret='SYNTHETIC_SECRET_TOKEN_COOKIE_PERSON'
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const input=(headers={},url='/_next/hmr?id=test_request-1')=>({method:'GET',url,headers:{host:'localhost:3100',origin:'http://localhost:3100',connection:'keep-alive, Upgrade',upgrade:'websocket','sec-websocket-version':'13','sec-websocket-key':key,...headers}})
class Socket extends Duplex {
  constructor(){super();this.written=[]}
  _read(){}
  _write(chunk,encoding,done){this.written.push(Buffer.from(chunk));done()}
  _destroy(error,done){done(error)}
  bytes(){return Buffer.concat(this.written).toString()}
}
function fixture({response={},fail=false,hang=false,ready=true}={}) {
  const calls=[],outbounds=[],upstreams=[]
  const relay=createHmrRelay({port:3100,internalPort:45001,isReady:()=>ready,timeoutMs:20,request:options=>{
    calls.push(options)
    const req=new EventEmitter();req.destroyed=false;req.destroy=()=>{req.destroyed=true}
    req.end=()=>queueMicrotask(()=>{
      if(fail){req.emit('error',new Error(secret));return}
      if(hang)return
      const upstream=new Socket();upstreams.push(upstream)
      req.emit('upgrade',{statusCode:101,headers:{upgrade:'websocket',connection:'Upgrade','sec-websocket-accept':accept,...response.headers},...response},upstream,Buffer.from('SERVER_HEAD'))
    })
    outbounds.push(req);return req
  }})
  return {relay,calls,outbounds,upstreams}
}

test('HMR relay syntax',()=>assert.equal(spawnSync(process.execPath,['--check','scripts/turnstile-browser/hmr-relay.mjs']).status,0))
test('only the exact HMR endpoint with valid handshake is admitted',()=>{
  assert.equal(allowedHmrUpgrade(input(),3100),true)
  assert.equal(allowedHmrUpgrade(input({},'/_next/hmr'),3100),true)
  for(const url of ['/api/registrations','/api/unknown','/_next/hmr/extra','/_next/hmr?target=http://external.test','/_next/hmr?id=a&id=b','/_next/hmr?id=','/_next/%68mr','//external.test/_next/hmr','http://external.test/_next/hmr','/_next/hmr#fragment','/_next/hmr?id=a%0d%0aHost:external'])assert.equal(allowedHmrUpgrade(input({},url),3100),false,url)
})
for(const [name,headers] of [
  ['wrong host',{host:'127.0.0.1:3100'}],['wrong port',{host:'localhost:3000'}],['missing host',{host:undefined}],
  ['missing origin',{origin:undefined}],['null origin',{origin:'null'}],['foreign origin',{origin:'https://external.test'}],['origin suffix',{origin:'http://localhost:3100.external.test'}],['wrong origin port',{origin:'http://localhost:3000'}],
  ['wrong upgrade',{upgrade:'h2c'}],['missing connection',{connection:undefined}],['wrong version',{'sec-websocket-version':'12'}],['invalid key',{'sec-websocket-key':secret}],
])test(`reject ${name} without making an upstream connection`,()=>{
  const f=fixture(),client=new Socket()
  f.relay.upgrade(input(headers),client,Buffer.alloc(0))
  assert.equal(client.destroyed,true);assert.equal(f.calls.length,0)
  f.relay.close()
})
test('POST upgrade, API path and unverified startup never reach an upstream',()=>{
  for(const req of [{...input(),method:'POST'},input({},'/api/registrations'),input()]){
    const f=fixture({ready:req.url!=='/_next/hmr?id=test_request-1'||req.method==='POST'}),client=new Socket()
    f.relay.upgrade(req,client,Buffer.alloc(0));assert.equal(client.destroyed,true);assert.equal(f.calls.length,0);f.relay.close()
  }
})
test('target and minimal headers are fixed; cookies, authorization and routing headers are discarded',async()=>{
  const f=fixture(),client=new Socket()
  f.relay.upgrade(input({cookie:secret,authorization:secret,'x-forwarded-host':'external.test','x-real-ip':secret,'sec-websocket-extensions':'permessage-deflate'}),client,Buffer.from('CLIENT_HEAD'))
  await tick()
  assert.equal(f.calls.length,1)
  assert.deepEqual(f.calls[0],{protocol:'http:',hostname:'127.0.0.1',port:45001,path:'/_next/hmr?id=test_request-1',method:'GET',agent:false,headers:{Host:'127.0.0.1:45001',Origin:'http://localhost:3100',Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Key':key,'Sec-WebSocket-Version':'13'}})
  assert.match(client.bytes(),/^HTTP\/1.1 101 Switching Protocols/)
  assert.ok(client.bytes().endsWith('SERVER_HEAD'))
  assert.equal(f.upstreams[0].bytes(),'CLIENT_HEAD')
  assert.doesNotMatch(JSON.stringify(f.calls),new RegExp(secret))
  f.relay.close()
})
test('binary payloads are piped bidirectionally without interpreting or logging them',async()=>{
  const f=fixture(),client=new Socket()
  f.relay.upgrade(input(),client,Buffer.alloc(0));await tick()
  client.push(Buffer.from([0,1,2,255]));f.upstreams[0].push(Buffer.from([255,2,1,0]));await tick()
  assert.deepEqual(Buffer.concat(f.upstreams[0].written),Buffer.from([0,1,2,255]))
  assert.deepEqual(Buffer.concat(client.written).subarray(-4),Buffer.from([255,2,1,0]))
  f.relay.close()
})
for(const response of [{statusCode:200},{headers:{'sec-websocket-accept':secret}},{headers:{upgrade:['websocket']}},{headers:{'sec-websocket-protocol':'arbitrary'}},{headers:{'sec-websocket-extensions':'permessage-deflate'}}])test(`invalid upstream handshake is closed: ${JSON.stringify(Object.keys(response))}`,async()=>{
  const f=fixture({response}),client=new Socket()
  f.relay.upgrade(input(),client,Buffer.alloc(0));await tick()
  assert.equal(client.destroyed,true);assert.equal(f.upstreams[0].destroyed,true)
  assert.equal(client.bytes(),'');assert.equal(f.calls.length,1)
  f.relay.close()
})
test('connection failure does not retry or fall back and does not log upstream errors',async()=>{
  const f=fixture({fail:true}),client=new Socket(),logs=[]
  const original=console.error;console.error=(...args)=>logs.push(args)
  try{f.relay.upgrade(input(),client,Buffer.alloc(0));await tick()}finally{console.error=original;f.relay.close()}
  assert.equal(client.destroyed,true);assert.equal(f.calls.length,1)
  assert.equal(f.calls[0].port,45001);assert.deepEqual(logs,[])
})
test('upgrade deadline destroys the pending request without retrying',async()=>{
  const f=fixture({hang:true}),client=new Socket()
  f.relay.upgrade(input(),client,Buffer.alloc(0));await new Promise(resolve=>setTimeout(resolve,35))
  assert.equal(client.destroyed,true);assert.equal(f.outbounds[0].destroyed,true);assert.equal(f.calls.length,1)
  f.relay.close()
})
test('closing the relay terminates upgraded and pending sessions and rejects further upgrades',async()=>{
  const f=fixture(),clients=[new Socket(),new Socket()]
  for(const client of clients)f.relay.upgrade(input(),client,Buffer.alloc(0))
  await tick();f.relay.close();f.relay.close()
  assert.equal(clients.every(client=>client.destroyed),true)
  assert.equal(f.upstreams.every(socket=>socket.destroyed),true)
  assert.equal(f.outbounds.every(req=>req.destroyed),true)
  const extra=new Socket();f.relay.upgrade(input(),extra,Buffer.alloc(0))
  assert.equal(extra.destroyed,true);assert.equal(f.calls.length,2)
})
test('client disconnect and upstream error terminate only the matching session',async()=>{
  const f=fixture(),one=new Socket(),two=new Socket()
  f.relay.upgrade(input(),one,Buffer.alloc(0));f.relay.upgrade(input(),two,Buffer.alloc(0));await tick()
  one.destroy();await tick()
  assert.equal(f.upstreams[0].destroyed,true);assert.equal(two.destroyed,false)
  f.upstreams[1].emit('error',new Error(secret));await tick()
  assert.equal(two.destroyed,true);f.relay.close()
})
test('invalid target configuration fails without network operations',()=>{
  for(const internalPort of [3000,3100,0,70000,'external.test'])assert.throws(()=>createHmrRelay({port:3100,internalPort,isReady:()=>true}),/INVALID_HMR_RELAY_CONFIGURATION/)
})
test('proxy shutdown invokes HMR cleanup even when HTTP is not listening',async()=>{
  const listeners=new Map()
  const proxy=createProxy(45001,3100,'success',{createServer:()=>({listening:false,on:(event,callback)=>listeners.set(event,callback)})})
  assert.equal(typeof listeners.get('upgrade'),'function')
  await proxy.close()
  const client=new Socket();listeners.get('upgrade')(input(),client,Buffer.alloc(0))
  assert.equal(client.destroyed,true)
})
