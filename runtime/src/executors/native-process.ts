/** Shared process supervision entry point; local tools do not depend on an executor adapter. */
export {
  PosixCodexProcessOwnerFactory,
  takeUnconfirmedCodexProcessOwner,
  type CodexProcessOwnerFactory,
  type OwnedCodexProcess,
} from './codex/process-owner.js'
export {loadWindowsGuardianFactoryFromResources} from './codex/windows-guardian.js'
