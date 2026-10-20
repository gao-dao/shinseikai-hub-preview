import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {PassThrough, Writable} from 'node:stream'
import {spawnSync} from 'node:child_process'
import {requestMockProbe,probeMockBoundary} from '../scripts/turnstile-browser/probe.mjs'
import {createProxy,isAllowedProxyHost} from '../scripts/turnstile-browser/start.mjs'
import {mockHeader,mockMarker,createBrowserTestHandler} from '../scripts/turnstile-browser/mock-server.mjs'
import {safeDiagnostic,safeCommunicationCode} from '../scripts/turnstile-browser/startup.mjs'

const secret='SECRET_TOKEN_PERSON_SOURCE_DO_NOT_LOG'
const port=3100
function transport(reply) {
  const calls=[],requests=[]
  const request=(options,callback)=>{
    calls.push(options)
    const req=new EventEmitter();req.destroyed=false
    req.destroy=()=>{req.destroyed=true}
    req.end=()=>queueMicrotask(()=>reply(options,callback,req))
    requests.push(req);return req
  }
  return {request,calls,requests}
}
function respond(callback,{status=200,headers={[mockHeader]:mockMarker},body='{}'}={}) {
  const incoming=new PassThrough();incoming.statusCode=status;incoming.headers=headers
  callback(incoming);incoming.complete=true;incoming.end(body)
  return incoming
}
function goodTransport() {
  return transport((options,callback)=>{
    if(options.headers.Host!==`localhost:${port}`){respond(callback,{status:403,headers:{},body:''});return}
    const status=options.path==='/__test/status'?200:options.path==='/api/registrations'?405:503
    respond(callback,{status,body:JSON.stringify({mode:'isolated-browser-test',forwarded_api_requests:0})})
  })
}

test('probe module syntax check',()=>assert.equal(spawnSync(process.execPath,['--check','scripts/turnstile-browser/probe.mjs']).status,0))
test('probe preserves Host with http.request and fixes connection, port, GET and paths',async()=>{
  const mock=goodTransport()
  await probeMockBoundary(port,{request:mock.request})
  assert.equal(mock.calls.length,4)
  assert.deepEqual(mock.calls.map(call=>call.path),['/__test/status','/api/registrations','/api/unconfigured-browser-test','/__test/status'])
  for(const call of mock.calls){
    assert.equal(call.hostname,'127.0.0.1');assert.equal(call.port,port);assert.equal(call.protocol,'http:')
    assert.equal(call.method,'GET');assert.equal(call.agent,false)
    assert.equal(call.port===3000,false)
  }
  assert.deepEqual(mock.calls.map(call=>call.headers.Host),[`localhost:${port}`,`localhost:${port}`,`localhost:${port}`,`127.0.0.1:${port}`])
})
test('proxy Host policy remains exact and rejects alternate, multiple and foreign hosts',()=>{
  assert.equal(isAllowedProxyHost('localhost:3100',3100),true)
  for(const host of [undefined,'127.0.0.1:3100','localhost:3000','localhost:3100,attacker.test','attacker.test','LOCALHOST:3100'])assert.equal(isAllowedProxyHost(host,3100),false)
})
for(const path of ['/__test/status','/api/registrations','/api/unconfigured-browser-test'])test(`missing marker fails even with expected status: ${path}`,async()=>{
  const mock=goodTransport(),request=(options,callback)=>{
    if(options.path===path)return transport((o,cb)=>respond(cb,{status:path==='/__test/status'?200:path==='/api/registrations'?405:503,headers:{},body:secret})).request(options,callback)
    return mock.request(options,callback)
  }
  await assert.rejects(probeMockBoundary(port,{request}),error=>error.message==='BROWSER_TEST_MOCK_NOT_APPLIED'&&!JSON.stringify(error).includes(secret))
})
for(const status of [201,302,403,500])test(`wrong HTTP status ${status} fails despite valid marker`,async()=>{
  const mock=transport((o,cb)=>respond(cb,{status,body:secret}))
  await assert.rejects(probeMockBoundary(port,{request:mock.request}),error=>error.startupHttpStatus===status)
  assert.equal(mock.calls.length,1)
})
test('wrong marker is never trusted',async()=>{
  const mock=transport((o,cb)=>respond(cb,{headers:{[mockHeader]:'untrusted'},body:secret}))
  await assert.rejects(probeMockBoundary(port,{request:mock.request}),/BROWSER_TEST_MOCK_NOT_APPLIED/)
})
test('health payload must identify isolated mode and zero forwarded APIs',async()=>{
  for(const body of [secret,'null',JSON.stringify({mode:'production',forwarded_api_requests:0}),JSON.stringify({mode:'isolated-browser-test',forwarded_api_requests:1}),JSON.stringify({mode:'isolated-browser-test'})]){
    const mock=transport((o,cb)=>respond(cb,{body}))
    await assert.rejects(probeMockBoundary(port,{request:mock.request}),error=>error.code==='PROBE_RESPONSE_INVALID')
  }
})
test('invalid Host must be denied without a mock success marker',async()=>{
  for(const [status,headers] of [[200,{}],[403,{[mockHeader]:mockMarker}]]){
    const good=goodTransport()
    const request=(options,cb)=>options.headers.Host===`localhost:${port}`?good.request(options,cb):transport((o,callback)=>respond(callback,{status,headers})).request(options,cb)
    await assert.rejects(probeMockBoundary(port,{request}),/BROWSER_TEST_MOCK_NOT_APPLIED/)
  }
})
test('absolute timeout aborts only this probe without retries or raw errors',async()=>{
  const mock=transport(()=>{})
  await assert.rejects(requestMockProbe(port,'/__test/status',{request:mock.request,timeoutMs:5}),error=>error.code==='ETIMEDOUT'&&error.message==='BROWSER_TEST_MOCK_NOT_APPLIED')
  assert.equal(mock.calls.length,1);assert.equal(mock.requests[0].destroyed,true)
})
test('response size overflow destroys probe resources and fails closed',async()=>{
  let response
  const mock=transport((o,callback)=>{response=respond(callback,{body:secret.repeat(500)})})
  await assert.rejects(requestMockProbe(port,'/__test/status',{request:mock.request,maxBytes:32}),error=>error.code==='PROBE_RESPONSE_TOO_LARGE')
  assert.equal(response.destroyed,true);assert.equal(mock.requests[0].destroyed,true)
})
test('network error code is allowlisted and upstream message never survives',async()=>{
  for(const code of ['ECONNREFUSED',secret]){
    const mock=transport((o,cb,req)=>req.emit('error',Object.assign(new Error(secret),{code})))
    await assert.rejects(requestMockProbe(port,'/__test/status',{request:mock.request}),error=>{
      assert.equal(error.code,code==='ECONNREFUSED'?code:undefined)
      assert.doesNotMatch(JSON.stringify(error)+error.message,new RegExp(secret))
      assert.doesNotMatch(JSON.stringify(safeDiagnostic({stage:'MOCK_CHECK',outcome:'failed',communication_code:safeCommunicationCode(error)})),new RegExp(secret))
      return true
    })
    assert.equal(mock.calls.length,1)
  }
})
test('aborted response cannot be mistaken for a complete valid response',async()=>{
  const mock=transport((o,cb)=>{const incoming=new PassThrough();incoming.statusCode=200;incoming.headers={[mockHeader]:mockMarker};cb(incoming);incoming.emit('aborted')})
  await assert.rejects(requestMockProbe(port,'/__test/status',{request:mock.request}),error=>error.code==='ECONNRESET')
})
test('invalid ports and non-allowlisted paths never call any transport',async()=>{
  const mock=goodTransport()
  for(const [p,path] of [[300,'/__test/status'],[NaN,'/__test/status'],[3100,'http://external.test'],[3100,'/events'],[3100,'/api/admin']])await assert.rejects(requestMockProbe(p,path,{request:mock.request}))
  assert.equal(mock.calls.length,0)
})

// Exercise the actual proxy HTTP callback using streams, without opening sockets.
function proxyFixture({broken=false}={}) {
  let handler
  const server={on(){},listening:false}
  const invoke=(options,callback)=>{
    const req=new EventEmitter();req.destroy=()=>{}
    req.end=()=>queueMicrotask(async()=>{
      const incoming=new PassThrough();incoming.method=options.method;incoming.url=options.path;incoming.headers={host:options.headers.Host}
      const response=new PassThrough();response.headers={};response.complete=false
      const outgoing=new Writable({write(chunk,encoding,done){response.write(chunk);done()}})
      outgoing.writeHead=(status,headers={})=>{response.statusCode=status;response.headers=headers;callback(response)}
      outgoing.on('finish',()=>{response.complete=true;response.end()})
      await handler(incoming,outgoing)
    })
    return req
  }
  const proxy=createProxy(45001,port,'success',{createServer:callback=>{handler=callback;return server},probeRequest:broken?transport((o,cb)=>respond(cb,{headers:{},body:secret})).request:invoke})
  return {proxy,invoke}
}
test('real proxy callback validates all probes without a socket and keeps pre-ready UI closed',async()=>{
  const f=proxyFixture()
  // Test the admission callback directly for a page without ever forwarding it.
  const before=await new Promise(resolve=>f.invoke({method:'GET',path:'/events',headers:{Host:`localhost:${port}`}},resolve).end())
  assert.equal(before.statusCode,503)
  await f.proxy.probeMock()
  assert.equal(f.proxy.summary().registration_posts,0)
  assert.equal(f.proxy.summary().forwarded_api_requests,0)
})
test('failed verification never exposes frontend routes',async()=>{
  const f=proxyFixture({broken:true})
  await assert.rejects(f.proxy.probeMock())
  const response=await new Promise(resolve=>f.invoke({method:'GET',path:'/events',headers:{Host:`localhost:${port}`}},resolve).end())
  assert.equal(response.statusCode,503)
})
test('POST is terminated by mock, unknown APIs are blocked and neither is forwarded',async()=>{
  let forwarded=0
  const mock=createBrowserTestHandler({origin:'http://localhost:3100',scenario:'success',forward:async()=>{forwarded++;throw new Error('FORBIDDEN')}})
  const input={event_group_id:900001,name:'synthetic',contact:'synthetic.invalid',notes:null,schedule_ids:[900011],turnstile_token:'synthetic-token'}
  const response=await mock.handle(new Request('http://localhost:3100/api/registrations',{method:'POST',headers:{Origin:'http://localhost:3100','Content-Type':'application/json','Idempotency-Key':'12345678-1234-4234-8234-123456789abc'},body:JSON.stringify(input)}))
  assert.equal(response.status,201);assert.equal(response.headers.get(mockHeader),mockMarker)
  assert.equal((await mock.handle(new Request('http://localhost:3100/api/unknown'))).status,503)
  assert.equal(forwarded,0)
})
