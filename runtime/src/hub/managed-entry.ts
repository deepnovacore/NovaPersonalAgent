import {startManagedHub} from './managed.js'

try{
 const args=process.argv.slice(2),options=new Map<string,string>()
 for(let i=0;i<args.length;i+=2){
  const key=args[i],value=args[i+1]
  if(!key||!['--data-dir','--port'].includes(key)||value===undefined||options.has(key))throw Error('invalid_arguments')
  options.set(key,value)
 }
 const dataDir=options.get('--data-dir'),rawPort=options.get('--port')??'8787'
 if(!dataDir||!/^\d+$/.test(rawPort))throw Error('invalid_arguments')
 const hub=await startManagedHub({dataDir,port:Number(rawPort)})
 const shutdown=()=>{void hub.close().catch(()=>{process.exitCode=1})}
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown)
 console.log('Nova managed Hub ready')
}catch{
 // Startup exceptions can contain paths or database values. Keep process output generic.
 console.error('Nova managed Hub could not start')
 process.exitCode=1
}
