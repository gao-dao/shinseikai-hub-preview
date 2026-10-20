import http from 'node:http'
import { mockHeader, mockMarker } from './mock-server.mjs'
import { safeCommunicationCode } from './startup.mjs'

const paths = new Set(['/__test/status', '/api/registrations', '/api/unconfigured-browser-test'])
const failure = (code, status) => Object.assign(new Error('BROWSER_TEST_MOCK_NOT_APPLIED'), {
  ...(code ? {code} : {}), ...(Number.isInteger(status) ? {startupHttpStatus:status} : {}),
})

// A test-only transport. No URL, method or arbitrary headers can come from HTTP input.
export function requestMockProbe(port, pathname, {request = http.request, invalidHost = false, timeoutMs = 5000, maxBytes = 8192} = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !paths.has(pathname)) return Promise.reject(failure('PROBE_RESPONSE_INVALID'))
  return new Promise((resolve, reject) => {
    let req, response, timer, settled = false, size = 0
    const chunks = []
    const finish = error => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) {
        // Destroy only this probe's resources. Never propagate upstream messages.
        response?.destroy(); req?.destroy()
        reject(failure(safeCommunicationCode(error), response?.statusCode))
      } else resolve({status:response.statusCode, headers:response.headers, body:Buffer.concat(chunks).toString('utf8')})
    }
    timer = setTimeout(() => finish({code:'ETIMEDOUT'}), timeoutMs)
    try {
      req = request({protocol:'http:',hostname:'127.0.0.1',port,method:'GET',path:pathname,
        headers:{Host:`${invalidHost ? '127.0.0.1' : 'localhost'}:${port}`},agent:false}, incoming => {
        response = incoming
        incoming.on('error', error => finish(error))
        incoming.on('aborted', () => finish({code:'ECONNRESET'}))
        incoming.on('close', () => {if(!incoming.complete)finish({code:'ECONNRESET'})})
        incoming.on('data', chunk => {
          if (settled) return
          size += chunk.length
          if(size > maxBytes){finish({code:'PROBE_RESPONSE_TOO_LARGE'});return}
          chunks.push(Buffer.from(chunk))
        })
        incoming.on('end', () => finish())
      })
      req.on('error', error => finish(error))
      req.end()
    } catch (error) { finish(error) }
  })
}

export async function probeMockBoundary(port, options = {}) {
  for(const [pathname,status] of [['/__test/status',200],['/api/registrations',405],['/api/unconfigured-browser-test',503]]) {
    const response = await requestMockProbe(port, pathname, options)
    if(response.status !== status || response.headers[mockHeader] !== mockMarker) throw failure(null,response.status)
    if(pathname === '/__test/status') {
      let body
      try {body=JSON.parse(response.body)} catch {throw failure('PROBE_RESPONSE_INVALID',response.status)}
      if(body?.mode !== 'isolated-browser-test' || body.forwarded_api_requests !== 0) throw failure('PROBE_RESPONSE_INVALID',response.status)
    }
  }
  const denied = await requestMockProbe(port, '/__test/status', {...options,invalidHost:true})
  // A rejected Host must not reach the mock and must not carry a success marker.
  if(denied.status !== 403 || denied.headers[mockHeader] !== undefined) throw failure(null,denied.status)
}
