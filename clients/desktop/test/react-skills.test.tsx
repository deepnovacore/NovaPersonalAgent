import test,{afterEach} from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import {JSDOM} from 'jsdom'
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true})
const {render,cleanup}=await import('@testing-library/react')
const {SkillsPanel}=await import('../src/renderer/react/settings/panels.tsx')
afterEach(()=>cleanup())

test('Computer Use uses the monitor icon while other skills keep the plug fallback',()=>{
 const api={get:async()=>({skills:[]})}
 const skills=[
  {id:'computer-use',name:'Computer Use',description:'真实截图与鼠标键盘操作，在 Build 会话中按需开启'},
  {id:'notes',name:'Notes',description:'整理笔记'},
 ]
 const v=render(<SkillsPanel api={api} skills={skills}/>)
 const cards=[...v.container.querySelectorAll('.im-card')]
 assert.equal(cards.length,2)
 assert.ok(cards[0].querySelector('svg.lucide-monitor'),'Computer Use should render the monitor glyph')
 assert.equal(cards[0].querySelector('svg.lucide-plug'),null)
 assert.ok(cards[1].querySelector('svg.lucide-plug'),'imported skills keep the neutral plug glyph')
 assert.ok(v.getByRole('heading',{name:'Computer Use'}))
 assert.ok(v.getByText('按会话'))
 v.unmount()
})
