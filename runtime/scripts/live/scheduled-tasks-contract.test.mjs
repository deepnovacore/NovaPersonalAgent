import assert from 'node:assert/strict'
import {test} from 'node:test'
import {classifyScenario} from './scheduled-tasks.mjs'
const good={scenario:'wall-clock',trigger_mode:'wall_clock_timer',profile_kind:'isolated_synthetic',source:'synthetic App data',provider:'configured-real-model',model_calls:2,build_commit:'a'.repeat(40),schedule_id:'s',run_id:'r',task_id:'t',scheduled_at:'2026-10-12T01:00:00.000Z',started_at:'2026-10-12T01:00:01.000Z',evidence:['context:1','delivery:1'],completed:true}
test('live claims require timer, real model, completed Task and evidence',()=>{
 assert.equal(classifyScenario(good),'passed')
 for(const field of ['provider','task_id','run_id','schedule_id','source','build_commit','scheduled_at','started_at'])assert.equal(classifyScenario({...good,[field]:null}),'failed',field)
 for(const change of [{model_calls:0},{evidence:[]},{completed:false},{started_at:'2026-10-12T00:59:00.000Z'}])assert.equal(classifyScenario({...good,...change}),'failed')
})
test('synthetic clocks and direct ticks are never wall-clock acceptance',()=>{
 for(const trigger_mode of ['direct_tick','virtual_clock','mock'])assert.equal(classifyScenario({...good,trigger_mode}),'deterministic')
 assert.equal(classifyScenario({scenario:'missing credentials',blocked:'missing_model'}),'blocked')
})
