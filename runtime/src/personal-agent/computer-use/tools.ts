import {z} from 'zod'
import type {CascadedLlmTool} from '../../realtime/cascaded/llm.js'
import {computerToolArguments,COMPUTER_VISION_TOOLS,type ComputerToolName} from './contract.js'

const descriptions:Record<ComputerToolName,string>={
 computer_screenshot:'Observe the current screen. Coordinates of subsequent inputs refer to this image.',
 computer_click:'Click once at the screenshot point.',
 computer_type:'Type into the current focus. Click the field first.',
 computer_scroll:'Scroll once at the screenshot point.',
 computer_key:'Press a keyboard shortcut in the current focus.',
 computer_run:'Delegate a complete interface task to the supervised computer agent and wait for its result.',
}
export function computerTools(direct:boolean):CascadedLlmTool[]{
 return (Object.keys(computerToolArguments) as ComputerToolName[])
  .filter(name=>direct||!COMPUTER_VISION_TOOLS.includes(name))
  .map(name=>({name,description:descriptions[name],parameters:JSON.parse(JSON.stringify(z.toJSONSchema(computerToolArguments[name]))) as CascadedLlmTool['parameters']}))
}
