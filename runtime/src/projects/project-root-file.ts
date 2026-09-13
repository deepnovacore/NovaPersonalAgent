export interface ProjectFileIdentity {
  readonly device: bigint
  readonly inode: bigint
}

export type ProjectRootFileResult = Readonly<{
  status: 'ok' | 'mismatch' | 'exists' | 'missing' | 'unsupported' | 'failed'
}>

export type ProjectRootFileLookupResult =
  | Readonly<{status: 'ok'; identity: ProjectFileIdentity}>
  | Readonly<{status: 'missing' | 'unsupported' | 'failed'}>

export type ProjectRootFileCreateResult =
  | Readonly<{status: 'ok'; identity: ProjectFileIdentity}>
  | Readonly<{status: 'exists' | 'unsupported' | 'failed'}>

/** Host-only filesystem authority bound to retained directory identities. */
export interface ProjectRootFileAuthority {
  /** Bind a real retained descriptor to its already validated host path. */
  bindDirectory?(descriptor: number, path: string): void
  unbindDirectory?(descriptor: number): void
  probe(rootDescriptor: number): ProjectRootFileResult
  matchesAt(rootDescriptor: number, name: string, childDescriptor: number): ProjectRootFileResult
  /** Validate a retained managed workspace against its parent. */
  matchesWorkspaceAt?(
    rootDescriptor: number,
    name: string,
    childDescriptor: number,
  ): ProjectRootFileResult
  lookupAt(rootDescriptor: number, name: string): ProjectRootFileLookupResult
  /** Windows managed-workspace seam; state children continue to use strict lookupAt. */
  lookupWorkspaceAt?(rootDescriptor: number, name: string): ProjectRootFileLookupResult
  createFileAt(rootDescriptor: number, name: string, exclusive: boolean): ProjectRootFileCreateResult
  mkdirAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult
  /** Windows-only private create seam; callers fail closed when it is unavailable. */
  mkdirPrivateAt?(rootDescriptor: number, name: string): ProjectRootFileCreateResult
  /** Protect an already-retained exact child with platform permissions. */
  protectAt?(
    rootDescriptor: number,
    name: string,
    childDescriptor: number,
  ): ProjectRootFileResult
  renameAt(rootDescriptor: number, from: string, to: string): ProjectRootFileResult
  renameNoReplaceAt?(
    rootDescriptor: number,
    from: string,
    to: string,
    expected: ProjectFileIdentity,
  ): ProjectRootFileResult
  syncDirectory?(rootDescriptor: number): ProjectRootFileResult
  unlinkAt(
    rootDescriptor: number,
    name: string,
    expected: ProjectFileIdentity,
    kind: 'file' | 'directory',
  ): ProjectRootFileResult
  removeTreeAt(
    rootDescriptor: number,
    name: string,
    expected: ProjectFileIdentity,
  ): ProjectRootFileResult
}

/** Fail closed when the host filesystem authority is unavailable. */
export const unsupportedProjectRootFiles: ProjectRootFileAuthority = Object.freeze({
  probe: (): ProjectRootFileResult => ({status: 'unsupported'}),
  matchesAt: (): ProjectRootFileResult => ({status: 'unsupported'}),
  lookupAt: (): ProjectRootFileLookupResult => ({status: 'unsupported'}),
  createFileAt: (): ProjectRootFileCreateResult => ({status: 'unsupported'}),
  mkdirAt: (): ProjectRootFileCreateResult => ({status: 'unsupported'}),
  mkdirPrivateAt: (): ProjectRootFileCreateResult => ({status: 'unsupported'}),
  protectAt: (): ProjectRootFileResult => ({status: 'unsupported'}),
  renameAt: (): ProjectRootFileResult => ({status: 'unsupported'}),
  renameNoReplaceAt: (): ProjectRootFileResult => ({status: 'unsupported'}),
  syncDirectory: (): ProjectRootFileResult => ({status: 'unsupported'}),
  unlinkAt: (): ProjectRootFileResult => ({status: 'unsupported'}),
  removeTreeAt: (): ProjectRootFileResult => ({status: 'unsupported'}),
})
