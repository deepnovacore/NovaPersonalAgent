import {test,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {DiscoveryWindow} from '../src/personal-agent/discovery-window.js'

const MIN=60_000
function window(t:TestContext,options:{quietMs?:number;maxMs?:number}={}){
 t.mock.timers.enable({apis:['setTimeout']})
 let fires=0,now=0
 const w=new DiscoveryWindow({quietMs:options.quietMs??3*MIN,maxMs:options.maxMs??15*MIN,now:()=>now,fire:()=>{fires++}})
 return {w,fires:()=>fires,tick:(ms:number)=>{now+=ms;t.mock.timers.tick(ms)}}
}

test('fires once after the quiet period with no new arrivals',t=>{
 const {w,fires,tick}=window(t)
 w.touch();tick(3*MIN-1);assert.equal(fires(),0);tick(1);assert.equal(fires(),1);tick(30*MIN);assert.equal(fires(),1)
 assert.equal(w.pending,false)
})
test('each arrival restarts the quiet period',t=>{
 const {w,fires,tick}=window(t)
 w.touch();tick(2*MIN);w.touch();tick(2*MIN);w.touch();tick(2*MIN);assert.equal(fires(),0)
 tick(MIN);assert.equal(fires(),1)
})
test('a steady stream still fires at the cap measured from the first arrival',t=>{
 const {w,fires,tick}=window(t)
 w.touch()
 for(let minute=1;minute<15;minute++){tick(MIN);w.touch();assert.equal(fires(),0,'minute '+minute)}
 tick(MIN);assert.equal(fires(),1)
})
test('the next arrival after a fire opens a new window',t=>{
 const {w,fires,tick}=window(t)
 w.touch();tick(3*MIN);assert.equal(fires(),1)
 w.touch();tick(3*MIN-1);assert.equal(fires(),1);tick(1);assert.equal(fires(),2)
})
test('cancel drops the pending window and the next arrival starts fresh',t=>{
 const {w,fires,tick}=window(t)
 w.touch();tick(MIN);w.cancel();assert.equal(w.pending,false);tick(30*MIN);assert.equal(fires(),0)
 w.touch();tick(3*MIN);assert.equal(fires(),1)
})
test('a zero quiet period fires synchronously so tests and opt-outs stay immediate',t=>{
 const {w,fires}=window(t,{quietMs:0,maxMs:0})
 w.touch();assert.equal(fires(),1);w.touch();assert.equal(fires(),2)
})
