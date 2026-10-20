import {writeFile,readFile,mkdir,mkdtemp,symlink,cp,rm} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {parseArgs} from 'node:util'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import {hiddenInput} from './input.mjs'
import {observeNextOutput,safeDiagnostic,safeCommunicationCode} from '../turnstile-browser/startup.mjs'

const root=fileURLToPath(new URL('../../',import.meta.url))
export function validateKeys(site,secret){
  return [site,secret].every(value=>typeof value==='string'&&/^[!-~]{1,512}$/.test(value)&&!/^\d+x0{10,}/.test(value))&&site!==secret
}
export function childEnvironment({site,secret,port,allow},parent={}){
  if(allow!==true||!validateKeys(site,secret)||!Number.isInteger(port)||port<1024||port>65535||[3000,3100].includes(port))throw new Error('INVALID_LOCAL_TEST_CONFIG')
  const env={NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',LOCAL_REAL_SITE_KEY:site,TURNSTILE_SECRET_KEY:secret,TURNSTILE_ALLOWED_HOSTNAMES:'localhost',TURNSTILE_EXPECTED_ACTION:'registration',LOCAL_REAL_PORT:String(port),LOCAL_REAL_ALLOW_SITEVERIFY:'1'}
  for(const name of ['PATH','HOME','TMPDIR','SYSTEMROOT'])if(parent[name])env[name]=parent[name]
  return env
}
export async function prepareFixture(){
  const directory=await mkdtemp(path.join(os.tmpdir(),'shinseikai-local-real-'))
  try{
    const copies=[
      ['lib/security/turnstile.ts','lib/security/turnstile.ts'],
      ['scripts/turnstile-local-real/page.tsx.template','app/turnstile-check/page.tsx'],
      ['scripts/turnstile-local-real/route.ts.template','app/api/turnstile-check/route.ts'],
      ['scripts/turnstile-local-real/guard.mjs','lib/local-real/guard.mjs'],
      ['scripts/turnstile-local-real/proxy.ts.template','proxy.ts'],
    ]
    for(const [source,target] of copies){await mkdir(path.dirname(path.join(directory,target)),{recursive:true});await cp(path.join(root,source),path.join(directory,target))}
    // Runtime public-key delivery avoids embedding even the Site Key in build files.
    let widget=await readFile(path.join(root,'app/(public)/events/turnstile-widget.tsx'),'utf8')
    const changes=[['{ onToken, generation }:','{ onToken, generation, siteKey }:'],['generation: number }','generation: number; siteKey: string }'],['const sitekey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY','const sitekey = siteKey']]
    for(const [before,after] of changes){if(widget.split(before).length!==2)throw new Error();widget=widget.replace(before,after)}
    await writeFile(path.join(directory,'app/turnstile-check/turnstile-widget.tsx'),widget)
    await mkdir(path.join(directory,'app/local-test/site-key'),{recursive:true})
    await writeFile(path.join(directory,'app/local-test/site-key/route.ts'),"export const dynamic='force-dynamic';export function GET(){return Response.json({siteKey:process.env.LOCAL_REAL_SITE_KEY},{headers:{'Cache-Control':'no-store'}})}\n")
    await symlink(path.join(root,'node_modules'),path.join(directory,'node_modules'),'dir')
    await writeFile(path.join(directory,'package.json'),JSON.stringify({name:'isolated-local-real-turnstile',private:true,version:'0.0.0'}))
    await writeFile(path.join(directory,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2017',lib:['dom','esnext'],jsx:'react-jsx',module:'esnext',moduleResolution:'bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,resolveJsonModule:true,paths:{'@/*':['./*']}},include:['**/*.ts','**/*.tsx'],exclude:['node_modules']}))
    await writeFile(path.join(directory,'next.config.js'),"module.exports={allowedDevOrigins:['localhost']}\n")
    await writeFile(path.join(directory,'app/layout.tsx'),'export default function Layout({children}:{children:React.ReactNode}){return <html lang="ja"><body>{children}</body></html>}\n')
    await mkdir(path.join(directory,'app/local-test/status'),{recursive:true})
    await writeFile(path.join(directory,'app/local-test/status/route.ts'),"export function GET(){return Response.json({mode:'local-real-turnstile-only'},{headers:{'Cache-Control':'no-store'}})}\n")
    return directory
  }catch{await rm(directory,{recursive:true,force:true});throw new Error('FIXTURE_CREATE_FAILED')}
}
export function createCleanup({child,directory,remove=dir=>rm(dir,{recursive:true,force:true}),stop=stopChild}){
  let closing
  return ()=>closing??=(async()=>{
    let failed=false
    if(child){try{await stop(child)}catch{failed=true}}
    // Do not delete a still-running child's files if termination failed.
    if(directory&&!failed){try{await remove(directory)}catch{failed=true}}
    if(failed)throw new Error('CLEANUP_FAILED')
  })()
}
async function stopChild(child){
  if(!child.pid||child.exitCode!==null||child.signalCode!==null)return
  await new Promise((resolve,reject)=>{
    const deadline=setTimeout(()=>{child.kill('SIGKILL')},5000)
    const final=setTimeout(()=>{clearTimeout(deadline);reject(new Error('CLEANUP_FAILED'))},10000)
    child.once('exit',()=>{clearTimeout(deadline);clearTimeout(final);resolve()});child.kill('SIGTERM')
  })
}
function healthError(classification,status,code){
  return Object.assign(new Error('HEALTH_CHECK_FAILED'),{
    startupClassification:classification,
    ...(Number.isInteger(status)?{startupHttpStatus:status}:{}),
    ...(code?{code}:{}),
  })
}
// GET health only. No registration or Siteverify request is made during startup.
export function healthProbe(port,{request=http.request,timeoutMs=2000}={}){
  return new Promise((resolve,reject)=>{
    let req,response,body='',bytes=0,done=false
    const finish=(error)=>{
      if(done)return
      done=true;clearTimeout(timer)
      if(error){response?.destroy();req?.destroy();reject(error)}else{req?.destroy();resolve({http_status:200})}
    }
    const communicationError=error=>finish(healthError('UNKNOWN_STARTUP_FAILURE',response?.statusCode,safeCommunicationCode(error)))
    const timer=setTimeout(()=>finish(healthError('STARTUP_TIMEOUT',response?.statusCode,'ETIMEDOUT')),timeoutMs)
    try{
      req=request({hostname:'127.0.0.1',port,path:'/local-test/status',method:'GET',headers:{Host:`localhost:${port}`},agent:false},incoming=>{
        response=incoming
        response.on('error',communicationError)
        response.on('aborted',()=>communicationError({code:'ECONNRESET'}))
        response.on('close',()=>{if(!response.complete)communicationError({code:'ECONNRESET'})})
        if(response.statusCode!==200){finish(healthError('HTTP_ERROR',response.statusCode));return}
        response.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024)finish(healthError('HTTP_ERROR',response.statusCode,'PROBE_RESPONSE_TOO_LARGE'));else body+=chunk.toString('utf8')})
        response.on('end',()=>{try{if(JSON.parse(body).mode==='local-real-turnstile-only')finish();else finish(healthError('HTTP_ERROR',200))}catch{finish(healthError('HTTP_ERROR',200))}})
      })
      req.on('error',communicationError);req.end()
    }catch(error){communicationError(error)}
  })
}
export async function waitForHealth(port,{probe=healthProbe,pause=()=>new Promise(resolve=>setTimeout(resolve,250)),attempts=80,isStopped=()=>false}={}){
  let last
  for(let index=0;index<attempts&&!isStopped();index++){
    try{const result=await probe(port);if(isStopped())throw healthError('UNKNOWN_STARTUP_FAILURE');return result}catch(error){
      last=error
      if(error?.startupClassification==='HTTP_ERROR')throw error
    }
    await pause()
  }
  throw healthError('STARTUP_TIMEOUT',last?.startupHttpStatus,safeCommunicationCode(last))
}
export function observeChildExit(child,onUnexpectedExit){
  let expected=false
  const listener=(code,signal)=>{if(!expected){expected=true;onUnexpectedExit(code,signal)}}
  child.once('exit',listener)
  return {expectStop(){expected=true},dispose(){child.off('exit',listener)}}
}
async function main(){
  let directory,child,cleanup=async()=>{},stage='NEXT_START',nextError=null,interrupted=false,exitObserver
  const diagnostic=(classification,error)=>console.error(JSON.stringify(safeDiagnostic({stage,outcome:'failed',classification,communication_code:safeCommunicationCode(error),http_status:error?.startupHttpStatus,next_error:nextError,child_exit_code:child?.exitCode,child_exit_signal:child?.signalCode})))
  const stop=()=>{interrupted=true;void cleanup().catch(()=>diagnostic('CLEANUP_FAILED'))}
  process.once('SIGINT',stop);process.once('SIGTERM',stop)
  try{
    const {values}=parseArgs({options:{start:{type:'boolean'},'allow-siteverify':{type:'boolean'},'confirm-local-widget':{type:'boolean'},port:{type:'string',default:'3200'}}})
    if(!values.start||!values['allow-siteverify']||!values['confirm-local-widget']||!/^\d+$/.test(values.port)||Number(values.port)<1024||Number(values.port)>65535||[3000,3100].includes(Number(values.port)))throw new Error()
    const port=Number(values.port)
    console.error('shinseikai-hub-local-test のSite KeyとSecret Keyだけを入力してください。既存設定は読み込みません。')
    let site=await hiddenInput('専用Site Key'),secret=await hiddenInput('専用Secret Key')
    if(interrupted)throw new Error()
    const env=childEnvironment({site,secret,port,allow:true},process.env);site='';secret=''
    stage='FIXTURE_CREATE';directory=await prepareFixture()
    cleanup=createCleanup({directory})
    if(interrupted)throw new Error()
    stage='NEXT_START'
    child=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'dev',directory,'--webpack','--hostname','127.0.0.1','--port',String(port)],{cwd:directory,env,stdio:['ignore','pipe','pipe']})
    cleanup=createCleanup({child,directory})
    const observers=[observeNextOutput(child.stdout,value=>{nextError=value}),observeNextOutput(child.stderr,value=>{nextError=value})]
    const clean=cleanup;cleanup=async()=>{exitObserver?.expectStop();try{await clean()}finally{for(const remove of observers)remove();exitObserver?.dispose()}}
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)})
    child.on('error',()=>{diagnostic('UNKNOWN_STARTUP_FAILURE');stop()})
    exitObserver=observeChildExit(child,()=>{diagnostic(nextError??'CHILD_EARLY_EXIT');process.exitCode=1;stop()})
    stage='EVENTS_HTTP'
    await waitForHealth(port,{isStopped:()=>interrupted||child.exitCode!==null||child.signalCode!==null})
    console.log(JSON.stringify({ready:true,mode:'local-real-turnstile-only',url:`http://localhost:${port}/turnstile-check`,siteverify_limit:3}))
  }catch(error){diagnostic(nextError??(['HTTP_ERROR','STARTUP_TIMEOUT'].includes(error?.startupClassification)?error.startupClassification:'UNKNOWN_STARTUP_FAILURE'),error);process.exitCode=1;await cleanup().catch(()=>diagnostic('CLEANUP_FAILED'))}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main()
