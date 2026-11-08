import test from 'node:test'
import assert from 'node:assert/strict'
import React,{act} from 'react'
import {JSDOM} from 'jsdom'
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://nova.local/'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true})
const {shortLabel,profileKeywords,profileTopics,labelWeight}=await import('../src/renderer/react/pages/profile-tags')

test('shortLabel takes the first clause and never invents words',()=>{
 assert.equal(shortLabel('主题甲：关注它的长期变化，并持续记录'),'主题甲')
 assert.equal(shortLabel('Topic A, followed closely over time'),'Topic A')
 assert.equal(shortLabel('  '),'')
 assert.equal(shortLabel(7),'')
 const long=shortLabel('一二三四五六七八九十甲乙丙丁戊己庚辛')
 assert.ok(long.endsWith('…')&&labelWeight(long.slice(0,-1))<=23)
 assert.ok('一二三四五六七八九十甲乙丙丁戊己庚辛'.startsWith(long.slice(0,-1)))
 const latin=shortLabel('Alpha beta gamma delta epsilon zeta eta theta')
 assert.ok(latin.endsWith('…')&&'Alpha beta gamma delta epsilon zeta eta theta'.startsWith(latin.slice(0,-1)))
 assert.ok(!/\w…$/.test(latin)||latin.length<=24)
})
test('profileKeywords dedupes, prefers short, keeps stable order and caps at 8',()=>{
 assert.deepEqual(profileKeywords([{text:'Topic A：x'},{text:'topic a, again'},{text:'Topic B'}],[{title:'Role'}]),['Topic A','Topic B','Role'])
 const many=Array.from({length:12},(_,i)=>({text:`Item${'x'.repeat(i)}`}))
 const out=profileKeywords(many,[])
 assert.equal(out.length,8)
 assert.deepEqual(out,many.slice(0,8).map(m=>m.text))
 assert.deepEqual(profileKeywords([],[]),[])
 assert.deepEqual(profileKeywords([null,{text:3}],[{}]),[])
})
test('profileTopics prefers writer keywords, falls back to derived labels and shows a shared label once',()=>{
 const interests=[{text:'Topic A：x'},{text:'Topic B'}]
 const own=profileTopics([{text:'topic a'},{text:'Topic A'},{text:'Style'}],interests,[{title:'Role'}])
 assert.deepEqual(own.keywords,['topic a','Style'])
 assert.deepEqual(own.interests.map(item=>item.text),['Topic B'])
 const fallback=profileTopics(undefined,interests,[{title:'Role'}])
 assert.deepEqual(fallback.keywords,['Topic A','Topic B','Role'])
 assert.equal(fallback.interests.length,2)
 assert.deepEqual(profileTopics([],interests,[]).keywords,['Topic A','Topic B'])
 assert.deepEqual(profileTopics([{text:3},null],[],[]).keywords,[])
})
