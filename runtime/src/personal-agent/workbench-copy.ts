import {isAbsolute,dirname,relative,sep} from 'node:path'
import type {JsonValue} from '../core/events.js'
import {localPath} from './local-tools.js'
import {shellClasses} from './workbench-shell-class.js'

type Language='zh-CN'|'en'
type CallLike={name:string;arguments:Record<string,JsonValue>}

const points=(text:string,limit:number):string=>{const all=[...text];return all.length>limit?all.slice(0,limit).join('')+'…':text}
const firstLine=(text:string):string=>points((text.split('\n').find(line=>line.trim())??'').trim(),40)
const baseName=(path:string):string=>path.split(/[\\/]+/u).filter(Boolean).at(-1)??path

export const commandLine=(call:CallLike):string=>firstLine(typeof call.arguments.command==='string'?call.arguments.command:'')

/** Plain-language description of one step, for pause messages and the pill. */
export function stepPhrase(call:CallLike,language:Language,app?:string):string{
  const en=language==='en',args=call.arguments,path=typeof args.path==='string'?baseName(args.path):''
  const where=app??(en?'the desktop app':'桌面应用')
  switch(call.name){
    case 'shell_execute':{const command=firstLine(typeof args.command==='string'?args.command:'');return en?`run the shell command "${command}"`:`用 shell 执行「${command}」`}
    case 'file_read':return en?`read the file outside the project "${path}"`:`读取项目外的文件「${path}」`
    case 'file_write':case 'file_edit':return en?`modify the file "${path}"`:`修改文件「${path}」`
    case 'computer_connect':{const name=(args.params as {application?:{name?:unknown}}|undefined)?.application?.name;return en?`control the app "${typeof name==='string'?name:where}"`:`操作应用「${typeof name==='string'?name:where}」`}
    case 'computer_screenshot':return en?`take a screenshot of "${where}"`:`给「${where}」截图`
    case 'computer_click':return en?`click in "${where}"`:`在「${where}」里点击`
    case 'computer_type':return en?`type in "${where}"`:`在「${where}」里输入`
    case 'computer_scroll':return en?`scroll in "${where}"`:`在「${where}」里滚动`
    case 'computer_key':return en?`press keys in "${where}"`:`在「${where}」里按快捷键`
    default:return call.name
  }
}

/**
 * The approval classes a call touches. Coarser than one exact call so the model cannot
 * rephrase its way back to the same thing, but never wider than the resource the user saw.
 * A shell command yields one class per constituent plus the file effects it provably has.
 */
export function approvalClasses(call:CallLike,project:string):string[]{
  const args=call.arguments
  if(call.name==='shell_execute')return shellClasses(typeof args.command==='string'?args.command:'',typeof args.cwd==='string'?args.cwd:undefined,project)
  if(call.name==='file_read'||call.name==='file_write'||call.name==='file_edit'){
    const kind=call.name==='file_read'?'read':'write'
    let resolved=typeof args.path==='string'?args.path:''
    try{resolved=localPath(project,resolved)}catch{ /* an invalid path keeps its spelling as the class */ }
    const outside=(()=>{const rel=relative(project,resolved);return rel.startsWith('..')||isAbsolute(rel)})()
    return [outside?`file-${kind}-outside:${dirname(resolved)}`:`file-${kind}:${resolved}`]
  }
  if(call.name==='computer_connect'){
    const app=(args.params as {application?:{bundleId?:unknown}}|undefined)?.application?.bundleId
    return ['computer:'+(typeof app==='string'?app:'')]
  }
  return [call.name.startsWith('computer_')?'computer-input':call.name]
}
const PATH_CLASS=/^(file-(?:read-outside|write-outside|write)):(.*)$/su
const overlaps=(a:string,b:string)=>a===b||b.startsWith(a.endsWith(sep)?a:a+sep)||a.startsWith(b.endsWith(sep)?b:b+sep)
/** True when any candidate class equals a denied one; file paths also match when one contains the other. */
export function classDenied(candidates:readonly string[],denied:Iterable<string>):boolean{
  const list=[...denied]
  return candidates.some(klass=>{
    if(list.includes(klass))return true
    if(klass==='shell:*')return list.some(item=>item.startsWith('shell:'))
    const path=PATH_CLASS.exec(klass)
    return !!path&&list.some(item=>{const other=PATH_CLASS.exec(item);return !!other&&other[1]===path[1]&&overlaps(path[2]!,other[2]!)})
  })
}

export const DENIED_MESSAGE='The user declined this action. It was not executed. Do not retry it or any equivalent action (same tool class or a different tool reaching the same resource). Continue with an approach that does not need it, or ask the user.'
export const DENIED_BEFORE_MESSAGE='The user already declined this kind of action earlier, so it was not executed and the user was not asked again. Do not retry it or any equivalent action (same tool class or a different tool reaching the same resource). Continue with an approach that does not need it, or ask the user.'
export const SKIPPED_MESSAGE='Not executed: an earlier action in the same batch was declined by the user.'
export const DENIED_RESUME_INSTRUCTION='The user declined the listed actions and chose to continue. Do not retry them or any equivalent action. Proceed with an approach that does not need them, or ask the user how to proceed.'

/** Pause copy the host writes itself, in the conversation language. Names the reason and the step. */
export function workbenchCopy(language:Language){
  const en=language==='en'
  return {
    denied(steps:readonly string[]):string{
      const list=en?steps.join(', '):steps.join('、'),many=steps.length>1
      return en?`Paused: you declined ${list}; ${many?'none of those steps ran':'that step did not run'}. Reply "Continue" and I will carry on without ${many?'them':'it'}, or tell me how you want it handled.`
        :`已暂停：你拒绝了${list}，${many?'这些步骤都没有执行':'这一步没有执行'}。回复「继续」，我会换一种不需要${many?'它们':'它'}的方式接着做；也可以直接告诉我该怎么处理。`
    },
    stopped(build:boolean):string{
      return en?(build?'Paused at your request. Everything done so far is kept. Reply "Continue" to pick up from here.':'Stopped at your request.')
        :(build?'已按你的要求暂停，做过的步骤都保留了。回复「继续」可以从这里接着做。':'已按你的要求停止。')
    },
    pausedNeutral(build:boolean):string{
      return en?(build?'Paused. Everything done so far is kept. Reply "Continue" to pick up from here.':'Stopped.')
        :(build?'已暂停，做过的步骤都保留了。回复「继续」可以从这里接着做。':'已停止。')
    },
    unverifiable(command:string):string{
      return en?`I cannot confirm that what "${command}" left behind has exited. Once you are sure that is fine, click "Continue" and I will carry on.`
        :`Nova 没法确认「${command}」留下的进程是否已退出。你确认没问题后点「继续」，Nova 会接着做。`
    },
    unverifiableShort(command:string):string{return en?`Cannot confirm "${command}" left nothing running`:`没法确认「${command}」留下的进程已退出`},
    pausedShort:en?'Paused; completed steps are kept':'已暂停，做过的步骤都保留了',
    deniedShort(steps:readonly string[]):string{const list=en?steps.join(', '):steps.join('、');return points(en?`You declined ${list}; not run`:`你拒绝了${list}，未执行`,280)},
    unknownShort(step:string):string{return points(en?`Cannot confirm the result of ${step}`:`无法确认${step}的结果`,280)},
    leftoverShort(command:string):string{return en?`"${command}" finished; a leftover process is not confirmed gone`:`「${command}」已结束，还有进程没确认退出`},
    stoppedShort:en?'Paused at your request':'已按你的要求暂停',
    unknown(step:string):string{
      return en?`Paused: I cannot confirm the result of ${step}, so I cannot tell whether it finished. Click "Continue" and I will check the actual state first.`
        :`已暂停：无法确认${step}的结果，不能判断它有没有执行完。点「继续」会先核实实际状态，再往下做。`
    },
    leftover(command:string,exit:number):string{
      return en?`"${command}" finished (exit code ${exit}), but a leftover process could not be confirmed gone, so I am not touching this project yet. Click "Continue" and I will check first, then carry on.`
        :`「${command}」已${exit===0?'正常':''}结束（退出码 ${exit}），但还有进程没确认退出，所以先不动这个项目里的东西。点「继续」会先核实，再往下做。`
    },
    roundLimit(build:boolean,completed:number,limit:number):string{
      if(!build)return en?'Plan paused at the 24-call limit. Send a message to continue planning.':'已达到本次 24 次工具调用上限，Plan 已暂停。发送消息继续完善计划。'
      return en?`Paused after ${completed} tool calls, the limit for one run (${limit}). Click "Continue" to keep going; finished steps will not be repeated.`
        :`已完成 ${completed} 次工具调用，达到单次 ${limit} 次的上限，先暂停了。点「继续」接着做，已完成的步骤不会重做。`
    },
    roundLimitShort(completed:number):string{return en?`Paused after ${completed} tool calls (limit reached)`:`已完成 ${completed} 次工具调用，达到上限`},
    generic:en?'Paused. Everything done so far is kept; click "Continue" to carry on.':'已暂停，做过的步骤都保留了，点「继续」接着做。',
    modelPaused(label:string):string{
      return en?`Build paused: ${label}. Click "Continue" to carry on. Completed operations will not be replayed.`:`Build 已暂停：${label}。点「继续」接着做，已完成的操作不会重放。`
    },
    outputLimitContinue:(build:boolean)=>build?(en?'Click "Continue" to carry on; completed operations will not be replayed.':'点「继续」接着做，已完成的操作不会重放。'):(en?'Send another message to continue.':'发送新消息继续。'),
  }
}
