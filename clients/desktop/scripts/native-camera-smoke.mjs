// Explicit hardware acceptance. Captures stay local; no model request or image file is produced.
import {app, BrowserWindow, systemPreferences} from 'electron'
import {pathToFileURL} from 'node:url'
import {resolve} from 'node:path'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
app.setPath('userData', mkdtempSync(resolve(tmpdir(), 'nova-native-camera-')))
async function main() {
  await app.whenReady()
  const window = new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}})
  const timeout = setTimeout(() => { console.log(JSON.stringify({status:'timeout'}));app.exit(1) },30000)
  try {
    if (process.platform === 'darwin' && !await systemPreferences.askForMediaAccess('camera')) throw new Error('camera_permission_denied')
    window.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === 'media'))
    await window.loadFile(resolve(import.meta.dirname,'../src/renderer/settings.html'))
    const moduleUrl = pathToFileURL(resolve(import.meta.dirname,'../src/renderer/camera.mjs')).href
    const result = await window.webContents.executeJavaScript(`(async () => {
      const {CameraDevicePool, RendererCameraController} = await import(${JSON.stringify(moduleUrl)});
      const pool = new CameraDevicePool(navigator.mediaDevices, ImageCapture);
      try {
        const first = await pool.acquire('conversation-smoke');
        const bitmap = await first.capture.grabFrame();
        const size = [bitmap.width, bitmap.height]; bitmap.close();
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
        const id = first.stream.getVideoTracks()[0].getSettings().deviceId;
        const monitor = await pool.acquire('monitor-smoke', id);
        if (monitor !== first) throw new Error('sharing failed');
        pool.release('conversation-smoke');
        const next = await monitor.capture.grabFrame(); next.close();
        const track = monitor.stream.getVideoTracks()[0];
        pool.release('monitor-smoke');
        if (track.readyState !== 'ended') throw new Error('camera release failed');
        const controller = new RendererCameraController({mediaDevices:navigator.mediaDevices, ImageCapture, OffscreenCanvas});
        controller.setSourceMode('local'); controller.setConversationEnabled(true);
        let wireBytes;
        try {
          wireBytes = await new Promise((resolve, reject) => controller.enqueue(JSON.stringify({
            type:'camera.capture',request_id:'camera-1',source:'local',session_id:'conversation-wire',device_id:''
          }), {generation:{},isCurrent:()=>true,sendText:()=>reject(new Error('wire capture failed')),sendBinary:bytes=>resolve(bytes.byteLength)}));
          controller.releaseSession('conversation-wire');
        } finally {controller.dispose()}
        return {status:'passed',cameraCount:devices.length,dimensions:size,shared:true,released:track.readyState==='ended',wireBytes};
      } finally {pool.dispose()}
    })()`)
    console.log(JSON.stringify(result))
  } catch (error) { console.log(JSON.stringify({status:'failed',error:error instanceof Error ? error.message : 'unknown'}));process.exitCode=1 }
  finally {clearTimeout(timeout);window.destroy();app.exit(process.exitCode ?? 0)}

}
void main()
