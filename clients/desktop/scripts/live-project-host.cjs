// Explicit live-test host: production Electron ABI, no settings/keychain reads.
const {app,utilityProcess}=require('electron')
const {resolve}=require('node:path')
let child,shutdownTimer
app.whenReady().then(()=>{
  child=utilityProcess.fork(resolve(__dirname,'../../../runtime/scripts/live/project.mjs'),[],{env:process.env,stdio:'pipe'})
  child.stdout.on('data',data=>process.stdout.write(data))
  child.stderr.on('data',data=>process.stderr.write(data))
  child.on('exit',code=>{clearTimeout(shutdownTimer);app.exit(code??1)})
}).catch(()=>app.exit(1))
app.on('will-quit',()=>child?.kill())
process.on('SIGTERM',()=>{
  if(!child){app.exit(1);return}
  child.postMessage({type:'nova.live.stop'})
  shutdownTimer??=setTimeout(()=>{child.kill();app.exit(1)},5000)
})
