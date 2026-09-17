import assert from 'node:assert/strict'
import {readFile, mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'

// Optional manual QA: use an installed Playwright module and isolated browser profile.
const {chromium} = await import(process.env.NOVA_PLAYWRIGHT_MODULE || 'playwright')
import {bubbleWindowLayout, confirmationWindowLayout} from '../src/main/window-position.mjs'
import {DEFAULT_SETTINGS, publicSettings} from '../src/main/settings-store.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = resolve(process.env.NOVA_RENDERER_SMOKE_OUTPUT || `${root}/output/playwright/task-banner`)
await mkdir(output, {recursive:true})
const browser = await chromium.launch({headless:true, ...(process.env.NOVA_BROWSER_EXECUTABLE ? {executablePath:process.env.NOVA_BROWSER_EXECUTABLE} : {})})
try {
  const context = await browser.newContext({deviceScaleFactor:2, reducedMotion:'reduce'})
  await context.route('http://nova.test/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!/^\/[\w.-]+\.(html|css|mjs)$/.test(path)) return route.abort()
    const body = await readFile(`${root}/clients/desktop/src/renderer${path}`)
    await route.fulfill({body, contentType:path.endsWith('.mjs')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'})
  })
  const page = await context.newPage()
  const errors=[]
  page.on('pageerror', error=>{errors.push(error.message);console.error(error.message)})
  page.on('console', message=>{if(message.type()==='error')console.error(message.text())})
  let zoom=1, rows=0, taskRows=0, confirmation=false, inSettings=false, workHeight=1080
  let position={x:400,y:400,width:160,height:160}
  async function layout() {
    const area={x:0,y:0,width:1920,height:workHeight}
    const result=(rows||taskRows)?bubbleWindowLayout({normalBounds:position,rows,taskRows,zoomFactor:zoom,scaleFactor:2,workArea:area,confirmationActive:confirmation})
      :confirmation?confirmationWindowLayout({normalBounds:position,zoomFactor:zoom,workArea:area}):{bounds:position}
    const shape={...result,rows,suppressed:result.suppressed??false}
    if (!inSettings) await page.setViewportSize({width:result.bounds.width,height:result.bounds.height})
    return shape
  }
  await page.exposeFunction('__reserve',async (next, tasks)=>{rows=next;taskRows=tasks;return layout()})
  await page.exposeFunction('__confirm',async active=>{confirmation=active;return layout()})
  await page.addInitScript(view=>{
    const noop=()=>{}, listen=()=>noop
    window.__sent=[]
    window.__frame=frame=>window.__socket.onmessage?.({data:JSON.stringify(frame)})
    window.WebSocket=class {
      static OPEN=1;static CLOSING=2;static CLOSED=3;readyState=0
      constructor(){window.__socket=this;setTimeout(()=>{this.readyState=1;this.onopen?.({})},0)}
      send(data){window.__sent.push(data)}close(){this.readyState=3}
    }
    const emitLayout=layout=>{
      window.__placement?.(layout.confirmationPlacement||layout.placement||'below')
      window.__bubbleLayout?.(layout)
      return layout
    }
    window.novaAudioAgentDesktop={
      bootstrap:async()=>({backend:{endpoint:'ws://127.0.0.1:9999/',token:'0'.repeat(32)},settings:{palette:'ember'},platform:'darwin',audioMode:'browser',cameraSource:'local',nativeAvailable:false,backendStatus:'connected'}),
      wakeWord:{onChanged:listen,activity:noop,report:noop,audio:noop},
      onBackendExit:listen,onBackendReady:listen,onBackendStatus:listen,
      microphone:{onToggle:listen,requestPermission:async()=>({status:'denied'}),report:noop,onRetry:listen},
      camera:{requestPermission:async()=>({status:'denied'})},
      nativeAudio:{onEvent:listen,clear:async()=>{},setCaptureEnabled:async()=>false},
      orbMenu:{show:noop,openSettings:noop},windowDrag:{start:noop,move:noop,end:noop},
      executorResult:{open:async result=>{window.__openedResult=result}},
      windowLayout:{onConfirmationPlacement:cb=>(window.__placement=cb,noop),
        onBubbleLayout:cb=>(window.__bubbleLayout=cb,noop),
        reserveBubbleArea:async (next,tasks)=>emitLayout(await window.__reserve(next,tasks)),
        setConfirmationMode:active=>{void window.__confirm(active).then(emitLayout)}},
      settings:{get:async()=>view,onChanged:cb=>(window.__settingsChanged=cb,noop),set:async patch=>({...view,...patch,saved:true,operationStatus:'applied',rejectedSecrets:[]})},
    }
  },{...publicSettings(DEFAULT_SETTINGS),backendStatus:'connected',settingsApplyStatus:'idle',secretsPresent:{},keyringAvailable:true,codexStatus:{state:'ready'},managedWorkspaces:{health:'ready',current:null,all:[]}})
  await page.setViewportSize({width:160,height:160})
  await page.goto('http://nova.test/index.html')
  await page.waitForFunction(()=>window.__socket?.readyState===1)
  const task = (work_id, project, title, summary, phase='working', ts=1) => ({work_id, executor:'codex', project, title, summary, phase, ts})
  const tasks = Array.from({length: 6}, (_, i) => task(String(i), `工作区 ${i+1}`, `编程任务 ${i+1}`, '正在检查实现和运行结果。'))
  await page.evaluate(tasks=>window.__frame({type:'executor.tasks',revision:1,active_project:'工作区 1',tasks}),tasks)
  await page.waitForFunction(()=>!document.querySelector('#task-banner').hidden)
  assert.equal(await page.locator('.task-card:visible').count(), 3)
  assert.equal(await page.locator('[data-task-expand]').textContent(), '展开其余 3 个任务')
  for (const factor of [1,1.5,2]) {
    zoom=factor
    await page.evaluate(z=>document.documentElement.style.zoom=z,zoom)
    await page.evaluate(view=>window.__bubbleLayout(view),await layout())
    const card=await page.locator('#task-banner').boundingBox(), orb=await page.locator('#orb').boundingBox()
    assert.ok(card.y >= orb.y+orb.height, 'cards stay below the orb')
    assert.ok(card.y+card.height <= page.viewportSize().height+1)
    await page.screenshot({path:`${output}/tasks-${factor}.png`})
  }
  zoom=1
  await page.evaluate(()=>document.documentElement.style.zoom=1)
  await page.evaluate(view=>window.__bubbleLayout(view),await layout())
  await page.locator('[data-task-expand]').click()
  assert.equal(await page.locator('.task-card:visible').count(), 6)
  assert.equal(await page.locator('[data-task-expand]').getAttribute('aria-expanded'), 'true')
  await page.locator('.task-card').nth(5).locator('[data-open]').click()
  let action=await page.evaluate(()=>window.__sent.map(JSON.parse).filter(s=>s.type==='executor.task_action').at(-1))
  assert.equal(action.work_id,'5'); assert.equal(action.action,'open')
  await page.evaluate(a=>window.__frame({...a,type:'executor.task_action_result',status:'opened'}),action)
  await page.locator('.task-card').nth(4).locator('[data-stop]').click()
  action=await page.evaluate(()=>window.__sent.map(JSON.parse).filter(s=>s.type==='executor.task_action').at(-1))
  assert.equal(action.work_id,'4'); assert.equal(action.action,'cancel')
  assert.equal(await page.locator('.task-card').nth(4).locator('[data-stop]').isDisabled(),true)
  assert.equal(await page.locator('.task-card').nth(3).locator('[data-stop]').isDisabled(),false)
  await page.locator('[data-task-expand]').click()
  assert.equal(await page.locator('.task-card:visible').count(), 3)
  await page.evaluate(()=>window.__frame({type:'executor.progress',executor:'vision',delegate_id:'monitor',phase:'alert',summary:'检测到需要留意的新情况。',level:'milestone',ts:3}))
  await page.waitForFunction(()=>document.querySelectorAll('.progress-bubble').length===1)
  const alert=await page.locator('.progress-bubble').boundingBox(), orb=await page.locator('#orb').boundingBox(), cards=await page.locator('#task-banner').boundingBox()
  assert.ok(alert.y+alert.height <= orb.y+1, 'chat stays above orb')
  assert.ok(cards.y >= orb.y+orb.height, 'cards stay below orb with chat present')
  await page.screenshot({path:`${output}/tasks-and-chat.png`})
  await page.locator('[data-task-hide]').click()
  assert.equal(await page.locator('#task-banner').isVisible(),false)
  await page.locator('#last-result').dispatchEvent('click')
  await page.waitForFunction(()=>!document.querySelector('#task-banner').hidden)
  await page.evaluate(()=>window.__socket.onclose?.({code:1006,reason:''}))
  assert.equal(await page.locator('.task-card').first().locator('[data-open]').isDisabled(),true)
  assert.deepEqual(errors,[])
  console.log('Task list passed: three cards, expand/collapse, per-task actions, zoom, chat coexistence and disconnect')
} finally {await browser.close()}
