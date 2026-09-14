import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import {validateProjectResult} from './project-result.mjs'

test('project acceptance requires matching proposal, terminal success and actual artifact', () => {
  const good = {expectedName:'test',proposalName:'test',workspaceName:'test',managedRoot:'/tmp/live/workspaces',workspacePath:'/tmp/live/workspaces/test-123',proposalId:'p1',confirmedId:'p1',replacedProposal:false,outcome:'ok',code:'completed',file:'NOVA_E2E_OK\n'}
  assert.deepEqual(validateProjectResult(good),[])
  for(const patch of [{approvalRequired:true},{proposalName:'other'},{workspaceName:'other'},{workspacePath:'/tmp/live/workspaces-sibling/x'},{workspacePath:'/tmp/elsewhere'},{confirmedId:'p2'},{replacedProposal:true},{outcome:'failed'},{code:'transport_lost'},{file:null},{file:'wrong'}]) {
    assert.ok(validateProjectResult({...good,...patch}).length>0)
  }
})

test('project live suite is explicit and requires execution consent', () => {
  const catalog=JSON.parse(readFileSync(new URL('./catalog.json',import.meta.url)))
  const suite=catalog.suites.find(s=>s.id==='project')
  assert.ok(suite)
  assert.ok(suite.requires.some(group=>group.includes('NOVA_LIVE_PROJECT_EXECUTE')))
})
