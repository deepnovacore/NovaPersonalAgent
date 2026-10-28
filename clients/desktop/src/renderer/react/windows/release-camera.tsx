import React,{useEffect,useRef} from 'react'
import {CAMERA_FRAME_MAGIC,RendererCameraController} from '../../camera.mjs'
import {lockedCameraCodecSupported} from '../../release-camera-contract.mjs'
export function ReleaseCameraApp({api=(window as any).novaPersonalAgentDesktop.releaseCamera}:any={}) {
 const video=useRef<HTMLVideoElement>(null)
 useEffect(()=>{
  let disposed=false,reported=false,decodeTimer:any,captureTimer:any,controller:any
  const generation=Object.freeze({}),node=video.current!
  const releaseVideo=()=>{clearTimeout(decodeTimer);node.removeEventListener('loadeddata',loaded);node.removeEventListener('error',failed);try{node.pause()}catch{}node.removeAttribute('src');try{node.load()}catch{}}
  const report=(value:string)=>{if(disposed||reported)return;reported=true;clearTimeout(captureTimer);controller?.closeGeneration(generation);controller?.dispose();releaseVideo();api.report(value)}
  const loaded=()=>{releaseVideo();if(disposed)return;controller=new (RendererCameraController as any)({mediaDevices:navigator.mediaDevices,ImageCapture:(globalThis as any).ImageCapture,OffscreenCanvas:globalThis.OffscreenCanvas,createVideo:()=>document.createElement('video')});controller.setSourceMode('file');captureTimer=setTimeout(()=>report('capture_failed'),6000);controller.enqueue(JSON.stringify({type:'camera.capture',request_id:'camera-release-smoke',source:'file',position_ms:0}),Object.freeze({generation,isCurrent:()=>!reported&&!disposed,sendText:()=>report('capture_failed'),sendBinary:(value:any)=>report(value instanceof Uint8Array&&value.byteLength>CAMERA_FRAME_MAGIC.byteLength&&CAMERA_FRAME_MAGIC.every((byte:number,index:number)=>value[index]===byte)?'passed':'capture_failed')}))}
  const failed=()=>report('chromium_codec_unavailable')
  if(!lockedCameraCodecSupported(node.canPlayType?.bind(node))){report('chromium_codec_unavailable');return()=>{disposed=true}}
  node.addEventListener('loadeddata',loaded,{once:true});node.addEventListener('error',failed,{once:true});decodeTimer=setTimeout(()=>report('capture_failed'),5000);node.src='nova://orb/camera-source';node.load()
  return()=>{disposed=true;clearTimeout(captureTimer);releaseVideo();controller?.closeGeneration(generation);controller?.dispose()}
 },[api])
 return <video ref={video} muted playsInline preload="auto" hidden aria-hidden="true"/>
}
