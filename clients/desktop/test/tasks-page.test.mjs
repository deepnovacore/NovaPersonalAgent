import test from 'node:test'
import assert from 'node:assert/strict'
import {taskNextStep,activeTaskCount,isSourceProcessingTask} from '../src/renderer/tasks-page.mjs'
test('cards say who acts next',()=>{
 assert.match(taskNextStep({phase:'waiting',waiting_reason:'correction_limit',controller:{kind:'nova'}}),/^需要你：自动修正次数已用完/)
 assert.equal(taskNextStep({phase:'running',controller:{kind:'nova'}}),'Nova 在推进')
 assert.equal(taskNextStep({phase:'running',controller:{kind:'user',client_id:'a'}}),'你在控制')
 assert.equal(taskNextStep({phase:'completed',controller:{kind:'nova'}}),'无需操作')
})

test('source maintenance is excluded without exposing its owned executor work',()=>{
 const internal={phase:'waiting',trigger:{schedule_id:'builtin-source-test'},work_ids:['w1']}
 assert.equal(isSourceProcessingTask(internal),true)
 assert.equal(isSourceProcessingTask({goal:'Use source__process in my project'}),false)
 assert.equal(activeTaskCount({tasks:[internal,{phase:'running',work_ids:['w2']}]},{tasks:[{work_id:'w1',phase:'working'},{work_id:'w2',phase:'working'},{work_id:'w3',phase:'working'}]}),2)
})
