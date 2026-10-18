import {mkdirSync,chmodSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {HubStore} from './store.js'
import {createHubServer} from './server.js'
import {runHubClient} from './client-cli.js'
import {deviceKind} from '../device/space-authority.js'

const [command,path,account,device]=process.argv.slice(2)
if(!['serve','enroll','revoke','recover'].includes(command??'')){
 try{process.exitCode=await runHubClient(process.argv.slice(2))}
 catch(error){console.error(error instanceof Error?error.message:'hub_request_failed');process.exitCode=1}
}else if(!path){
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
   if(command==='recover')console.log(JSON.stringify(store.authority.recover(account,{retired_device_id:device,target_device_id:process.argv[6],expected_epoch:Number(process.argv[7]),transition_id:process.argv[8]})))
   else if(command==='enroll')console.log(JSON.stringify(store.enroll(account,device,deviceKind.parse(process.argv[6]??'unknown'))))
   else store.revoke(account,device)
  }finally{store.close()}
 }
}
