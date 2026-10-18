import {readFile,writeFile,rename,mkdir,unlink} from 'node:fs/promises'
import {dirname} from 'node:path'
import {randomUUID} from 'node:crypto'
export const DEFAULT_WELCOME=Object.freeze({version:1,assistantName:'nova',userName:'',avatar:null,permissionsSeen:false,introduced:false})
export function validateWelcomePatch(patch){
 if(!patch||Object.getPrototypeOf(patch)!==Object.prototype)throw Error('invalid_profile')
 const result={}
 for(const [key,value]of Object.entries(patch)){
  if(['assistantName','userName'].includes(key)){
   if(typeof value!=='string'||value.trim().length>40||/[\p{Cc}\p{Cf}]/u.test(value))throw Error('invalid_name')
   result[key]=value.trim()||(key==='assistantName'?'nova':'')
  }else if(key==='avatar'){
   if(value!==null&&(typeof value!=='string'||value.length>1_500_000||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)))throw Error('invalid_avatar')
   result[key]=value
  }else if(['permissionsSeen','introduced'].includes(key)){
   if(typeof value!=='boolean')throw Error('invalid_profile');result[key]=value
  }else throw Error('invalid_profile')
 }
 return result
}
/** A separate local preference file: no keychain access and no restart of ongoing tasks. */
export function createWelcomeStore(path){
 let queue=Promise.resolve()
 const read=async()=>{
  try{const raw=await readFile(path,'utf8');if(raw.length>1_510_000)throw Error('profile_too_large');const {version,...saved}=JSON.parse(raw);if(version!==1)throw Error('invalid_profile');return {...DEFAULT_WELCOME,...validateWelcomePatch(saved)}}
  catch(error){if(error.code==='ENOENT')return {...DEFAULT_WELCOME};throw error}
 }
 return {get:()=>queue.then(read),async update(patch){
  const validated=validateWelcomePatch(patch)
  const pending=queue.then(async()=>{
   const next={...await read(),...validated},temporary=path+'.'+randomUUID()+'.tmp'
   await mkdir(dirname(path),{recursive:true,mode:0o700})
   try{await writeFile(temporary,JSON.stringify(next),{mode:0o600,flag:'wx'});await rename(temporary,path)}finally{await unlink(temporary).catch(()=>{})}
   return next
  });queue=pending.catch(()=>{});return pending
 }}
}
