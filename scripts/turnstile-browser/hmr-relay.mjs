import http from 'node:http'
import {createHash} from 'node:crypto'

const guid='258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const hasUpgrade=value=>typeof value==='string'&&value.split(',').some(token=>token.trim().toLowerCase()==='upgrade')
export function allowedHmrUpgrade(req,port) {
  const headers=req.headers??{}
  if(req.method!=='GET'||headers.host!==`localhost:${port}`||headers.origin!==`http://localhost:${port}`)return false
  // Preserve Next's request id, but never accept arbitrary URLs or query parameters.
  if(typeof req.url!=='string'||!/^\/_next\/hmr(?:\?id=[A-Za-z0-9_-]{1,128})?$/.test(req.url))return false
  if(typeof headers.upgrade!=='string'||headers.upgrade.toLowerCase()!=='websocket'||!hasUpgrade(headers.connection)||headers['sec-websocket-version']!=='13')return false
  const key=headers['sec-websocket-key']
  return typeof key==='string'&&/^[A-Za-z0-9+/]{22}==$/.test(key)&&Buffer.from(key,'base64').length===16&&Buffer.from(key,'base64').toString('base64')===key
}

// request injection is exclusively for unit tests; HTTP input cannot set a target.
export function createHmrRelay({port,internalPort,isReady,request=http.request,timeoutMs=5000}) {
  if(!Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(internalPort)||internalPort<1024||internalPort>65535||internalPort===3000||internalPort===port)throw new Error('INVALID_HMR_RELAY_CONFIGURATION')
  const sessions=new Set()
  let closed=false
  function upgrade(req,client,head) {
    if(closed||!isReady()||!allowedHmrUpgrade(req,port)){client.destroy();return}
    let outbound,upstream,timer,done=false,upgraded=false
    const finish=()=>{
      if(done)return
      done=true;clearTimeout(timer);sessions.delete(finish)
      client.destroy();upstream?.destroy();outbound?.destroy()
    }
    sessions.add(finish)
    client.on('error',finish);client.on('close',finish);client.on('end',finish)
    timer=setTimeout(finish,timeoutMs)
    try {
      const key=req.headers['sec-websocket-key']
      outbound=request({protocol:'http:',hostname:'127.0.0.1',port:internalPort,path:req.url,method:'GET',agent:false,
        headers:{Host:`127.0.0.1:${internalPort}`,Origin:`http://localhost:${port}`,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Key':key,'Sec-WebSocket-Version':'13'}})
      outbound.on('error',finish)
      outbound.on('response',response=>{response.destroy();finish()})
      outbound.on('upgrade',(response,socket,upstreamHead)=>{
        upstream=socket
        socket.on('error',finish);socket.on('close',finish);socket.on('end',finish)
        if(done||upgraded){socket.destroy();finish();return}
        const expected=createHash('sha1').update(key+guid).digest('base64')
        if(response.statusCode!==101||typeof response.headers.upgrade!=='string'||response.headers.upgrade.toLowerCase()!=='websocket'||!hasUpgrade(response.headers.connection)||response.headers['sec-websocket-accept']!==expected||response.headers['sec-websocket-extensions']!==undefined||response.headers['sec-websocket-protocol']!==undefined){finish();return}
        upgraded=true;clearTimeout(timer)
        // Never copy arbitrary upstream headers, cookies, auth or debug output.
        client.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${expected}\r\n\r\n`)
        if(upstreamHead?.length)client.write(upstreamHead)
        if(head?.length)socket.write(head)
        client.pipe(socket);socket.pipe(client)
      })
      outbound.end()
    } catch {finish()}
  }
  return {upgrade,close(){closed=true;for(const finish of [...sessions])finish()}}
}
