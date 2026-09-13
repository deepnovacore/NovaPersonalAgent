import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {resolve, dirname, join} from 'node:path'
import {tmpdir} from 'node:os'
import {parseArgs, parseEnv} from 'node:util'
import {spawn, execFileSync} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {configuration, runTextCase} from './live/text-tools.mjs'
import {validateFixtures, summary} from './live/validation.mjs'

const root = resolve(import.meta.dirname, '../..')
const catalog = JSON.parse(await readFile(join(import.meta.dirname, 'live/catalog.json'), 'utf8'))
const {values} = parseArgs({options: {
  list: {type:'boolean'}, target: {type:'string', default:'text-tools'}, case: {type:'string'},
  provider: {type:'string'}, model: {type:'string'}, repeat: {type:'string', default:'1'},
  'env-file': {type:'string'}, output: {type:'string'},
}})
if (values.list) {
  for (const suite of catalog.suites) console.log(`${suite.id}\t${suite.layer}\t${suite.retired ? 'RETIRED' : 'active'}\t${suite.scope}`)
} else {
  const repeats = Number(values.repeat)
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('repeat must be 1..10')
  const selected = values.target.split(',').map(id => {
    const suite = catalog.suites.find(suite => suite.id === id)
    if (!suite) throw new Error(`unknown suite: ${id}`)
    return suite
  })
  if (new Set(selected).size !== selected.length) throw new Error('duplicate suite')
  if (values.case && (selected.length !== 1 || selected[0].id !== 'text-tools')) throw new Error('--case requires text-tools only')
  if ((values.provider || values.model) && selected.some(suite => suite.id !== 'text-tools')) throw new Error('--provider/--model apply only to text-tools; configure other suites through environment')
  const environment = {...(values['env-file'] ? parseEnv(await readFile(values['env-file'], 'utf8')) : {}), ...process.env}
  const fixtureText = await readFile(join(root, 'fixtures/live/text-tools.json'), 'utf8')
  const fixtures = validateFixtures(JSON.parse(fixtureText))
  const cases = fixtures.cases.filter(entry => !values.case || entry.id === values.case)
  if (!cases.length) throw new Error('unknown or empty case selection')
  const output = resolve(values.output ?? join(tmpdir(), `nova-live-${randomUUID()}.json`))
  const git = (...args) => execFileSync('git', args, {cwd:root, encoding:'utf8'}).trim()
  const harnessHash = createHash('sha256')
  for (const file of ['../live-smoke.mjs','text-tools.mjs','validation.mjs','catalog.json']) harnessHash.update(await readFile(join(import.meta.dirname,'live',file)))
  const report = {version:1, harnessHash:harnessHash.digest('hex'), startedAt:new Date().toISOString(), revision:git('rev-parse','HEAD'),
    dirty:git('status','--porcelain').length > 0, node:process.version, platform:process.platform,
    selection:selected.map(suite => suite.id), repeats, fixtures:selected.some(suite => suite.id === 'text-tools') ? cases : [], fixtureHash:createHash('sha256').update(fixtureText).digest('hex'),
    scope:'Only selected suites/cases are accepted. Model-routing never executes tools. Legacy subprocess suites report process-level results.', results:[]}
  const persist = async () => {
    report.summary = summary(report.results)
    report.summary.accepted &&= report.finishedAt !== undefined
    report.caseSummary = [...new Set(report.results.map(result => `${result.suite}/${result.case}`))].map(id => ({
      id, ...summary(report.results.filter(result => `${result.suite}/${result.case}` === id)),
    }))
    await mkdir(dirname(output), {recursive:true})
    await writeFile(output, JSON.stringify(report,null,2)+'\n', {mode:0o600})
  }
  await persist()
  for (const suite of selected) {
    let config, configurationError
    if (suite.id === 'text-tools') {
      try { config = configuration(environment, values.provider, values.model) }
      catch { configurationError = 'invalid_provider_configuration' }
    }
    const missing = suite.requires.filter(group => !group.some(key => environment[key]?.trim())).map(group => group.join('|'))
    const blocked = suite.retired ? 'retired_suite' : configurationError
      ?? (suite.id === 'text-tools' && !config?.apiKey ? 'missing_selected_llm_key' : missing.length ? `missing:${missing.join(',')}` : null)
    for (let repeat = 1; repeat <= repeats; repeat++) {
      for (const entry of suite.id === 'text-tools' ? cases : [{id:suite.id}]) {
        const start = Date.now()
        let result
        if (blocked) result = {status:'blocked', reason:blocked}
        else {
          try {
            result = suite.id === 'text-tools'
              ? await runTextCase(entry, config, suite.timeoutMs)
              : await runProcess(suite, environment)
          } catch (error) {
            // Never persist transport messages, URLs, headers, env values, or child stdout.
            const code = ['network','http','timeout','aborted','configuration','protocol','overflow','closed'].includes(error.code) ? error.code : 'runner_error'
            result = {status: ['protocol','overflow'].includes(code) ? 'failed' : 'error', reason:code}
          }
        }
        report.results.push({suite:suite.id, layer:suite.layer, case:entry.id, repeat,
          ...(config ? {provider:config.provider, model:config.model} : {}), ...result, elapsedMs:Date.now()-start})
        console.log(`${suite.id}/${entry.id} #${repeat}: ${result.status}${result.failures?.length ? ` (${result.failures.join(', ')})` : ''}`)
        await persist()
      }
    }
  }
  report.finishedAt = new Date().toISOString()
  await persist()
  console.log(`Report: ${output}\n${JSON.stringify(report.summary)}`)
  process.exitCode = report.summary.failed ? 1 : report.summary.error || report.summary.blocked ? 2 : 0
}

function runProcess(suite, environment) {
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, [...(suite.id === 'coordinator' ? ['--test'] : []), suite.entry],
      {cwd:join(root,'runtime'), env:{...environment, NOVA_LIVE_TESTS:'1'}, stdio:['ignore','pipe','pipe']})
    let bytes = 0, timedOut = false, overflow = false
    const count = data => { bytes += data.length; if (bytes > 2_000_000) { overflow = true; child.kill('SIGKILL') } }
    child.stdout.on('data',count); child.stderr.on('data',count)
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, suite.timeoutMs)
    child.on('error', () => { clearTimeout(timer); resolveResult({status:'error', reason:'spawn_failed'}) })
    child.on('close', code => { clearTimeout(timer); resolveResult({status:timedOut || overflow ? 'error' : code === 0 ? 'passed' : 'failed',
      exitCode:code, ...(timedOut ? {reason:'timeout'} : overflow ? {reason:'output_limit'} : {})}) })
  })
}
