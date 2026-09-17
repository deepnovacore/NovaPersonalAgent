import {createHash} from 'node:crypto'
import {constants as fsConstants, closeSync, fstatSync, openSync, readSync} from 'node:fs'

export interface FileSnapshot {
  readonly bytes: Buffer
  readonly device: bigint
  readonly inode: bigint
  readonly mode: bigint
  readonly size: number
  readonly sha256: string
}

export function snapshotRegularFile(path: string, maximumBytes: number): FileSnapshot {
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(descriptor, {bigint: true})
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximumBytes)) throw new Error()
    const size = Number(before.size)
    const bytes = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, offset)
      if (count === 0) throw new Error()
      offset += count
    }
    const after = fstatSync(descriptor, {bigint: true})
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) throw new Error()
    return Object.freeze({
      bytes,
      device: before.dev,
      inode: before.ino,
      mode: before.mode,
      size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  } finally {
    closeSync(descriptor)
  }
}

export function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.size === right.size
    && left.sha256 === right.sha256
}
