import assert from 'node:assert/strict'
import {createHash, randomUUID} from 'node:crypto'
import {readFile, writeFile, rename, stat, rm} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

export const RECOVERY_STATUS = '[Runtime recovery status, not a model answer] The preceding request failed or was interrupted. No task completion is claimed. The next user message is the current request; follow it while preserving safety and project constraints.'
const PI_BEFORE = `            if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
                continue;
            }`
const PI_LEGACY_AFTER = `            if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
                // Nova compatibility: retain a truthful runtime boundary, never replay partial/error content.
                result.push({...assistantMsg, content:[{type:"text",text:${JSON.stringify(RECOVERY_STATUS)}}], stopReason:"stop", errorMessage:undefined});
                continue;
            }`
const PI_INTERMEDIATE_AFTER = PI_LEGACY_AFTER.replace('                result.push(', '                if (transformed.slice(i + 1).some(message => message.role === "user")) result.push(')
const PI_AFTER = PI_LEGACY_AFTER.replace('                result.push(', '                if (transformed[i + 1]?.role === "user") result.push(')
const DSH_BEFORE = '\t\tconst boundaryMessages = session.deriveMessages();'
const DSH_LEGACY_AFTER = `\t\tconst boundaryMessages = session.deriveMessages();
        // Nova compatibility: failed no-reply turns still separate successive user requests.
        const currentUser = boundaryMessages.findLastIndex(message => message.role === "user" && message.source?.kind === "user");
        let previousEnd;
        for (let seq = session.seq - 1; seq >= 0; seq--) {
            const event = session.eventAt(seq);
            if (event?.type === "turn/end") {previousEnd=event;break;}
        }
        if (previousEnd?.data.reason?.kind === "error" && currentUser > 0) {
            const previousUser = boundaryMessages.slice(0,currentUser).findLastIndex(message => message.role === "user" && message.source?.kind === "user");
            if (previousUser >= 0 && !boundaryMessages.slice(previousUser+1,currentUser).some(message => message.role === "assistant")) {
                boundaryMessages.splice(currentUser,0,{id:randomUUID(),role:"assistant",content:[{type:"text",text:${JSON.stringify(RECOVERY_STATUS)}}],source:{kind:"runtime-recovery-status"}});
            }
        }`
const DSH_AFTER = `\t\tconst boundaryMessages = [...session.deriveMessages()];
        // Nova compatibility: stable input-only boundaries for failed no-reply requests.
        const failedUsers = new Set();
        let userId;
        for (let seq = 0; seq < session.seq; seq++) {
            const event = session.eventAt(seq);
            if (event?.type === "user/message" && event.data?.source?.kind === "user") userId = event.data.id;
            if (event?.type === "turn/end" && userId) {
                if (["error","aborted"].includes(event.data?.reason?.kind)) failedUsers.add(userId);
                else failedUsers.delete(userId);
            }
        }
        for (let current = boundaryMessages.length - 1; current > 0; current--) {
            if (boundaryMessages[current].role !== "user" || boundaryMessages[current].source?.kind !== "user") continue;
            let previous = current - 1;
            while (previous >= 0 && boundaryMessages[previous].role !== "user" && boundaryMessages[previous].role !== "assistant") previous--;
            const prior = boundaryMessages[previous];
            if (prior?.role === "user" && failedUsers.has(prior.id)) {
                boundaryMessages.splice(current,0,{id:prior.id+":nova-recovery-status",role:"assistant",content:[{type:"text",text:${JSON.stringify(RECOVERY_STATUS)}}],source:{kind:"runtime-recovery-status"}});
            }
        }`
const TARGETS = {
  '@earendil-works/pi-ai': {version:'1.1.0',entry:'dist/api/transform-messages.js',sha256:'9d747a3d64c533f7bfaf2a66e8446dc006086559d364a09d4c51d1c8c9c332e5',before:PI_BEFORE,after:PI_AFTER},
  '@deepseek-ai/dsh-agent-loop': {version:'0.2.0-rc.2',entry:'lib/index.js',sha256:'00c4814d63f3d1e2754eb09144832d19b30499d6ea444730473f740b587948c2',before:DSH_BEFORE,after:DSH_AFTER},
}
export function patchRecoverySource(name, source) {
  const target=TARGETS[name]
  assert(target,'Unsupported recovery package')
  assert(source.split(target.before).length===2,'Unexpected recovery implementation')
  return source.replace(target.before,()=>target.after)
}
export async function patchRecoveryPackage(packageRoot) {
  const meta=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'))
  const target=TARGETS[meta.name]
  assert(target && meta.version===target.version,'Unsupported recovery package version')
  const entry=join(packageRoot,target.entry),source=await readFile(entry,'utf8')
  const original=[target.after, ...(meta.name === '@earendil-works/pi-ai' ? [PI_INTERMEDIATE_AFTER,PI_LEGACY_AFTER] : [DSH_LEGACY_AFTER])].reduce((text,patch)=>text.replace(patch,()=>target.before),source)
  assert(createHash('sha256').update(original).digest('hex')===target.sha256,'Unexpected recovery entry integrity')
  const patched=patchRecoverySource(meta.name,original)
  if(source===patched)return {package:meta.name,version:meta.version,changed:false}
  const temporary=`${entry}.nova-${randomUUID()}`,info=await stat(entry)
  try {await writeFile(temporary,patched,{mode:info.mode&0o777});await rename(temporary,entry)}
  finally {await rm(temporary,{force:true})}
  return {package:meta.name,version:meta.version,changed:true}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv.length>2,'Usage: patch-acp-recovery.mjs PACKAGE_ROOT...')
  for(const root of process.argv.slice(2))console.log(JSON.stringify(await patchRecoveryPackage(resolve(root))))
}
