import type {IncomingMessage} from 'node:http'

/** Total elapsed deadline, not an idle timeout that a slow sender can reset. */
export function readLimitedJson(req:IncomingMessage,limit=4096,timeout=5000):Promise<unknown>{
 return new Promise((resolve,reject)=>{
  const length=req.headers['content-length']
  if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>limit)){reject(Error('payload_too_large'));return}
  const chunks:Buffer[]=[];let bytes=0
  const finish=(error?:Error)=>{
   clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',failed);req.off('aborted',aborted)
   if(error){req.pause();reject(error)}
  }
  const data=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>limit){finish(Error('payload_too_large'));return}chunks.push(chunk)}
  const end=()=>{finish();try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{reject(Error('invalid_request'))}}
  const failed=()=>finish(Error('invalid_request'))
  const aborted=()=>finish(Error('invalid_request'))
  const timer=setTimeout(()=>finish(Error('request_timeout')),timeout)
  req.on('data',data);req.once('end',end);req.once('error',failed);req.once('aborted',aborted)
 })
}
