import assert from 'node:assert/strict'
import {test} from 'node:test'
import {patchPiPromptError,patchPiSettlement} from '../patch-pi-acp.mjs'

const upstream = `// RequestError as RequestError3
function promptResult(result, session) {
    const stopReason = result === "error" ? session.wasCancelRequested() ? "cancelled" : "end_turn" : result;
    return {stopReason};
}`
class RequestError extends Error {constructor(code,message){super(message);this.code=code}}
const handler = new Function('RequestError3', `${patchPiPromptError(upstream)};return promptResult`)(RequestError)
test('Pi model failure produces a structured protocol error instead of end_turn', () => {
  assert.throws(()=>handler('error',{wasCancelRequested:()=>false}),error=>error.code===-32603 && error.message==='Pi model invocation failed')
})
test('Pi cancellation and ordinary completion retain their native stop reason', () => {
  assert.deepEqual(handler('error',{wasCancelRequested:()=>true}),{stopReason:'cancelled'})
  assert.deepEqual(handler('end_turn',{wasCancelRequested:()=>false}),{stopReason:'end_turn'})
})
test('unknown upstream source is refused instead of partially patched', () => {
  assert.throws(()=>patchPiPromptError(upstream.replace('"end_turn"','"changed"')))
  assert.throws(()=>patchPiPromptError(upstream+upstream))
})

const settlement = patchPiSettlement(`async function settle() {
    const reason = this.cancelRequested ? "cancelled" : "end_turn";
    return reason;
}`)
const settle = new Function(`${settlement}; return settle`)()
test('Pi settled event reads the latest turn structured error, excluding historical errors', async () => {
  const run=messages=>settle.call({cancelRequested:false,proc:{getMessages:async()=>({messages})}})
  assert.equal(await run([{role:'user'},{role:'assistant',stopReason:'error'}]),'error')
  assert.equal(await run([{role:'user'},{role:'assistant',stopReason:'error'},{role:'user'},{role:'assistant',stopReason:'stop'}]),'end_turn')
  assert.equal(await run([{role:'user'},{role:'assistant',stopReason:'aborted'}]),'cancelled')
  assert.equal(await run([{role:'user'}]),'error')
  assert.equal(await settle.call({cancelRequested:false,proc:{getMessages:async()=>{throw new Error('RPC lost')}}}),'error')
  assert.equal(await settle.call({cancelRequested:true}),'cancelled')
})
