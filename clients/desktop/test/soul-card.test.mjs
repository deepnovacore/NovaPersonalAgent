import test from 'node:test'
import assert from 'node:assert/strict'
import {soulIntro,renderSoulCard,contactSummary} from '../src/renderer/soul-card.mjs'
import {renderProfile} from '../src/renderer/life-view.mjs'
import {setLanguage} from '../src/renderer/locale.mjs'

class Element{
 constructor(tag,text=''){this.tag=tag;this.textContent=text;this.children=[];this.dataset={};this.listeners={};this.className='';this.value=''}
 append(...children){this.children.push(...children)}
 setAttribute(){}
 addEventListener(name,fn){this.listeners[name]=fn}
}
const full={assistant_name:'小星',role:'靠谱、说话直接',version:3,available:true,reply_style:'简短、先给结论',contact:{daily_cap:3,quiet_start:'22:00',quiet_end:'08:00',briefs_on:true,discovery_on:false}}
const empty={assistant_name:'',role:'',version:0,available:true,reply_style:null,contact:{daily_cap:5,quiet_start:'22:00',quiet_end:'08:00',briefs_on:false,discovery_on:false}}
const texts=node=>[node.textContent??'',...node.children.flatMap(texts)]
const find=(node,predicate)=>[node,...node.children.flatMap(child=>find(child,predicate))].filter(predicate)
async function mount(run){const previous=globalThis.document;globalThis.document={createElement:tag=>new Element(tag)};try{return await run()}finally{globalThis.document=previous;setLanguage('zh-CN')}}
function harness(soul,overrides={}){
 const commands=[],settings=[],buttons=[],local={}
 const button=(label,action,host)=>{const item=new Element('button',label);item.action=action;host.append(item);buttons.push(item);return item}
 let renders=0
 const options={soul,command:async(...args)=>{commands.push(args);if(overrides.fail)throw Error(overrides.fail);return {}},button,local,rerender:()=>{renders++},openSettings:category=>settings.push(category)}
 return {commands,settings,buttons,local,options,renders:()=>renders}
}

test('soulIntro builds every sentence from a field and never adds a trait',()=>{
 assert.equal(soulIntro(full,'zh-CN'),'我叫小星。你希望我是——靠谱、说话直接。平时说话我会按你说的来：简短、先给结论。我最多每天主动找你 3 次，22:00 到 08:00 不打扰你。')
 const text=soulIntro(full,'zh-CN')
 for(const fact of ['小星','靠谱、说话直接','简短、先给结论','3','22:00','08:00'])assert.ok(text.includes(fact))
 assert.equal(soulIntro({...full,assistant_name:'',role:'',reply_style:null,contact:{...full.contact,briefs_on:false}},'zh-CN'),'你还没告诉我希望我是什么样的，想好了在下面写给我就行。我不会主动来找你，你叫我我再出现。')
 assert.ok(!/我叫/u.test(soulIntro(empty,'zh-CN')),'no invented name when the field is empty')
 assert.ok(!/平时说话/u.test(soulIntro(empty,'zh-CN')))
 assert.ok(soulIntro({...full,contact:{...full.contact,briefs_on:false,discovery_on:true}},'zh-CN').includes('最多每天主动找你 3 次'))
 assert.equal(soulIntro({role:'x'},'zh-CN'),'你希望我是——x。')
})

test('soulIntro flattens newlines, truncates a long role at 80 characters and has an English version with the same facts',()=>{
 const role='第一行\n第二行'+'长'.repeat(200),text=soulIntro({...empty,role},'zh-CN')
 assert.ok(text.includes('第一行 第二行')&&!text.includes('\n'))
 assert.equal(text.match(/你希望我是——(.*?)。/u)[1],('第一行 第二行'+'长'.repeat(200)).slice(0,80)+'…')
 const en=soulIntro(full,'en')
 assert.equal(en,"I'm 小星. You'd like me to be: 靠谱、说话直接. I'll talk the way you asked: 简短、先给结论. I'll reach out at most 3 times a day, and stay quiet from 22:00 to 08:00.")
 assert.equal(soulIntro(empty,'en'),"You haven't told me what kind of assistant you'd like yet. Write it below whenever you're ready. I won't reach out on my own; call me and I'll show up.")
 assert.equal(soulIntro(empty,'zh-CN').includes('hello'),false)
})

test('the card renders every section from the snapshot and never calls the model',()=>mount(()=>{
 const h=harness(full),parent=new Element('div');renderSoulCard(parent,h.options)
 const all=texts(parent)
 for(const expected of ['我的样子','这是你期望的我，你说了算','小星','靠谱、说话直接','简短、先给结论','想改就直接跟我说',contactSummary(full.contact),'改名字','去调整','编辑'])assert.ok(all.includes(expected),expected)
 assert.ok(all.includes(soulIntro(full,'zh-CN')))
 const empties=harness(empty),blank=new Element('div');renderSoulCard(blank,empties.options)
 assert.ok(texts(blank).includes('比如：一个靠谱、说话直接、不啰嗦的搭档'));assert.ok(texts(blank).includes('写下来'))
}))

test('rename and adjust open the existing settings window on the general category',()=>mount(()=>{
 const h=harness(full),parent=new Element('div');renderSoulCard(parent,h.options)
 h.buttons.find(b=>b.textContent==='改名字').action();h.buttons.find(b=>b.textContent==='去调整').action()
 assert.deepEqual(h.settings,['general','general'])
}))

test('saving sends soul.set with the version the card displayed and clears the draft on success',()=>mount(async()=>{
 const h=harness(full),parent=new Element('div');renderSoulCard(parent,h.options)
 h.buttons.find(b=>b.textContent==='编辑').action();assert.deepEqual(h.local.soul,{role:'靠谱、说话直接',version:3,error:''})
 h.local.soul.role='新的角色'
 const again=new Element('div');renderSoulCard(again,h.options)
 await h.buttons.findLast(b=>b.textContent==='保存').action()
 assert.deepEqual(h.commands,[['soul.set',{role:'新的角色',expected_version:3}]]);assert.equal(h.local.soul,undefined)
}))

test('a failed or stale save keeps the typed draft and shows a visible reason',()=>mount(async()=>{
 for(const [error,expected] of [['stale','角色设定刚刚在别处被改过，你的草稿还在，请核对最新内容后再保存。'],['memory_unavailable','记忆还没开启，所以暂时不能保存角色设定。'],['boom','保存失败：boom']]){
  const h=harness(full,{fail:error});h.local.soul={role:'我的草稿',version:3,error:''}
  const parent=new Element('div');renderSoulCard(parent,h.options)
  await h.buttons.find(b=>b.textContent==='保存').action()
  assert.equal(h.local.soul.role,'我的草稿',error);assert.equal(h.local.soul.error,expected);assert.ok(h.renders()>0)
  const next=new Element('div');renderSoulCard(next,h.options);assert.ok(texts(next).includes(expected))
 }
}))

test('when memory is unavailable the card explains why and cannot save',()=>mount(()=>{
 const h=harness({...full,available:false}),parent=new Element('div');renderSoulCard(parent,h.options)
 assert.ok(texts(parent).includes('记忆还没开启，所以暂时不能保存角色设定。'));assert.equal(h.buttons.find(b=>b.textContent==='编辑').disabled,true)
 h.local.soul={role:'x',version:0,error:''};const editing=new Element('div');renderSoulCard(editing,h.options)
 assert.equal(find(editing,n=>n.tag==='button'&&n.textContent==='保存')[0].disabled,true)
}))

test('the profile page puts the card beside the profile in a split container; without soul it is unchanged',()=>mount(()=>{
 const button=(label,action,host)=>{const item=new Element('button',label);host.append(item);return item}
 const base={state:{profile:{version:0,about:''}},news:{},warmup:null,command(){},button,local:{},rerender(){}}
 const panel=new Element('main');renderProfile(panel,{...base,soul:{view:full,openSettings(){}}})
 const split=find(panel,n=>n.className==='profile-split')[0];assert.ok(split);assert.equal(split.children.length,2)
 assert.equal(find(panel,n=>n.tag==='h2'&&n.textContent==='个人资料').length,1)
 assert.ok(find(split.children[0],n=>n.textContent==='关于我').length>0);assert.ok(find(split.children[1],n=>n.className.includes('soul-card')).length>0)
 const plain=new Element('main');renderProfile(plain,base);assert.equal(find(plain,n=>n.className==='profile-split').length,0)
}))
