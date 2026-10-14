import test from 'node:test'
import assert from 'node:assert/strict'
import {visorLayout} from '../src/main/visor-layout.mjs'

test('HUD and controls stay screen-centred inside asymmetric system bars, independent of DPI',()=>{
  for(const [width,height] of [[640,480],[1280,720],[1512,982],[1920,1080],[2560,1440],[3840,2160],[3440,1440],[1080,1920]]) {
    for(const [left,top,right,bottom] of [[0,33,0,89],[90,33,0,0],[0,24,80,0],[0,0,0,48],[0,0,0,0]]) {
      for(const [x,y,scaleFactor] of [[0,0,1],[-2560,-200,1.25],[1920,100,2]]) {
        const bounds={x,y,width,height},workArea={x:x+left,y:y+top,width:width-left-right,height:height-top-bottom}
        const {hud,controls}=visorLayout({bounds,workArea,scaleFactor})
        assert.equal(hud.x+hud.width/2,x+width/2)
        assert.equal(hud.y+hud.height/2,y+height/2)
        assert.ok(Math.abs(controls.x+controls.width/2-(x+width/2))<=.5)
        for(const rect of [hud,controls]) {
          assert.ok(rect.width>0&&rect.height>0)
          assert.ok(rect.x>=workArea.x&&rect.y>=workArea.y)
          assert.ok(rect.x+rect.width<=workArea.x+workArea.width)
          assert.ok(rect.y+rect.height<=workArea.y+workArea.height)
        }
      }
    }
  }
})

test('display changes relayout both production windows and dispose removes listeners',async()=>{
  const {readFile}=await import('node:fs/promises'),{default:vm}=await import('node:vm'),{EventEmitter}=await import('node:events')
  const source=(await readFile(new URL('../src/main/visor.mjs',import.meta.url),'utf8')).replace(/^import .*$/gm,'').replace('export function','function')
  const screen=new EventEmitter(),nativeTheme=new EventEmitter()
  let display={bounds:{x:0,y:0,width:1512,height:982},workArea:{x:0,y:33,width:1512,height:860}}
  screen.getPrimaryDisplay=()=>display
  class Window extends EventEmitter {
    webContents={send(){},setWindowOpenHandler(){},on(){}}
    setAlwaysOnTop(){} setVisibleOnAllWorkspaces(){} setIgnoreMouseEvents(){}
    loadURL(){return Promise.resolve()} setBounds(value){this.bounds=value}
    isDestroyed(){return !!this.destroyed} destroy(){this.destroyed=true}
  }
  const context=vm.createContext({BrowserWindow:Window,screen,nativeTheme,visorLayout,currentLanguage:()=> 'zh-CN',
    createHardwareSampler:()=>async()=>null,visorPreferences:()=>({enabled:true}),readFileSync:()=> '{}',
    setTimeout,clearTimeout,setInterval:()=>1,clearInterval,console})
  vm.runInContext(source+'; globalThis.visor=createVisor({readAI:()=>({})}); visor.start()',context)
  const verify=()=>context.visor.windows().forEach((w,i)=>assert.deepEqual(w.bounds,visorLayout(display)[i?'controls':'hud']))
  verify()
  for(const event of ['display-metrics-changed','display-added','display-removed']) {
    display={bounds:{x:-1920,y:0,width:1920,height:1080},workArea:{x:-1820,y:24,width:1820,height:1056},scaleFactor:2}
    screen.emit(event);verify()
  }
  context.visor.dispose()
  assert.equal(screen.eventNames().length,0)
  assert.equal(nativeTheme.eventNames().length,0)
})
