import assert from 'node:assert/strict'
import test from 'node:test'
import {prepareWindowsSmokeHomeOwnership} from '../scripts/windows-smoke-home.mjs'

const sid='S-1-5-21-123-456-789-1001',foreign='S-1-5-21-123-456-789-1002'
const success=stdout=>({status:0,signal:null,stdout})
function fixture({owner=sid,setFails=false,readFails=false,unchanged=false}={}){
 const calls=[]
 const run=(binary,args)=>{
  calls.push({binary,args})
  if(binary.endsWith('whoami.exe'))return success(`"fixture\\user","${sid}"\r\n`)
  if(binary.endsWith('powershell.exe'))return readFails?{status:1,signal:null}:success(owner+'\r\n')
  assert.ok(binary.endsWith('icacls.exe'))
  if(setFails)return {status:5,signal:null}
  if(!unchanged)owner=sid
  return success('')
 }
 return {calls,check:()=>prepareWindowsSmokeHomeOwnership({platform:'win32',home:"D:\\fixture\\user's directory",environment:{SystemRoot:'C:\\Windows'},run})}
}

test('Windows smoke accepts a verified current owner without requiring WRITE_OWNER',()=>{
 const {calls,check}=fixture({setFails:true})
 check()
 assert.equal(calls.length,2)
 const encoded=calls[1].args.at(-1),script=Buffer.from(encoded,'base64').toString('utf16le')
 assert.ok(script.includes("$path = 'D:\\fixture\\user''s directory'"),'quotes in literal paths cannot become PowerShell code')
 assert.ok(!calls.some(call=>call.binary.endsWith('icacls.exe')))
})

test('Windows smoke changes a foreign owner only when it can verify the new SID',()=>{
 const {calls,check}=fixture({owner:foreign})
 check()
 assert.equal(calls.length,4)
 assert.deepEqual(calls[2].args,["D:\\fixture\\user's directory",'/setowner','*'+sid,'/Q'])
})

test('Windows smoke rejects unreadable, unchanged or unchangeable ownership',()=>{
 for(const options of [{readFails:true},{owner:foreign,setFails:true},{owner:foreign,unchanged:true}]){
  assert.throws(fixture(options).check,{message:'installed_candidate_invalid'})
 }
})
