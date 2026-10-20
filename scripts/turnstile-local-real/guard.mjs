import {createHash} from 'node:crypto'

const knownCodes=new Set(['TURNSTILE_CONFIG_ERROR','TURNSTILE_INVALID_TOKEN','TURNSTILE_REJECTED','TURNSTILE_UNAVAILABLE','TURNSTILE_TIMEOUT'])
export function createVerificationHandler({port,allowSiteverify,verify,maxCalls=3}) {
  if(!Number.isInteger(port)||port<1024||port>65535||[3000,3100].includes(port)||!Number.isInteger(maxCalls)||maxCalls<1||maxCalls>3)throw new Error('INVALID_LOCAL_TEST_CONFIG')
  const seen=new Set();let calls=0,busy=false,closed=false
  const reply=(code,status)=>Response.json({ok:code==='VERIFIED',code},{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})
  return {
    close(){closed=true},
    async handle(request) {
      if(closed||allowSiteverify!==true)return reply('DISABLED',503)
      if(request.headers.get('host')!==`localhost:${port}`||request.headers.get('origin')!==`http://localhost:${port}`)return reply('ACCESS_REJECTED',403)
      if(new URL(request.url).pathname!=='/api/turnstile-check')return reply('NOT_FOUND',404)
      if(request.method!=='POST')return reply('METHOD_REJECTED',405)
      if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply('INVALID_INPUT',415)
      let input,bodyTimer,reader
      try {
        reader=request.body?.getReader();if(!reader)throw new Error()
        const body=async()=>{const chunks=[];let size=0
          for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096)throw new Error('BODY_TOO_LARGE');chunks.push(value)}
          return JSON.parse(Buffer.concat(chunks).toString('utf8'))}
        input=await Promise.race([body(),new Promise((_,reject)=>{bodyTimer=setTimeout(()=>reject(new Error('BODY_TIMEOUT')),3000)})])
      }catch(error){void reader?.cancel().catch(()=>{});return reply(error?.message==='BODY_TOO_LARGE'?'BODY_TOO_LARGE':'INVALID_INPUT',error?.message==='BODY_TOO_LARGE'?413:400)}finally{clearTimeout(bodyTimer)}
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||typeof input.token!=='string'||!/^[!-~]{1,2048}$/.test(input.token))return reply('INVALID_INPUT',400)
      if(busy)return reply('BUSY',409)
      const digest=createHash('sha256').update(input.token).digest('hex')
      if(seen.has(digest))return reply('TOKEN_ALREADY_SENT',409)
      if(calls>=maxCalls)return reply('CALL_LIMIT',429)
      // Mark before awaiting. An uncertain outcome never makes this token reusable.
      seen.add(digest);calls++;busy=true
      try {
        const result=await verify(input.token)
        if(result?.ok===true)return reply('VERIFIED',200)
        const code=knownCodes.has(result?.code)?result.code:'TURNSTILE_UNAVAILABLE'
        return reply(code,['TURNSTILE_CONFIG_ERROR','TURNSTILE_UNAVAILABLE','TURNSTILE_TIMEOUT'].includes(code)?503:403)
      }catch{return reply('TURNSTILE_UNAVAILABLE',503)}finally{busy=false;input=null}
    },
  }
}
