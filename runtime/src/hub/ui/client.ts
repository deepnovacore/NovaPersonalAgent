/** Browser code is embedded so normal runtime compilation also packages the console. */
export const hubClient=String.raw`
(() => {
 'use strict';
 const $ = id => document.getElementById(id);
 const kinds = {desktop:'电脑',mobile:'手机',worker:'服务',unknown:'设备'};
 const capabilities = {desktop_computer:'电脑操作',desktop_browser:'浏览器',desktop_coding:'编程',android_native:'Android',ios_native:'iOS'};
 const phases = {offered:'等待接收',running:'执行中',waiting_approval:'等待确认',verifying:'核验中',completed:'已完成',cancelled:'已取消',interrupted:'已中断'};
 const deliveries = {pending:'等待送达',accepted:'已接收',rejected:'已拒绝',expired:'已过期',sender_revoked:'发送设备已撤销'};
 const icons = {desktop:'M4 4h16v12H4z M8 20h8 M12 16v4',mobile:'M7 2h10v20H7z M11 18h2',worker:'M4 4h16v6H4z M4 14h16v6H4z M7 7h1 M7 17h1',unknown:'M5 5h14v14H5z M9 9h6v6H9z'};
 let token = '', generation = 0, controller = null, busy = false;
 let data = {}, failures = {};
 const safeTransport = location.protocol === 'https:' || (location.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(location.hostname));

 function el(tag, className, text) {
  const node = document.createElement(tag);
  if(className) node.className = className;
  if(text !== undefined) node.textContent = String(text);
  return node;
 }
 function short(id) { return String(id || '').slice(0,8); }
 function status(text, online) {
  const badge = $('connection-state');
  badge.className = 'pill' + (online ? ' online' : '');
  badge.replaceChildren(el('i'),el('span','',text));
 }
 function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').className = 'notice' + (error ? ' error' : '');
  $('notice').hidden = !text;
 }
 function empty(target, title, description) {
  const node = el('div','empty');
  node.append(el('h3','',title),el('p','',description));
  $(target).replaceChildren(node);
 }
 function setBusy(value) {
  busy = value;
  $('connect').disabled = value || !safeTransport;
  $('token').disabled = value || !safeTransport;
  $('refresh').disabled = value || !token;
  $('refresh').setAttribute('aria-busy',String(value));
 }
 function reset(message = '') {
  generation++;
  if(controller) controller.abort();
  controller = null; token = ''; data = {}; failures = {};
  $('token').value = '';
  $('connection').open = true;
  $('connect-form').hidden = false;
  $('connected-account').hidden = true;
  $('account-name').textContent = '';
  $('connection-title').textContent = '连接到 Hub';
  $('updated-at').textContent = '等待连接';
  ['online-count','active-count','device-badge','task-badge'].forEach(id => $(id).textContent = '—');
  $('device-total').textContent = '等待连接';
  $('primary-name').textContent = '尚未连接';
  $('primary-name').removeAttribute('title');
  $('primary-description').textContent = '连接后查看设备协作关系';
  ['device-error','task-error'].forEach(id => { $(id).hidden = true; $(id).textContent = ''; });
  empty('devices','尚未连接','连接后查看已登记的设备。');
  empty('tasks','尚未连接','连接后查看设备间的任务记录。');
  status('未连接',false); setBusy(false); notice(message,Boolean(message));
 }
 function deviceRows() {
  const presence = new Map((data.devices || []).map(row => [row.device_id,row]));
  const members = data.members || (data.devices || []).map(row => ({device_id:row.device_id,kind:'unknown'}));
  return members.filter(row => !row.revoked).map(row => ({...row,...presence.get(row.device_id),reported:presence.has(row.device_id)}))
   .sort((a,b) => Number(b.device_id === data.authority?.primary_device_id) - Number(a.device_id === data.authority?.primary_device_id) || Number(Boolean(b.online)) - Number(Boolean(a.online)) || String(a.name || a.device_id).localeCompare(String(b.name || b.device_id)));
 }
 function deviceName(id, rows) {
  const row = rows.find(item => item.device_id === id);
  return row?.name || (kinds[row?.kind] || '设备') + ' · ' + short(id);
 }
 function relativeTime(value) {
  const seconds = Math.max(0,Math.floor((Date.now() - value)/1000));
  if(!Number.isFinite(seconds)) return '时间未知';
  if(seconds < 60) return '刚刚';
  if(seconds < 3600) return Math.floor(seconds/60) + ' 分钟前';
  if(seconds < 86400) return Math.floor(seconds/3600) + ' 小时前';
  return Math.floor(seconds/86400) + ' 天前';
 }
 function deviceIcon(kind) {
  const box = el('span','device-symbol');
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true');
  const path = document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d',icons[kind] || icons.unknown); svg.append(path); box.append(svg);
  return box;
 }
 function panelError(id, keys, hasData) {
  const failed = keys.some(key => failures[key]);
  $(id).hidden = !failed;
  $(id).textContent = failed ? (hasData ? '部分状态更新失败，以下结果可能已过时。请重试刷新。' : '暂时无法读取状态，请重试刷新。') : '';
 }
 function renderDevices(rows) {
  const available = Array.isArray(data.members) || Array.isArray(data.devices);
  panelError('device-error',['members','devices'],available);
  $('device-badge').textContent = available ? String(rows.length) : '—';
  $('device-total').textContent = available ? '/ ' + rows.length + ' 台设备' : '状态不可用';
  $('online-count').textContent = Array.isArray(data.devices) ? String(rows.filter(row => row.online).length) : '—';
  if(!rows.length) {
   empty('devices',available ? '暂无设备' : '设备状态暂不可用',available ? '设备登记后会显示在这里。' : '请稍后刷新，再试一次。');
   return;
  }
  const cards = rows.map(row => {
   const primary = row.device_id === data.authority?.primary_device_id;
   const card = el('article','device-card' + (primary ? ' is-primary' : ''));
   const label = el('div','device-label');
   const info = el('div','device-info');
   const state = el('span','pill ' + (!row.reported ? 'unknown' : row.online ? 'online' : 'offline'));
   state.append(el('i'),el('span','',!row.reported ? '尚未上报' : row.online ? '在线' : '离线'));
   const heading = el('h3','',deviceName(row.device_id,rows));
   heading.title = String(row.device_id);
   const meta = el('div','device-meta');
   meta.append(el('span','',kinds[row.kind] || '设备'));
   if(primary) meta.append(el('span','primary-tag','主设备'));
   if(row.device_id === data.identity?.device_id) meta.append(el('span','','当前身份'));
   const tags = el('div','capabilities');
   for(const capability of row.capabilities || []) tags.append(el('span','capability',capabilities[capability] || capability));
   if(!tags.children.length) tags.append(el('span','capability','尚未声明能力'));
   const seen = el('p','device-seen',row.reported ? '最近上报 · ' + relativeTime(row.last_seen) : '等待设备首次上报');
   if(row.reported && Number.isFinite(row.last_seen)) seen.title = new Date(row.last_seen).toLocaleString('zh-CN');
   info.append(heading,meta); label.append(deviceIcon(row.kind),info);
   const statusColumn = el('div','device-state'); statusColumn.append(state,seen);
   card.append(label,tags,statusColumn);
   return card;
  });
  $('devices').replaceChildren(...cards);
 }
 function renderTasks(rows) {
  const available = Array.isArray(data.tasks), tasks = data.tasks || [];
  panelError('task-error',['tasks'],available);
  $('task-badge').textContent = available ? String(tasks.length) : '—';
  $('active-count').textContent = available ? String(tasks.filter(task => ['running','waiting_approval','verifying'].includes(task.phase)).length) : '—';
  if(!tasks.length) {
   empty('tasks',available ? '暂时没有任务' : '任务状态暂不可用',available ? '设备发起任务后，可在这里查看执行进度。' : '请稍后刷新，再试一次。');
   return;
  }
  $('tasks').replaceChildren(...tasks.map(task => {
   const node = el('article','task');
   const marker = el('span','task-icon',task.phase === 'completed' ? '✓' : task.phase === 'running' ? '↗' : '·');
   marker.setAttribute('aria-hidden','true');
   const content = el('div','task-main');
   const title = el('h3','',task.goal); title.title = String(task.task_id);
   const meta = el('div','task-meta');
   const phaseClass = ['running','verifying','completed'].includes(task.phase) ? ' active' : task.phase === 'waiting_approval' ? ' warning' : '';
   meta.append(el('span','task-phase' + phaseClass,phases[task.phase] || task.phase),el('span','',deviceName(task.owner_device_id,rows)));
   content.append(title,meta);
   if(task.summary) content.append(el('p','',task.summary));
   content.append(el('div','task-delivery','投递 · ' + (deliveries[task.delivery] || task.delivery)));
   node.append(marker,content); return node;
  }));
 }
 function renderPrimary(rows) {
  const primary = data.authority?.primary_device_id;
  $('primary-name').textContent = primary ? deviceName(primary,rows) : data.authority === null ? '未设置主设备' : '状态不可用';
  $('primary-name').title = primary || '';
  $('primary-description').textContent = failures.authority ? '更新失败，状态可能已过时' : data.authority?.pending ? '正在交接主设备' : primary ? (data.authority.mode === 'pc_primary' ? '由电脑协调设备协作' : '由手机协调设备协作') : '在设备端初始化后显示';
 }
 async function request(path, currentToken, signal) {
  const response = await fetch('/hub/v1/' + path,{
   headers:{authorization:'Bearer ' + currentToken},credentials:'omit',cache:'no-store',redirect:'error',
   signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])
  });
  if(response.status === 401) throw new Error('unauthorized');
  if(!response.ok) throw new Error('request_failed');
  return response.json();
 }
 async function refresh() {
  if(busy || !token) return;
  const current = ++generation, currentToken = token;
  controller = new AbortController();
  const signal = controller.signal;
  setBusy(true); notice(''); status(data.identity ? '正在刷新' : '正在连接',false);
  try {
   const identity = await request('identity',currentToken,signal);
   if(current !== generation) return;
   if(!identity || typeof identity.account_id !== 'string' || typeof identity.device_id !== 'string') throw new Error('request_failed');
   if(data.identity && (data.identity.account_id !== identity.account_id || data.identity.hub_id !== identity.hub_id)) {
    reset('Hub 身份已变化，请重新连接。'); return;
   }
   data.identity = identity;
   $('connect-form').hidden = true; $('connected-account').hidden = false;
   $('account-name').textContent = identity.account_id;
   $('connection-title').textContent = '已连接 · ' + identity.account_id;
   $('connection').open = false;
   const keys = ['devices','members','tasks','authority'];
   const paths = ['devices','authority/members','tasks','authority'];
   const results = await Promise.allSettled(paths.map(path => request(path,currentToken,signal)));
   if(current !== generation) return;
   if(results.some(result => result.status === 'rejected' && result.reason?.message === 'unauthorized')) {
    reset('访问令牌已失效，请使用有效令牌重新连接。'); return;
   }
   results.forEach((result,index) => {
    const key = keys[index];
    if(result.status === 'fulfilled' && (key === 'authority' ? result.value === null || typeof result.value === 'object' : Array.isArray(result.value))) {
     data[key] = result.value; failures[key] = false;
    } else failures[key] = true;
   });
   const rows = deviceRows(); renderDevices(rows); renderTasks(rows); renderPrimary(rows);
   const partial = Object.values(failures).some(Boolean);
   status(partial ? '部分更新失败' : '已连接',!partial);
   $('updated-at').textContent = (partial ? '部分更新 · ' : '更新于 ') + new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
   if(partial) notice('部分状态暂时无法更新，请稍后刷新。');
  } catch(error) {
   if(current !== generation) return;
   if(error.message === 'unauthorized') { reset('访问令牌无效或已撤销，请重新输入。'); return; }
   if(!data.identity) { reset('无法连接 Hub，请检查服务是否运行后重试。'); return; }
   status('连接中断',false);
   notice('暂时无法连接 Hub，当前显示的是上次结果。请稍后刷新。');
  } finally {
   if(current === generation) { controller = null; setBusy(false); }
  }
 }
 $('server-origin').textContent = location.host;
 $('server-origin').title = location.origin;
 $('connect-form').addEventListener('submit',event => {
  event.preventDefault();
  if(busy || !safeTransport) return;
  const value = $('token').value.trim();
  if(!/^[A-Za-z0-9_-]{43}$/.test(value)) { notice('请输入有效的设备访问令牌。',true); $('token').focus(); return; }
  reset(); token = value; void refresh();
 });
 $('refresh').addEventListener('click',() => { void refresh(); });
 $('disconnect').addEventListener('click',() => { reset(); $('token').focus(); });
 window.addEventListener('pagehide',() => reset());
 if(!safeTransport) {
  setBusy(false);
  notice('请通过 HTTPS 或本机回环地址打开控制台后连接。',true);
 }
})();
`
