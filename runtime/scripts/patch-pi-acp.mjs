import assert from 'node:assert/strict'
import {createHash, randomUUID} from 'node:crypto'
import {readFile, writeFile, rename, stat, chmod, rm} from 'node:fs/promises'
import {resolve, join} from 'node:path'
import {pathToFileURL} from 'node:url'

const ORIGINAL_SHA256 = '324aeb8bba1228937e16b1326fb3e014e2a625b2dea549dbcd49b006cd5df6a2'
const BEFORE = '    const stopReason = result === "error" ? session.wasCancelRequested() ? "cancelled" : "end_turn" : result;'
const AFTER = `    if (result === "error" && !session.wasCancelRequested()) {
      throw new RequestError3(-32603, "Pi model invocation failed");
    }
    const stopReason = result === "error" ? "cancelled" : result;`

const SETTLE_BEFORE = '    const reason = this.cancelRequested ? "cancelled" : "end_turn";'
const SETTLE_AFTER = `    let reason = this.cancelRequested ? "cancelled" : "end_turn";
    if (!this.cancelRequested) {
      try {
        const data = await this.proc.getMessages();
        if (!Array.isArray(data?.messages)) throw new Error("Invalid Pi message result");
        const userIndex = data.messages.findLastIndex(message => message?.role === "user");
        const assistant = data.messages.slice(userIndex + 1).findLast(message => message?.role === "assistant");
        if (!assistant || assistant.stopReason === "error") reason = "error";
        else if (assistant.stopReason === "aborted") reason = "cancelled";
      } catch { reason = "error"; }
    }`;

export function patchPiSettlement(source) {
  assert(source.split(SETTLE_BEFORE).length === 2, 'Unexpected upstream settlement implementation')
  return source.replace(SETTLE_BEFORE, () => SETTLE_AFTER)
}

/** Exact upstream error branch; no interpretation of model/provider text. */
export function patchPiPromptError(source) {
  assert(source.includes('RequestError as RequestError3'), 'Missing upstream structured error import')
  assert(source.split(BEFORE).length === 2, 'Unexpected upstream prompt implementation')
  return source.replace(BEFORE, () => AFTER)
}

export async function patchPiAcp(packageRoot) {
  const entry = join(packageRoot, 'dist/index.js')
  const meta = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert(meta.name === 'pi-acp' && meta.version === '0.0.34', 'Compatibility patch supports only pi-acp@0.0.34')
  const source = await readFile(entry, 'utf8')
  // Permit an idempotent run only when reversing our exact change recovers the published baseline.
  const original = source.replace(AFTER, () => BEFORE).replace(SETTLE_AFTER, () => SETTLE_BEFORE)
  assert(createHash('sha256').update(original).digest('hex') === ORIGINAL_SHA256, 'Unexpected pi-acp entry integrity')
  const patched = patchPiSettlement(patchPiPromptError(original))
  if (source === patched) return {version:meta.version, patched:true, changed:false}
  const temporary = `${entry}.nova-${randomUUID()}`
  const info = await stat(entry)
  try {
    await writeFile(temporary, patched, {mode:info.mode & 0o777})
    await chmod(temporary, info.mode & 0o777)
    await rename(temporary, entry)
  } finally {await rm(temporary, {force:true})}
  return {version:meta.version, patched:true, changed:true}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv[2], 'Usage: node patch-pi-acp.mjs ABSOLUTE_PI_ACP_PACKAGE_ROOT')
  console.log(JSON.stringify(await patchPiAcp(resolve(process.argv[2]))))
}
