import {test} from 'node:test';
import assert from 'node:assert/strict';
import {notificationTaskWaitingText} from '../src/notifications/content.js';

test('task recovery notification bodies explain paused state without runtime codes or automatic actions',()=>{
 for(const reason of ['task_runtime_unavailable','task_runtime_recovery_unavailable','task_session_recovery_unavailable','task_work_recovery_unavailable','task_origin_unavailable','task_executor_unavailable','task_recovery_blocked','work_fence_unavailable','uncertain_recovery','task_effect_unknown','task_execution_unconfirmed','task_delivery_uncertain','task_check_unavailable']){
  const text=notificationTaskWaitingText(reason);
  assert.ok(text.includes('任务已暂停'));assert.ok(text.includes('回到电脑端'));assert.ok(text.includes('核对'));assert.equal(text.includes(reason),false);assert.equal(text.includes('自动继续'),false);
 }
 assert.ok(notificationTaskWaitingText('task_runtime_unavailable').includes('执行服务暂不可用'));
 assert.ok(notificationTaskWaitingText('task_delivery_uncertain').includes('是否交付仍待确认'));
 assert.ok(notificationTaskWaitingText('cancellation_pending').includes('仍需确认'));
 assert.equal(notificationTaskWaitingText('task_future_unknown_code').includes('task_future_unknown_code'),false);
 assert.equal(notificationTaskWaitingText('constructor').includes('constructor'),false);
});

test('task notification content preserves human clarification requests',()=>{
 assert.equal(notificationTaskWaitingText(null),'任务需要你补充信息');
 assert.equal(notificationTaskWaitingText('请确认要修改哪个文件。'),'请确认要修改哪个文件。');
});

test('persisted task waiting codes are translated for display only while natural and unrelated bodies are untouched',async()=>{
 const {NotificationService}=await import('../src/notifications/service.js');
 const {mkdtemp,readFile,realpath,rm}=await import('node:fs/promises');
 const os=await import('node:os');const pathModule=await import('node:path');
 const dir=await mkdtemp(pathModule.join(await realpath(os.tmpdir()),'notification-waiting-display-')),path=pathModule.join(dir,'notifications.json');
 let service=new NotificationService({path,userScope:'u',adapters:[]});
 const natural='请确认文件 task_runtime_unavailable.txt 的内容。';
 try{
  await service.open();
  for(const [id,type,body] of [['old','task_waiting','task_runtime_unavailable\n请在 Nova 中查看并处理。'],['human','task_waiting',natural],['other','feed','task_runtime_unavailable\n请在 Nova 中查看并处理。']] as const)await service.publish({event_key:id,revision:'1',occurrence:'initial',kind:'attention_required',title:'需要你处理',body,source:{type,id},created_at:Date.now(),expires_at:null,not_before:0,priority:60,coalesce_key:null,feedback:[]});
  await service.close();service=new NotificationService({path,userScope:'u',adapters:[]});await service.open();
  const before=await readFile(path,'utf8'),rows=service.display();
  assert.ok(rows[0]!.body.includes('回到电脑端'));assert.equal(rows[0]!.body.includes('task_runtime_unavailable'),false);
  assert.equal(rows[1]!.body,natural);assert.equal(rows[2]!.body,'task_runtime_unavailable\n请在 Nova 中查看并处理。');
  assert.equal(await readFile(path,'utf8'),before);assert.ok(before.includes('task_runtime_unavailable'));
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
});
