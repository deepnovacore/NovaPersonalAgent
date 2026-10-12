import {t} from './locale.mjs'

/** Passive status and explicit channel choice. The runtime owns all sends. */
export function renderNotificationSettings({state,feishu,local,card,el,button,command,refresh,openVerification}) {
 if(!state)return
 const a=card(t('主动消息'),t('选择 Nova 主动提醒的接收位置。你发起的对话仍在 Nova 中回复。'))
 a.append(el('p',state.local?t('当前渠道：Nova'):t('当前渠道：飞书')))
 if(state.legacy_additional)a.append(el('p',t('已保留原来的飞书附加提醒。选择主渠道后将只向该渠道投递。')))
 if(!state.local)button(t('改为在 Nova 接收'),()=>command('notifications.configure',{binding_id:'nova'}),a)
 if(feishu?.available&&feishu?.configured){
  a.append(el('p',t('飞书应用需启用机器人、消息发送权限，并将你加入可用范围。首次使用前请在飞书打开机器人私聊。'),'personal-hint'))
  button(t('打开飞书开放平台'),()=>openVerification?.(feishu.app_id?`https://open.feishu.cn/app/${encodeURIComponent(feishu.app_id)}`:'https://open.feishu.cn/app'),a)
  if(!feishu.notification_ready){
   button(t('授权飞书消息接收'),async()=>{const result=await command('feishu.notification.login');local.outboundVerification=result?.verification_url;refresh();if(local.outboundVerification)await openVerification?.(local.outboundVerification)},a)
   if(local.outboundVerification)button(t('已完成消息接收授权'),async()=>{await command('feishu.complete');local.outboundVerification=null;refresh()},a)
  }else if(state.local||!feishu.notification_enabled){
   button(t('改为在飞书接收'),async()=>{await command('feishu.notification.configure',{enabled:true});await command('notifications.configure',{binding_id:'feishu'})},a)
  }
 }else a.append(el('p',t('使用飞书前，请先在下方连接飞书应用。')))
 a.append(el('p',t('飞书接收无需开启会话采集。发送失败时会保留状态，不会自动改发到 Nova。审批和继续任务仍在 Nova 中操作。'),'personal-hint'))
 const labels={pending:t('待发送'),sending:t('发送中'),accepted:t('平台已接收'),retry_wait:t('等待重试'),blocked:t('渠道不可用'),unknown:t('发送结果不确定')}
 for(const [status,count]of Object.entries(state.counts??{}))if(count&&labels[status])a.append(el('p',`${labels[status]}：${count}`))
 for(const item of (state.deliveries??[]).filter(x=>['unknown','blocked'].includes(x.status)).slice(-10)){
  const row=el('section');row.append(el('p',`${item.title} · ${labels[item.status]}`));a.append(row)
  if(item.status==='unknown'){
   row.append(el('p',t('对方可能已经收到，请先在接收渠道核实。再次发送可能产生重复消息。'),'personal-hint'))
   button(t('确认可能重复，仍重新发送'),()=>command('notifications.retry',{id:item.id,confirm_unknown:true}),row)
  }else button(t('重试发送'),()=>command('notifications.retry',{id:item.id}),row)
 }
 button(t('刷新投递状态'),()=>command('notifications.status'),a)
}
