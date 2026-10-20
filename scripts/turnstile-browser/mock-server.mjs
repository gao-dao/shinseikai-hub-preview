import { createHmac, randomBytes } from 'node:crypto'

export const mockHeader = 'x-shinseikai-browser-test'
export const mockMarker = 'mock-only-v1'
export const scenarios = ['success', 'full', 'unknown-retry', 'slow-success']
const group = { id: 900001, title: 'ブラウザテスト専用講習会（合成データ）', description: '実際の申込は登録されません。' }
const classes = [1,2,3].map((value) => ({ id: 900010 + value, title: `合成クラス${value}`, date: '2030-01-01', start_time: '10:00', end_time: '11:00', capacity: 10, remainingCapacity: value === 3 ? 0 : 8, canRegister: value !== 3, status: value === 3 ? '満員' : '受付可能' }))
export function assertMockResponse(response) {
  if (response.headers.get(mockHeader) !== mockMarker) throw new Error('BROWSER_TEST_MOCK_NOT_APPLIED')
}

// All API requests terminate here, even when no matching fixture is available.
// forward receives only allowlisted GET assets/pages, never an API request.
export function createBrowserTestHandler({ origin, scenario, forward, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!scenarios.includes(scenario) || !/^http:\/\/(?:localhost|127\.0\.0\.1):[0-9]+$/.test(origin)) throw new Error('INVALID_BROWSER_TEST_CONFIGURATION')
  const signingKey = randomBytes(32), attempts = new Map()
  const stats = { registration_posts: 0, successful_mock_responses: 0, business_errors: 0, unknown_responses: 0, replay_matches: 0, token_changes: 0, invalid_requests: 0, forwarded_api_requests: 0 }
  const digest = value => createHmac('sha256', signingKey).update(value).digest('hex')
  const json = (body,status=200) => Response.json(body,{status,headers:{'Cache-Control':'no-store',[mockHeader]:mockMarker}})
  const summary = () => ({ mode:'isolated-browser-test',scenario,...stats,distinct_attempts:attempts.size })
  async function handle(request) {
    let url, pathname
    try { url=new URL(request.url);pathname=decodeURIComponent(url.pathname) } catch { return json({error:'Invalid test request'},400) }
    if (url.origin !== origin) return json({error:'Invalid test origin'},403)
    if(pathname.split('/').some(part=>part==='.'||part==='..'))return json({error:'Invalid test path'},400)
    if (request.method==='GET' && pathname==='/__test/status') return json(summary())
    if (pathname==='/api/registrations') {
      if(request.method!=='POST') return json({error:'POST only'},405)
      stats.registration_posts++
      if(request.headers.get('origin')!==origin || request.headers.get('content-type')?.split(';')[0]!=='application/json') {stats.invalid_requests++;return json({success:false,code:'TEST_INVALID_INPUT'},400)}
      let input
      try {
        const reader=request.body?.getReader();if(!reader)throw new Error('empty')
        const chunks=[];let size=0
        for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768){void reader.cancel().catch(()=>{});throw new Error('large')}chunks.push(value)}
        input=JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }catch{stats.invalid_requests++;return json({success:false,code:'TEST_INVALID_INPUT'},400)}
      const key=request.headers.get('idempotency-key')
      if(!key || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key) || !input || typeof input!=='object' || Array.isArray(input) ||
        Object.keys(input).some(key=>!['event_group_id','name','contact','notes','schedule_ids','turnstile_token'].includes(key)) ||
        input.event_group_id!==group.id || typeof input.name!=='string' || !input.name.trim() || typeof input.contact!=='string' || !input.contact.trim() ||
        !(input.notes===null||typeof input.notes==='string') || !Array.isArray(input.schedule_ids) || !input.schedule_ids.length || input.schedule_ids.some(id=>![900011,900012].includes(id)) || new Set(input.schedule_ids).size!==input.schedule_ids.length ||
        typeof input.turnstile_token!=='string' || !/^[!-~]{1,2048}$/.test(input.turnstile_token)) {stats.invalid_requests++;return json({success:false,code:'TEST_INVALID_INPUT'},400)}
      // Only per-run HMAC digests survive this request; no applicant body, token
      // or raw idempotency key is stored in logs, metrics, files or browser data.
      const keyDigest=digest(key.toLowerCase())
      const fingerprint=digest(JSON.stringify([input.event_group_id,input.name,input.contact,input.notes,[...input.schedule_ids].sort((a,b)=>a-b)]))
      const tokenDigest=digest(input.turnstile_token)
      const previous=attempts.get(keyDigest)
      if(previous && previous.fingerprint!==fingerprint) {stats.invalid_requests++;return json({success:false,code:'IDEMPOTENCY_CONFLICT',message:'テスト内容が変更されています'},409)}
      if(previous){stats.replay_matches++;if(previous.token!==tokenDigest)stats.token_changes++}
      const count=(previous?.count??0)+1
      attempts.set(keyDigest,{fingerprint,token:tokenDigest,count})
      if(scenario==='full'){stats.business_errors++;return json({success:false,code:'CAPACITY_EXCEEDED',message:'合成の満員応答'},409)}
      if(scenario==='unknown-retry'&&count===1){stats.unknown_responses++;return json({success:false,code:'REGISTRATION_RESULT_UNKNOWN',message:'合成の結果不明応答'},503)}
      if(scenario==='slow-success')await delay(2500)
      stats.successful_mock_responses++
      return json({success:true,code:'REGISTERED',message:'合成の成功応答'},201)
    }
    if(pathname==='/api/event-groups'&&request.method==='GET')return json({eventGroups:[group],page:1,pageSize:50,total:1})
    if(pathname===`/api/event-groups/${group.id}/classes`&&request.method==='GET')return json({schedules:classes,page:1,pageSize:50,total:classes.length})
    if(pathname==='/api'||pathname.startsWith('/api/'))return json({error:'No real API is reachable from this test environment'},503)
    if(pathname==='/'&&request.method==='GET')return new Response(null,{status:302,headers:{Location:'/events','Cache-Control':'no-store',[mockHeader]:mockMarker}})
    if(request.method==='GET'&&(pathname==='/events'||pathname.startsWith('/_next/static/'))) {
      const response=await forward(request)
      const headers=new Headers(response.headers);headers.set(mockHeader,mockMarker);headers.set('Cache-Control','no-store')
      // Node fetch decodes compressed bodies. Do not forward stale wire headers.
      headers.delete('content-encoding');headers.delete('content-length')
      return new Response(response.body,{status:response.status,headers})
    }
    return json({error:'Path blocked in isolated browser test'},404)
  }
  return {handle,summary}
}
