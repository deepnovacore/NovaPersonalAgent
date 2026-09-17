import {relative,isAbsolute} from 'node:path'
export function validateProjectResult(result) {
  const child = typeof result.managedRoot==='string' && typeof result.workspacePath==='string' ? relative(result.managedRoot,result.workspacePath) : ''
  return [
    ...(result.approvalRequired ? ['unexpected_approval_prompt'] : []),
    ...(!result.expectedName || result.proposalName!==result.expectedName || result.workspaceName!==result.expectedName ? ['workspace_identity'] : []),
    ...(!child || child==='..' || child.startsWith('../') || isAbsolute(child) ? ['workspace_outside_test_root'] : []),
    ...(!result.proposalId || result.confirmedId !== result.proposalId ? ['confirmation_identity'] : []),
    ...(result.replacedProposal ? ['proposal_replaced_by_confirmation'] : []),
    ...(result.outcome !== 'ok' || result.code !== 'completed' ? ['executor_not_completed'] : []),
    ...(!Array.isArray(result.followups)||result.followups.length!==2||result.followups.some((item,index)=>item.session!==['latest','new'][index]||item.outcome!=='ok'||item.sessionMatches!==true||item.file!==['CONTINUE_OK','NEW_SESSION_OK'][index]) ? ['followup_not_completed'] : []),
    ...(result.file?.trim() !== 'NOVA_E2E_OK' ? ['artifact_mismatch'] : []),
  ]
}
