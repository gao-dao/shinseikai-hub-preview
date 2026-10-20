import {emitKeypressEvents} from 'node:readline'
export function hiddenInput(label,{input=process.stdin,output=process.stderr}={}){
  if(!input.isTTY||typeof input.setRawMode!=='function')return Promise.reject(new Error('TTY_REQUIRED'))
  return new Promise((resolve,reject)=>{
    let value='',finished=false;const wasRaw=!!input.isRaw
    const finish=(error)=>{if(finished)return;finished=true;input.off('keypress',onKey);input.off('end',onEnd);process.off('SIGTERM',onEnd);input.setRawMode(wasRaw);input.pause();output.write('\n');if(error)reject(new Error('INPUT_CANCELLED'));else resolve(value);value=''}
    const onEnd=()=>finish(true)
    const onKey=(text,key={})=>{
      if(key.ctrl&&['c','d'].includes(key.name)){finish(true);return}
      if(key.name==='return'){finish(false);return}
      if(key.name==='backspace'){value=value.slice(0,-1);return}
      if(text&&/^[!-~]+$/.test(text)&&value.length+text.length<=512)value+=text
    }
    output.write(label+'（非表示）: ');emitKeypressEvents(input);input.setRawMode(true);input.resume();input.on('keypress',onKey);input.once('end',onEnd);process.once('SIGTERM',onEnd)
  })
}
