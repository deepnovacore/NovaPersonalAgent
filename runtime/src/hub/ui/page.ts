export const hubIcon='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="12" fill="#24674e"/><g fill="none" stroke="#fff" stroke-width="2"><path d="M12 12l16 16M28 12L12 28"/><circle cx="20" cy="20" r="5" fill="#24674e"/><circle cx="11" cy="11" r="2"/><circle cx="29" cy="11" r="2"/><circle cx="11" cy="29" r="2"/><circle cx="29" cy="29" r="2"/></g></svg>'

export const hubPage=String.raw`<!doctype html>
<html lang="zh-CN">
<head>
 <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
 <meta name="color-scheme" content="light"><title>Nova Hub · 设备控制台</title>
 <link rel="icon" href="/hub-ui/icon.svg" type="image/svg+xml">
 <link rel="stylesheet" href="/hub-ui/style.css"><script src="/hub-ui/app.js" defer></script>
</head>
<body>
 <div class="shell">
  <header class="topbar">
   <a class="brand" href="/" aria-label="Nova Hub 首页"><img src="/hub-ui/icon.svg" width="28" height="28" alt=""><span>Nova Hub</span></a>
   <div class="top-status"><span id="connection-state" class="pill"><i></i><span>未连接</span></span><span id="server-origin" class="origin"></span></div>
  </header>
  <main>
   <section class="hero" aria-labelledby="page-title">
    <div><h1 id="page-title">设备与任务</h1></div>
    <div class="hero-actions"><span id="updated-at">等待连接</span><button id="refresh" class="button secondary" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/></svg>刷新</button></div>
   </section>
   <div id="notice" class="notice" role="status" aria-live="polite" hidden></div>
   <details id="connection" class="connection panel" open>
    <summary><span class="connection-label"><span id="connection-title">连接到 Hub</span></span><span class="summary-hint">连接设置 <span aria-hidden="true">⌄</span></span></summary>
    <div class="connection-body">
     <div class="connection-explanation"><p>输入设备访问令牌，查看所属账户的设备和任务。</p><p class="quiet">令牌不会保存，刷新页面后需要重新连接。</p></div>
     <form id="connect-form" autocomplete="off"><label for="token">访问令牌</label><div class="input-row"><input id="token" name="token" type="password" placeholder="粘贴访问令牌" required autocomplete="off" spellcheck="false" aria-describedby="token-help"><button id="connect" class="button primary" type="submit">连接 Hub</button></div><details class="token-help"><summary>如何获取令牌？</summary><p id="token-help">使用已有设备令牌，或在 Hub 所在电脑上运行 enroll 命令登记设备。</p></details></form>
     <div id="connected-account" hidden><span class="quiet">当前账户</span><p id="account-name"></p><button id="disconnect" class="button secondary" type="button">断开连接</button></div>
    </div>
   </details>
   <section class="metrics" aria-label="协作概览">
    <div class="metric"><span class="metric-label">在线</span><strong id="online-count">—</strong><span id="device-total">等待连接</span></div>
    <div class="metric"><span class="metric-label">进行中</span><strong id="active-count">—</strong><span>项任务</span></div>
    <div class="metric primary-metric"><span class="metric-label">主设备</span><strong id="primary-name">尚未连接</strong><span id="primary-description" class="visually-hidden">连接后查看设备协作关系</span></div>
   </section>
   <div class="workspace">
    <section class="panel devices-panel" aria-labelledby="devices-title">
     <div class="section-heading"><h2 id="devices-title">设备 <span id="device-badge" class="count">—</span></h2><span class="section-note">90 秒内上报视为在线</span></div>
     <p id="device-error" class="panel-error" role="status" hidden></p>
     <div class="device-columns" aria-hidden="true"><span>设备名称</span><span>能力</span><span>状态 / 最近上报</span></div>
     <div id="devices" class="device-grid"><div class="empty"><h3>尚未连接</h3><p>连接后查看已登记的设备。</p></div></div>
    </section>
    <section class="panel tasks-panel" aria-labelledby="tasks-title">
     <div class="section-heading"><h2 id="tasks-title">最近任务 <span id="task-badge" class="count">—</span></h2><span class="section-note">最多显示 100 项</span></div>
     <p id="task-error" class="panel-error" role="status" hidden></p>
     <div id="tasks" class="task-list"><div class="empty"><h3>尚未连接</h3><p>连接后查看设备间的任务记录。</p></div></div>
    </section>
   </div>
  </main>
  <footer class="footer">此页面仅查看状态，数据在手动刷新时更新。</footer>
 </div>
 <noscript><p class="notice">请启用 JavaScript 以连接 Hub 并查看设备状态。</p></noscript>
</body>
</html>`
