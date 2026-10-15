import {mkdirSync,chmodSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {HubStore} from './store.js'
import {createHubServer} from './server.js'

const [command,path,account,device]=process.argv.slice(2)
if(!path||!['serve','enroll','revoke'].includes(command??'')){
 console.error('Usage: hub serve <database> [bind-address] [port] | hub <enroll|revoke> <database> <account-id> <device-name-or-id>')
 process.exitCode=1
}else{
 const file=resolve(path);mkdirSync(dirname(file),{recursive:true,mode:0o700})
 const store=new HubStore(file);chmodSync(file,0o600)
 if(command==='serve'){
  const server=createHubServer(store),port=Number(device??8787),host=account??'127.0.0.1'
  server.requestTimeout=15_000;server.headersTimeout=10_000
  server.listen(port,host,()=>console.log(`Nova personal sync Hub listening on ${host}:${port}`))
  const close=()=>server.close(()=>{store.close()})
  process.once('SIGTERM',close);process.once('SIGINT',close)
 }else{
  try{
   if(!account||!device)throw Error('account and device required')
   if(command==='enroll')console.log(JSON.stringify(store.enroll(account,device)))
   else store.revoke(account,device)
  }finally{store.close()}
 }
}
