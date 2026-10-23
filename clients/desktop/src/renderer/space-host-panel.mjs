import {currentLanguage} from './locale.mjs';
export function createSpaceHostPanel({document,api}) {
 const root=document.querySelector('#space-host-panel');
 const label=(zh,en)=>currentLanguage()==='en'?en:zh;
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};
 let busy=false,invitation=null,status=null,pending=[],revoke=null;
 const error=el('p');error.setAttribute('role','status');
 const command=async(method,params={})=>{const result=await api.personalCommand(method,params);if(result?.error)throw Error(result.error);return result};
 const button=(text,action,parent=root)=>{const node=el('button',text);node.type='button';node.addEventListener('click',async()=>{if(busy)return;busy=true;node.disabled=true;error.textContent='';try{await action()}catch(e){error.textContent=e?.message??label('暂时不可用','Temporarily unavailable')}finally{busy=false;node.disabled=false}});parent.append(node);return node};
 async function refresh(){status=await command('space.status');pending=status?.mode==='host'?await command('space.pairings'):[];render()}
 function render(){
  if(!root)return;root.replaceChildren(el('h3',label('Space 与手机','Space and phones')));
  root.append(el('p',label('Host 保存全部数据。Host 损坏后此 Space 无法恢复；撤销设备会轮换密钥，但无法收回已下载历史。','The Host keeps all data. Losing the Host loses this Space. Revocation rotates keys but cannot erase previously downloaded history.')));
  if(status?.mode!=='host'){
   root.append(el('p',label('尚未配置 Host Space。先使用 nova-space-host init 创建独立空间，再以该配置启动桌面端。','No Host Space configured. Create an independent Space with nova-space-host init, then launch the desktop with its configuration.')));
   root.append(error);return;
  }
  root.append(el('p',String(status.space)));
  button(label('刷新设备','Refresh devices'),refresh);
  button(label('生成一次性配对码','Create one-time pairing code'),async()=>{invitation=await command('space.invitation');render()});
  if(invitation){
   if(typeof invitation.qr_image==='string'&&invitation.qr_image.startsWith('data:image/png;base64,')){const image=el('img');image.src=invitation.qr_image;image.alt=label('使用手机扫码绑定','Scan with your phone to pair');image.width=240;image.height=240;root.append(image)}
   root.append(el('p',label('只交给你要绑定的手机；配对码会过期。扫码后刷新并核对手机显示的指纹。','Share only with your phone; this code expires. After scanning, refresh and compare the fingerprint shown on the phone.')));
   const code=el('textarea');code.readOnly=true;const {qr_image,...wire}=invitation;code.value=JSON.stringify(wire);code.setAttribute('aria-label',label('配对内容','Pairing payload'));root.append(code);
  }
  for(const request of Array.isArray(pending)?pending:[]){
   const row=el('article');row.append(el('p',String(request.device)),el('p',String(request.fingerprint)));
   const input=el('input');input.type='text';input.placeholder=label('输入手机显示的完整指纹','Enter the full fingerprint shown on the phone');input.setAttribute('aria-label',input.placeholder);row.append(input);
   button(label('确认绑定','Confirm pairing'),async()=>{if(input.value.trim()!==request.fingerprint)throw Error(label('指纹不匹配，未绑定','Fingerprint mismatch; device not paired'));await command('space.confirm_pairing',{id:request.id,fingerprint:input.value.trim()});invitation=null;await refresh()},row);root.append(row);
  }
  for(const device of status.clients??[])button(label('撤销 '+device,'Revoke '+device),async()=>{revoke=device;render()});
  if(revoke){const row=el('article');row.append(el('p',label('撤销 '+revoke+' 后，该设备将无法读取新消息。','After revoking '+revoke+', it cannot read new messages.')));button(label('确认撤销并轮换密钥','Confirm revocation and rotate keys'),async()=>{await command('space.revoke',{device:revoke});revoke=null;await refresh()},row);button(label('取消','Cancel'),async()=>{revoke=null;render()},row);root.append(row)}
  root.append(error);
 }
 return {async load(){try{await refresh()}catch(e){status=null;render();error.textContent=e?.message??'unavailable'}}};
}
