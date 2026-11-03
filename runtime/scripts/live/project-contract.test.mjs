import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import {join, resolve} from 'node:path'
import vm from 'node:vm'
import {validateProjectResult} from './project-result.mjs'

test('project acceptance requires matching proposal, terminal success and actual artifact', () => {
  const good = {followups:[{session:'latest',sessionMatches:true,outcome:'ok',file:'CONTINUE_OK'},{session:'new',sessionMatches:true,outcome:'ok',file:'NEW_SESSION_OK'}],expectedName:'test',proposalName:'test',workspaceName:'test',managedRoot:'/tmp/live/workspaces',workspacePath:'/tmp/live/workspaces/test-123',proposalId:'p1',confirmedId:'p1',replacedProposal:false,outcome:'ok',code:'completed',file:'NOVA_E2E_OK\n'}
  assert.deepEqual(validateProjectResult(good),[])
  for(const patch of [{followups:[]},{followups:[{session:'latest',outcome:'refused',file:null}]},{approvalRequired:true},{proposalName:'other'},{workspaceName:'other'},{workspacePath:'/tmp/live/workspaces-sibling/x'},{workspacePath:'/tmp/elsewhere'},{confirmedId:'p2'},{replacedProposal:true},{outcome:'failed'},{code:'transport_lost'},{file:null},{file:'wrong'}]) {
    assert.ok(validateProjectResult({...good,...patch}).length>0)
  }
})

test('coding project fixture isolates memory selection from polluted parent environment', () => {
  const source = readFileSync(new URL('./coding-project.mjs', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('const environment='), source.indexOf('const command='))
  const polluted = {MEMORY_PROVIDER: 'mem0', MEMORY_RECALL_ENGINE: 'unsupported', MEMORY_EXTRACTORS: 'broken',
    MEMORY_BACKEND: 'remote', MEMORY_CONNECTION: 'remote', MEMORY_PATH: '/unowned/memory.sqlite', MEMORY_LEDGER_PATH: '/unowned/ledger.sqlite'}
  const evaluate = env => vm.runInNewContext(`${body}; environment`, {
    process: {env}, directory: '/fixture', join, resolve, resolveCodexBin: () => '/fixture/codex',
  })
  const clean = evaluate({}), isolated = evaluate(polluted)
  for (const name of ['MEMORY_PROVIDER', 'MEMORY_RECALL_ENGINE', 'MEMORY_EXTRACTORS', 'MEMORY_BACKEND']) {
    assert.equal(Object.hasOwn(isolated, name), false)
    assert.equal(Object.hasOwn(polluted, name), true, 'parent environment is not mutated')
  }
  for (const name of ['MEMORY_CONNECTION', 'MEMORY_PATH', 'MEMORY_LEDGER_PATH']) assert.equal(isolated[name], clean[name])
  assert.equal(isolated.MEMORY_CONNECTION, 'disabled')
})

test('project live suite is explicit and requires execution consent', () => {
  const catalog=JSON.parse(readFileSync(new URL('./catalog.json',import.meta.url)))
  const suite=catalog.suites.find(s=>s.id==='project')
  assert.ok(suite)
  assert.ok(suite.requires.some(group=>group.includes('NOVA_LIVE_PROJECT_EXECUTE')))
})
