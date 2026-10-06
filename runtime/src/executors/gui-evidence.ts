/** Ephemeral screenshots. Never put pixels in task JSON, logs, or executor handoffs. */
import {randomUUID} from 'node:crypto'
import type {GatewayImage} from '../model/model-gateway.js'
const frames = new Map<string, {work: string; session: string; target: string; expires: number; image: GatewayImage}>()
export function rememberGuiFrame(pixels: string, binding: {work: string; session: string; target: string}): string {
  const match = /^data:image\/(png|jpeg);base64,/u.exec(pixels)
  if (!match || pixels.length > 20_000_000) throw Error('invalid_gui_frame')
  const payload = Buffer.from(pixels.slice(match[0].length), 'base64')
  if (match[1] === 'png' ? payload.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' : payload.subarray(0, 3).toString('hex') !== 'ffd8ff') throw Error('invalid_gui_frame')
  const ref = `gui-frame:${randomUUID()}`
  for (const [key, entry] of frames) if (entry.expires < Date.now()) frames.delete(key)
  // ponytail: first 4 + last 4 frames per work, 16 total, 15 minutes in RAM; durable opt-in for longer histories.
  const sameWork = [...frames.entries()].filter(([, entry]) => entry.work === binding.work)
  if (sameWork.length >= 8) frames.delete(sameWork[4]![0])
  while (frames.size >= 16) frames.delete(frames.keys().next().value!)
  frames.set(ref, {...binding, expires: Date.now() + 15 * 60_000, image: {ref, media_type: match[1] === 'png' ? 'image/png' : 'image/jpeg', payload}})
  return ref
}
export function resolveGuiFrame(ref: string, binding: {work: string; session: string; target: string}): GatewayImage | undefined {
  const frame = frames.get(ref)
  if (!frame || frame.expires < Date.now() || frame.work !== binding.work || frame.session !== binding.session || frame.target !== binding.target) return undefined
  return frame.image
}
