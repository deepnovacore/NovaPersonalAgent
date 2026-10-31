import test,{afterEach} from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import {JSDOM} from 'jsdom'
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true})
const {render,fireEvent,waitFor,cleanup,act}=await import('@testing-library/react')
const {SpaceHostPanel,SpaceCreateForm}=await import('../src/renderer/react/settings/space-host.tsx')
afterEach(cleanup)
test('React Space panel requires the phone fingerprint and explicit revocation confirmation',async()=>{
 const calls:any[]=[];let pending=true;
 const api={personalCommand:async(method:string,params:any)=>{calls.push([method,params]);if(method==='space.status')return {mode:'host',space:'safe-space',clients:['phone']};if(method==='space.pairings')return pending?[{id:'pair',device:'new-phone',fingerprint:'phone-fingerprint'}]:[];if(method==='space.confirm_pairing')pending=false;if(method==='space.invitation')return {space:'safe-space',qr_image:'data:image/png;base64,cXJjb2Rl',secret:'one-time'};return {}}};
 const v=render(<SpaceHostPanel api={api}/>);
 await waitFor(()=>assert.ok(v.queryByRole('button',{name:'确认绑定'})));
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'确认绑定'})));await waitFor(()=>assert.match(v.container.textContent??'',/指纹不匹配/));assert.ok(!calls.some(([m])=>m==='space.confirm_pairing'));
 fireEvent.change(v.getByLabelText('输入手机显示的完整指纹'),{target:{value:'phone-fingerprint'}});await act(async()=>fireEvent.click(v.getByRole('button',{name:'确认绑定'})));await waitFor(()=>assert.ok(calls.some(([m,p])=>m==='space.confirm_pairing'&&p.id==='pair'&&p.fingerprint==='phone-fingerprint')));
 await waitFor(()=>assert.ok(!v.queryByRole('button',{name:'确认绑定'})));
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'生成一次性配对码'})));await waitFor(()=>assert.ok(v.queryByAltText('使用手机扫码绑定')));
 assert.deepEqual(JSON.parse((v.getByLabelText('配对内容') as HTMLTextAreaElement).value),{space:'safe-space',secret:'one-time'});
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'撤销 phone'})));assert.ok(!calls.some(([m])=>m==='space.revoke'));await act(async()=>fireEvent.click(v.getByRole('button',{name:'取消'})));assert.ok(!v.queryByRole('button',{name:'确认撤销并轮换密钥'}));
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'撤销 phone'})));await act(async()=>fireEvent.click(v.getByRole('button',{name:'确认撤销并轮换密钥'})));await waitFor(()=>assert.ok(calls.some(([m,p])=>m==='space.revoke'&&p.device==='phone')));
})
test('pairing list failures are visible and late reads after unmount do not restore a panel',async()=>{
 let resolve:any;const api={personalCommand:async(method:string)=>method==='space.status'?{mode:'host',space:'safe',clients:[]}:new Promise(r=>{resolve=r})};
 const v=render(<SpaceHostPanel api={api}/>);await waitFor(()=>assert.ok(resolve));v.unmount();await act(async()=>resolve([{id:'late',fingerprint:'late'}]));assert.equal(v.container.textContent,'');
 const failed=render(<SpaceHostPanel api={{personalCommand:async(method:string)=>{if(method==='space.status')return {mode:'host',clients:[]};throw Error('pairings unavailable')}}}/>);await waitFor(()=>assert.match(failed.container.textContent??'',/pairings unavailable/));
})
const TOKEN='operator-bootstrap-token-0123456789abcdef'
function independentApi(overrides:any={}){
 const calls:any[]=[];let mode='independent'
 const api:any={calls,
  personalCommand:async(method:string,params:any)=>{calls.push([method,params]);if(method==='space.status')return mode==='host'?{mode:'host',space:'new-space',clients:[]}:{mode:'independent'};if(method==='space.pairings')return [];if(method==='space.invitation')return {space:'new-space',qr_image:'data:image/png;base64,cXI='};return {}},
  spaceCreate:async(request:any)=>{calls.push(['create',request]);return {ok:true}},
  restart:async()=>{calls.push(['restart']);mode='host';return {operationStatus:'applied'}},
  ...overrides}
 return api
}
test('Tailscale creation needs no typed credentials and opens a QR after restart',async()=>{
 const api=independentApi(),v=render(<SpaceHostPanel api={api}/>)
 await waitFor(()=>assert.ok(v.queryByRole('button',{name:'创建空间'})))
 assert.ok(v.queryByLabelText('Bootstrap 凭据')===null)
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'创建空间'})))
 await waitFor(()=>assert.ok(v.queryByAltText('使用手机扫码绑定')))
 assert.deepEqual(api.calls.find(([m]:any)=>m==='create')[1],{mode:'tailscale'})
})
test('creation completion survives Strict Mode effect cleanup',async()=>{
 const api=independentApi();let ready=false
 const v=render(<React.StrictMode><SpaceCreateForm api={api} label={zh=>zh} onReady={async()=>{ready=true}}/></React.StrictMode>)
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'创建空间'})))
 await waitFor(()=>assert.equal(ready,true))
})

test('an unconfigured Space offers in-page creation and validates before calling main',async()=>{
 const api=independentApi(),v=render(<SpaceHostPanel api={api}/>)
 await waitFor(()=>assert.ok(v.queryByRole('button',{name:'创建空间'}),'condition not met'))
 fireEvent.change(v.getByLabelText('连接方式'),{target:{value:'manual'}})
 assert.match(v.container.textContent??'',/全新数据/);assert.match(v.container.textContent??'',/不会迁移/);assert.match(v.container.textContent??'',/nova-space-host init/)
 const token=v.getByLabelText('Bootstrap 凭据') as HTMLInputElement;assert.equal(token.type,'password')
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'创建空间'})));await waitFor(()=>assert.match(v.container.textContent??'',/填写 relay 地址/))
 fireEvent.change(v.getByLabelText('Relay 地址'),{target:{value:'http://relay.example'}});fireEvent.change(token,{target:{value:TOKEN}})
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'创建空间'})));await waitFor(()=>assert.match(v.container.textContent??'',/HTTPS/))
 fireEvent.change(v.getByLabelText('Relay 地址'),{target:{value:'https://relay.example'}});fireEvent.change(token,{target:{value:'short'}})
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'创建空间'})));await waitFor(()=>assert.match(v.container.textContent??'',/至少 32 个字符/))
 assert.ok(!api.calls.some(([m]:any)=>m==='create'),'condition not met')
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'显示凭据'})));assert.equal((v.getByLabelText('Bootstrap 凭据') as HTMLInputElement).type,'text')
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'隐藏凭据'})));assert.equal((v.getByLabelText('Bootstrap 凭据') as HTMLInputElement).type,'password')
})
test('creating a Space restarts the backend, locks the form meanwhile, then opens pairing',async()=>{
 let finishCreate:any,finishRestart:any
 const api=independentApi();const create=api.spaceCreate,restart=api.restart
 let creates=0;api.spaceCreate=(request:any)=>{creates++;return new Promise(resolve=>{finishCreate=()=>resolve(create(request))})}
 api.restart=()=>new Promise(resolve=>{finishRestart=()=>resolve(restart())})
 const v=render(<SpaceHostPanel api={api}/>)
 await waitFor(()=>assert.ok(v.queryByRole('button',{name:'创建空间'}),'condition not met'))
 fireEvent.change(v.getByLabelText('连接方式'),{target:{value:'manual'}})
 fireEvent.change(v.getByLabelText('Relay 地址'),{target:{value:' https://relay.example '}});fireEvent.change(v.getByLabelText('Bootstrap 凭据'),{target:{value:TOKEN}})
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'创建空间'})))
 await waitFor(()=>assert.match(v.container.textContent??'',/正在创建空间/))
 assert.equal((v.getByRole('button',{name:'创建空间'}) as HTMLButtonElement).disabled,true)
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'创建空间'})))
 assert.equal(creates,1)
 await act(async()=>finishCreate())
 assert.deepEqual(api.calls.find(([m]:any)=>m==='create')[1],{relayUrl:'https://relay.example',bootstrapToken:TOKEN});await waitFor(()=>assert.match(v.container.textContent??'',/正在重启后台/))
 assert.equal((v.getByRole('button',{name:'创建空间'}) as HTMLButtonElement).disabled,true)
 assert.equal((v.getByLabelText('Bootstrap 凭据') as HTMLInputElement).value,'','the token leaves renderer state once main has it')
 await act(async()=>finishRestart());await waitFor(()=>assert.ok(v.queryByRole('button',{name:'生成一次性配对码'}),'condition not met'))
 assert.match(v.container.textContent??'',/new-space/)
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'生成一次性配对码'})));await waitFor(()=>assert.ok(v.queryByAltText('使用手机扫码绑定'),'condition not met'))
 assert.ok(!(v.container.textContent??'').includes(TOKEN),'condition not met')
})
test('creation failures show a redacted reason and keep the form usable; a failed restart can be retried',async()=>{
 for(const [error,pattern] of [['bootstrap_denied',/拒绝了 bootstrap 凭据/],['relay_unreachable',/无法连接 relay/],['space_relay_mismatch',/https:\/\/old\.example/],['something_new',/创建失败/]] as const){
  const api=independentApi({spaceCreate:async()=>({ok:false,error,relayUrl:'https://old.example'})}),v=render(<SpaceHostPanel api={api}/>)
  await waitFor(()=>assert.ok(v.queryByRole('button',{name:'创建空间'}),'condition not met'))
 fireEvent.change(v.getByLabelText('连接方式'),{target:{value:'manual'}})
  fireEvent.change(v.getByLabelText('Relay 地址'),{target:{value:'https://relay.example'}});fireEvent.change(v.getByLabelText('Bootstrap 凭据'),{target:{value:TOKEN}})
  await act(async()=>fireEvent.click(v.getByRole('button',{name:'创建空间'})));await waitFor(()=>assert.match(v.container.textContent??'',pattern))
  assert.ok(!(v.container.textContent??'').includes(TOKEN),'condition not met');assert.equal((v.getByRole('button',{name:'创建空间'}) as HTMLButtonElement).disabled,false)
  assert.ok(!api.calls.some(([m]:any)=>m==='restart'),'condition not met')
  cleanup()
 }
 let restarts=0
 const api=independentApi({restart:async()=>{restarts++;if(restarts===1)return {operationStatus:'busy'};api.calls.push(['restart']);return {operationStatus:'applied'}}})
 const status=api.personalCommand;api.personalCommand=async(method:string,params:any)=>method==='space.status'&&restarts>=2?{mode:'host',space:'new-space',clients:[]}:status(method,params)
 const v=render(<SpaceHostPanel api={api}/>)
 await waitFor(()=>assert.ok(v.queryByRole('button',{name:'创建空间'}),'condition not met'))
 fireEvent.change(v.getByLabelText('连接方式'),{target:{value:'manual'}})
 fireEvent.change(v.getByLabelText('Relay 地址'),{target:{value:'https://relay.example'}});fireEvent.change(v.getByLabelText('Bootstrap 凭据'),{target:{value:TOKEN}})
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'创建空间'})));await waitFor(()=>assert.match(v.container.textContent??'',/后台未能重启/))
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'重启后台'})));await waitFor(()=>assert.ok(v.queryByRole('button',{name:'生成一次性配对码'}),'condition not met'))
})
test('an already-created but not-yet-active Space offers a locked restart; an active one keeps the plain notice',async()=>{
 let restarts=0
 const api=independentApi({spaceCreate:async()=>({ok:false,error:'space_already_created'})});const baseRestart=api.restart
 api.restart=async()=>{restarts++;return baseRestart()}
 const v=render(<SpaceHostPanel api={api}/>)
 await waitFor(()=>assert.ok(v.queryByRole('button',{name:'创建空间'}),'condition not met'))
 fireEvent.change(v.getByLabelText('连接方式'),{target:{value:'manual'}})
 fireEvent.change(v.getByLabelText('Relay 地址'),{target:{value:'https://relay.example'}});fireEvent.change(v.getByLabelText('Bootstrap 凭据'),{target:{value:TOKEN}})
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'创建空间'})))
 await waitFor(()=>assert.ok(v.queryByRole('button',{name:'重启后台'}),'condition not met'))
 assert.match(v.container.textContent??'',/空间已创建，重启后台后生效/)
 assert.equal((v.getByRole('button',{name:'创建空间'}) as HTMLButtonElement).disabled,true)
 assert.equal(restarts,0)
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'重启后台'})))
 await waitFor(()=>assert.ok(v.queryByRole('button',{name:'生成一次性配对码'}),'condition not met'))
 assert.equal(restarts,1)
 cleanup()
 let hostNow=false
 const active=independentApi({spaceCreate:async()=>{hostNow=true;return {ok:false,error:'space_already_created'}}})
 const base=active.personalCommand;active.personalCommand=async(method:string,params:any)=>method==='space.status'&&hostNow?{mode:'host',space:'x',clients:[]}:base(method,params)
 const w=render(<SpaceHostPanel api={active}/>)
 await waitFor(()=>assert.ok(w.queryByRole('button',{name:'创建空间'}),'condition not met'))
 fireEvent.change(w.getByLabelText('连接方式'),{target:{value:'manual'}})
 fireEvent.change(w.getByLabelText('Relay 地址'),{target:{value:'https://relay.example'}});fireEvent.change(w.getByLabelText('Bootstrap 凭据'),{target:{value:TOKEN}})
 await act(async()=>fireEvent.click(w.getByRole('button',{name:'创建空间'})))
 await waitFor(()=>assert.match(w.container.textContent??'',/已经创建过空间/))
 assert.ok(!w.queryByRole('button',{name:'重启后台'}))
})
