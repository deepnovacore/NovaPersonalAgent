import {
  closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, type BigIntStats,
} from 'node:fs'
import {join} from 'node:path'
import type {ProjectFileIdentity, ProjectRootFileAuthority, ProjectRootFileResult} from './project-root-file.js'

const identity = (info: BigIntStats): ProjectFileIdentity => ({device: info.dev, inode: info.ino})
const same = (info: BigIntStats, expected: ProjectFileIdentity): boolean =>
  info.dev === expected.device && info.ino === expected.inode

/** Node owns paths; descriptors only pin the identity of an already-open directory. */
export function createProjectNodeFiles(syncWindowsDirectory?: (fd: number) => ProjectRootFileResult): ProjectRootFileAuthority {
  const directories = new Map<number, {path: string; identity: ProjectFileIdentity}>()
  const inspect = (path: string): BigIntStats => {
    const info = lstatSync(path, {bigint: true})
    if (info.ino === 0n || info.isSymbolicLink() || realpathSync(path) !== path) throw new Error('project_path_changed')
    return info
  }
  const bindDirectory = (fd: number, path: string): void => {
    const info = inspect(path)
    if (!info.isDirectory() || !same(fstatSync(fd, {bigint: true}), identity(info))) {
      throw new Error('project_directory_changed')
    }
    directories.set(fd, {path, identity: identity(info)})
  }
  const directory = (fd: number): string => {
    const bound = directories.get(fd)
    if (!bound || !same(fstatSync(fd, {bigint: true}), bound.identity)
      || !same(inspect(bound.path), bound.identity)) throw new Error('project_directory_changed')
    return bound.path
  }
  const child = (fd: number, name: string): string => {
    if (!name || name === '.' || name === '..' || /[\\/\0:]/u.test(name)) {
      throw new Error('project_name_invalid')
    }
    return join(directory(fd), name)
  }
  const failure = (error: unknown): ProjectRootFileResult => ({
    status: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing'
      : (error as NodeJS.ErrnoException)?.code === 'EEXIST' ? 'exists' : 'failed',
  })
  const operation = (run: () => void): ProjectRootFileResult => {
    try { run(); return {status: 'ok'} } catch (error) { return failure(error) }
  }
  const matchesAt = (root: number, name: string, fd: number): ProjectRootFileResult => {
    try {
      const path = child(root, name)
      const info = inspect(path)
      if (!same(fstatSync(fd, {bigint: true}), identity(info))) return {status: 'mismatch'}
      if (info.isDirectory()) bindDirectory(fd, path)
      return {status: 'ok'}
    } catch (error) { return failure(error) }
  }
  const lookupAt: ProjectRootFileAuthority['lookupAt'] = (root, name) => {
    try { return {status: 'ok', identity: identity(inspect(child(root, name)))} }
    catch (error) { return {status: failure(error).status === 'missing' ? 'missing' : 'failed'} }
  }
  const create = (root: number, name: string, folder: boolean): ReturnType<ProjectRootFileAuthority['mkdirAt']> => {
    try {
      const path = child(root, name)
      if (folder) {
        mkdirSync(path, {mode: 0o700})
        return {status: 'ok', identity: identity(inspect(path))}
      }
      const fd = openSync(path, 'wx', 0o600)
      try {
        const created = identity(fstatSync(fd, {bigint: true}))
        if (!same(inspect(path), created)) return {status: 'failed'}
        return {status: 'ok', identity: created}
      } finally { closeSync(fd) }
    } catch (error) { return {status: failure(error).status === 'exists' ? 'exists' : 'failed'} }
  }
  const mkdirAt: ProjectRootFileAuthority['mkdirAt'] = (root, name) => create(root, name, true)
  const protectAt: NonNullable<ProjectRootFileAuthority['protectAt']> = (root, name, fd) => {
    const result = matchesAt(root, name, fd)
    if (result.status !== 'ok') return result
    return operation(() => {
      if (!fstatSync(fd).isDirectory()) throw new Error('project_directory_required')
      if (process.platform !== 'win32') fchmodSync(fd, 0o700)
    })
  }
  const remove = (root: number, name: string, expected: ProjectFileIdentity, kind: 'file' | 'directory' | 'tree'): ProjectRootFileResult => {
    try {
      const path = child(root, name)
      const info = inspect(path)
      if (!same(info, expected)) return {status: 'mismatch'}
      // ponytail: trusted single-user paths, no adversarial rename between stat and mutation.
      if (kind === 'tree') rmSync(path, {recursive: true})
      else if (kind === 'directory') rmdirSync(path)
      else unlinkSync(path)
      return {status: 'ok'}
    } catch (error) { return failure(error) }
  }
  return {
    bindDirectory,
    unbindDirectory: fd => { directories.delete(fd) },
    probe: fd => operation(() => { directory(fd) }),
    matchesAt, matchesWorkspaceAt: matchesAt, lookupAt, lookupWorkspaceAt: lookupAt,
    createFileAt: (root, name) => create(root, name, false),
    mkdirAt, mkdirPrivateAt: mkdirAt, protectAt,
    renameAt: (root, from, to) => operation(() => renameSync(child(root, from), child(root, to))),
    renameNoReplaceAt: (root, from, to, expected) => {
      try {
        const source = child(root, from)
        const target = child(root, to)
        if (!same(inspect(source), expected)) return {status: 'mismatch'}
        try { lstatSync(target); return {status: 'exists'} }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        renameSync(source, target)
        return {status: 'ok'}
      } catch (error) { return failure(error) }
    },
    syncDirectory: fd => {
      const checked = operation(() => { directory(fd) })
      if (checked.status !== 'ok') return checked
      if (syncWindowsDirectory) {
        try { return syncWindowsDirectory(fd) } catch (error) { return failure(error) }
      }
      return process.platform === 'win32' ? {status: 'failed'} : operation(() => fsyncSync(fd))
    },
    unlinkAt: (root, name, expected, kind) => remove(root, name, expected, kind),
    removeTreeAt: (root, name, expected) => remove(root, name, expected, 'tree'),
  }
}
