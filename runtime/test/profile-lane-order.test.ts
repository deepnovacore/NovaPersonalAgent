import {test} from 'node:test'
import assert from 'node:assert/strict'
import {profileLaneOrder} from '../src/memory-substrate/source-processing.js'

test('a profile lane reserves its newest quarter before the spread history',()=>{
 const lane=Array.from({length:8},(_,index)=>({id:index}))
 const order=profileLaneOrder(lane)
 assert.equal(order.length,8,'the whole lane is kept')
 assert.deepEqual(order.slice(0,2).map(item=>item.id),[7,6],'the newest quarter leads the order')
 assert.deepEqual(new Set(order.map(item=>item.id)).size,8,'no observation is duplicated')
 assert.deepEqual(order.slice(2).map(item=>item.id).sort((a,b)=>a-b),[0,1,2,3,4,5],'the rest is still a whole-history sample')
})

test('small and single-item lanes stay deterministic',()=>{
 assert.deepEqual(profileLaneOrder([{id:1}]).map(item=>item.id),[1])
 assert.deepEqual(profileLaneOrder([]),[])
 const two=profileLaneOrder([{id:1},{id:2}])
 assert.deepEqual(two.map(item=>item.id),[2,1],'the newest observation is still first')
})
