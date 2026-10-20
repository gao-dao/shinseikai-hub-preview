import { writeFile, mkdir, mkdtemp, symlink, cp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { Readable } from 'node:stream'
import { createBrowserTestHandler, assertMockResponse, scenarios } from './mock-server.mjs'
import { startBrowserTest, safeDiagnostic } from './startup.mjs'
import { probeMockBoundary } from './probe.mjs'
import { createHmrRelay } from './hmr-relay.mjs'

const root=fileURLToPath(new URL('../../',import.meta.url))
export const testSiteKey='1x00000000000000000000AA'
export const fixtureFiles=[
  'app/(public)/events/page.tsx','app/(public)/events/events-list.tsx','app/(public)/events/registration-form.tsx','app/(public)/events/turnstile-widget.tsx',
  'lib/registrations/public-availability.ts','lib/registrations/public-form.ts','lib/registrations/public-registration.ts','lib/registrations/proxy-registration.ts','lib/registrations/details.ts',
]
export function browserTestEnvironment(parent={}) {
  const env={NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_TURNSTILE_SITE_KEY:testSiteKey}
  for(const key of ['PATH','HOME','TMPDIR','SYSTEMROOT'])if(parent[key])env[key]=parent[key]
  return env
}
export async function prepareBrowserFixture() {
  const directory=await mkdtemp(path.join(os.tmpdir(),'shinseikai-browser-fixture-'))
  try {
    for(const relative of fixtureFiles) {const destination=path.join(directory,relative);await mkdir(path.dirname(destination),{recursive:true});await cp(path.join(root,relative),destination)}
    await symlink(path.join(root,'node_modules'),path.join(directory,'node_modules'),'dir')
    await writeFile(path.join(directory,'package.json'),JSON.stringify({name:'shinseikai-isolated-browser-fixture',private:true,version:'0.0.0'}))
    await writeFile(path.join(directory,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2017',lib:['dom','esnext'],jsx:'react-jsx',module:'esnext',moduleResolution:'bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,resolveJsonModule:true,paths:{'@/*':['./*']}},include:['**/*.ts','**/*.tsx'],exclude:['node_modules']}))
    await writeFile(path.join(directory,'next.config.js'),"module.exports={allowedDevOrigins:['localhost','127.0.0.1']}\n")
    await writeFile(path.join(directory,'app/layout.tsx'),"export default function Layout({children}:{children:React.ReactNode}){return <html lang=\"ja\"><body>{children}</body></html>}\n")
    // Defense in depth: even direct access to the private fixture's port has no
    // real registration route, database modules, credentials or auth bypass.
    const api=path.join(directory,'app/api/registrations');await mkdir(api,{recursive:true})
    await writeFile(path.join(api,'route.ts'),"export async function POST(){return Response.json({success:false,code:'TEST_PROXY_REQUIRED'},{status:503,headers:{'Cache-Control':'no-store'}})}\n")
    return directory
  } catch(error) {await rm(directory,{recursive:true,force:true});throw error}
}
async function reservePort() {
  const server=http.createServer()
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const port=server.address().port
  await new Promise(resolve=>server.close(resolve))
  return port
}
export async function verifyMockWiring() {
  let forwarded=false
  const origin='http://localhost:3100'
  const mock=createBrowserTestHandler({origin,scenario:'success',forward:async()=>{forwarded=true;throw new Error('API_FORWARDED')}})
  const response=await mock.handle(new Request(origin+'/api/registrations',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','Idempotency-Key':'12345678-1234-4234-8234-123456789abc'},body:JSON.stringify({event_group_id:900001,name:'合成',contact:'synthetic.invalid',notes:null,schedule_ids:[900011,900012],turnstile_token:'synthetic-token'})}))
  assertMockResponse(response)
  if(forwarded||response.status!==201||mock.summary().registration_posts!==1)throw new Error('BROWSER_TEST_MOCK_NOT_APPLIED')
}
export function isAllowedProxyHost(host, port) {
  return host === `localhost:${port}`
}
export function createProxy(internalPort, port, scenario, {createServer=http.createServer, probeRequest=http.request} = {}) {
  const origin = `http://localhost:${port}`
  const mock = createBrowserTestHandler({origin,scenario,forward:request=>fetch(`http://127.0.0.1:${internalPort}${new URL(request.url).pathname}${new URL(request.url).search}`,{redirect:'error',signal:AbortSignal.timeout(10000)})})
  let verified=false
  const server = createServer(async (incoming, outgoing) => {
    try {
      if(!isAllowedProxyHost(incoming.headers.host,port)){outgoing.writeHead(403,{'Cache-Control':'no-store'});outgoing.end();return}
      if(!verified && !(incoming.method==='GET' && ['/__test/status','/api/registrations','/api/unconfigured-browser-test'].includes(incoming.url))){outgoing.writeHead(503,{'Cache-Control':'no-store'});outgoing.end();return}
      const request=new Request(origin+incoming.url,{method:incoming.method,headers:incoming.headers,...(['GET','HEAD'].includes(incoming.method)?{}:{body:Readable.toWeb(incoming),duplex:'half'})})
      const response=await mock.handle(request)
      outgoing.writeHead(response.status,Object.fromEntries(response.headers))
      if(response.body)Readable.fromWeb(response.body).pipe(outgoing);else outgoing.end()
    } catch {outgoing.writeHead(503,{'Cache-Control':'no-store'});outgoing.end('Browser test request failed')}
  })
  const hmr=createHmrRelay({port,internalPort,isReady:()=>verified})
  server.on('upgrade',hmr.upgrade)
  return {
    async checkMock() {
      for (const [pathname,status] of [['/api/registrations',405],['/api/unconfigured-browser-test',503]]) {
        const response=await mock.handle(new Request(origin+pathname))
        try { assertMockResponse(response) } catch { throw Object.assign(new Error('BROWSER_TEST_MOCK_NOT_APPLIED'),{startupHttpStatus:response.status}) }
        if(response.status!==status)throw Object.assign(new Error('BROWSER_TEST_MOCK_NOT_APPLIED'),{startupHttpStatus:response.status})
      }
    },
    listen:()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)}),
    async probeMock() {
      await probeMockBoundary(port,{request:probeRequest})
      if(mock.summary().forwarded_api_requests!==0)throw new Error('BROWSER_TEST_MOCK_NOT_APPLIED')
      verified=true
    },
    summary:mock.summary,
    close:()=>new Promise((resolve,reject)=>{
      hmr.close()
      if(!server.listening){resolve();return}
      server.close(error=>error?reject(error):resolve())
      server.closeAllConnections()
    }),
  }
}
async function stopChild(child) {
  if(!child.pid || child.exitCode!==null || child.signalCode!==null)return
  await new Promise(resolve=>{
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000)
    child.once('exit',()=>{clearTimeout(timer);resolve()})
    child.kill('SIGTERM')
  })
}
async function main() {
  let values
  try {
    ;({values}=parseArgs({options:{start:{type:'boolean'},'official-test-sitekey':{type:'boolean'},scenario:{type:'string',default:'success'},port:{type:'string',default:'3100'}}}))
    if(!values.start||!values['official-test-sitekey']||!scenarios.includes(values.scenario)||!/^\d+$/.test(values.port)||Number(values.port)<1024||Number(values.port)>65535)throw new Error()
  } catch {
    console.error(JSON.stringify(safeDiagnostic({stage:'NEXT_START',outcome:'failed',classification:'UNKNOWN_STARTUP_FAILURE'})))
    console.error('Browser test setup failed; no real API fallback is allowed.')
    process.exitCode=1;return
  }
  const port=Number(values.port)
  const result=await startBrowserTest({
    verifyMock:verifyMockWiring,
    prepare:prepareBrowserFixture,
    reservePort,
    spawn:(directory,internalPort)=>spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'dev',directory,'--webpack','--hostname','127.0.0.1','--port',String(internalPort)],{cwd:directory,env:browserTestEnvironment(process.env),stdio:['ignore','pipe','pipe']}),
    createProxy:internalPort=>createProxy(internalPort,port,values.scenario),
    fetchEvents:internalPort=>fetch(`http://127.0.0.1:${internalPort}/events`,{redirect:'error',signal:AbortSignal.timeout(1000)}),
    pause:()=>new Promise(resolve=>setTimeout(resolve,250)),
    stopChild,
    removeFixture:directory=>rm(directory,{recursive:true,force:true}),
    report:diagnostic=>console.error(JSON.stringify(diagnostic)),
    onUnexpectedExit:()=>{process.exitCode=1},
  })
  if(!result.ok){console.error('Browser test setup failed; no real API fallback is allowed.');process.exitCode=1;return}
  console.log(JSON.stringify({ready:true,url:`http://localhost:${port}/events`,scenario:values.scenario,mode:'isolated-browser-test',real_registration_blocked:true}))
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{console.log(JSON.stringify(result.summary()));void result.cleanup()})
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main()
