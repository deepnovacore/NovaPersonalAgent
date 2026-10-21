import {mountPersonalView} from '../src/renderer/personal-view.mjs'
const transport=window.workbenchAcceptance
const view=mountPersonalView({send:frame=>{transport.send(frame);return true},start:async()=>{throw Error('Microphone is outside this text acceptance')},stop:async()=>{},tasks:()=>[],results:()=>[],taskAction:()=>{},api:{personal:{chooseBuildDirectory:()=>transport.directory(),setUnread:async()=>{}},orbMenu:{},windowControls:{}}})
transport.onFrame(frame=>view.receive(frame))
await view.controller.connect()
// Expose only read-only state for assertions. All operations use actual rendered controls.
window.acceptanceState=()=>({selected:view.controller.selectedId,items:view.controller.snapshot?.conversations?.items??[],error:view.controller.error})
transport.ready()
