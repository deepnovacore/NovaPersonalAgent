import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ScheduleService} from '../src/personal-agent/scheduled-tasks.js'

test('persisted model accounting survives schedule startup, updates and restart', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'schedule-compat-'))
  const path = join(dir, 'schedules.json')
  const service = new ScheduleService(path)
  const recovered = new ScheduleService(path)
  const reopened = new ScheduleService(path)
  try {
    await service.open()
    const schedule = await service.ensureSourceProcessing('test')
    const run = await service.claimSourceProcessing(schedule.id, 'batch', 'recipe')
    await service.markFinished(run.run_id, {outcome: 'completed', text: 'done', evidence_refs: [], published: false})
    await service.close()
    const state = JSON.parse(await readFile(path, 'utf8')) as {runs: {processing: Record<string, unknown>}[]}
    Object.assign(state.runs[0]!.processing, {model_calls: 4, reserved_output_tokens: 29288})
    await writeFile(path, JSON.stringify(state))

    await recovered.open()
    assert.equal(recovered.terminalRuns().length, 1)
    await recovered.markPublished(run.run_id)
    await recovered.close()
    await reopened.open()
    assert.deepEqual(reopened.getRun(run.run_id).processing, {
      batch_id: 'batch', recipe: 'recipe', attempts: [], exhausted: false, calls: [],
      model_calls: 4, reserved_output_tokens: 29288,
    })
    assert.equal(reopened.getRun(run.run_id).terminal_summary?.published, true)

    // Known accounting metadata must not turn strict persistence into an open bag.
    for (const invalid of [{model_calls: -1}, {reserved_output_tokens: '29288'}, {unknown_field: true}]) {
      const malformed = structuredClone(state)
      Object.assign(malformed.runs[0]!.processing, invalid)
      await writeFile(path, JSON.stringify(malformed))
      const rejected = new ScheduleService(path)
      await assert.rejects(rejected.open(), {name: 'ZodError'})
      await rejected.close()
    }
  } finally {
    await Promise.all([service.close(), recovered.close(), reopened.close()])
    await rm(dir, {recursive: true, force: true})
  }
})

for (const origin of [undefined, 'non_product'] as const) test(`scheduled summary provenance is optional and bounded (${origin ?? 'legacy'})`, async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'schedule-origin-')), path = join(dir, 'schedules.json')
  const service = new ScheduleService(path), recovered = new ScheduleService(path)
  try {
    await service.open()
    const schedule = await service.ensureSourceProcessing('test'), run = await service.claimSourceProcessing(schedule.id, 'batch', 'recipe')
    await service.markFinished(run.run_id, {...(origin ? {memory_origin: origin} : {}), outcome: 'completed', text: 'done', evidence_refs: [], published: false})
    await service.close();await recovered.open()
    assert.equal(recovered.getRun(run.run_id).terminal_summary?.memory_origin, origin)
    await recovered.markPublished(run.run_id);await recovered.close()
    const state = JSON.parse(await readFile(path, 'utf8')) as {runs: {terminal_summary: {memory_origin?: unknown}}[]}
    for (const invalid of ['product', '', {}, ['non_product']]) {
      state.runs[0]!.terminal_summary.memory_origin = invalid
      await writeFile(path, JSON.stringify(state))
      const rejected = new ScheduleService(path)
      await assert.rejects(rejected.open(), {name: 'ZodError'});await rejected.close()
    }
  } finally {
    await Promise.all([service.close(), recovered.close()]);await rm(dir, {recursive: true, force: true})
  }
})

for(const origin of [undefined,'non_product'] as const)test(`withholding preserves provenance through retries, acknowledgement and restart (${origin??'legacy'})`,async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'schedule-withheld-')),path=join(dir,'schedules.json')
 const service=new ScheduleService(path),reopened=new ScheduleService(path)
 try{
  await service.open()
  const context={todos:true,goals:false,tasks:false,memory:false,knowledge:false,search:false}
  const input={title:'Review',goal:'Report',acceptance:['Report'],rule:{kind:'daily' as const,timezone:'UTC',time:'09:00'},context}
  const schedule=await service.create('create',input,{user_scope:'test',source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:context}),run=await service.runNow('run',schedule.id,1)
  const summary={...(origin?{memory_origin:origin}:{}),outcome:'completed' as const,text:'Private original report',evidence_refs:['private:evidence'],consumer:'producer',published:false}
  await service.markFinished(run.run_id,summary)
  await service.markFinished(run.run_id,summary)
  await service.markWithheld(run.run_id)
  const withheld=service.getRun(run.run_id).terminal_summary!
  assert.equal(withheld.memory_origin,origin)
  assert.equal(withheld.outcome,'failed');assert.equal(withheld.published,true)
  assert.deepEqual(withheld.evidence_refs,[]);assert.ok(!JSON.stringify(withheld).includes('Private original report'))
  await service.markWithheld(run.run_id);await service.markPublished(run.run_id)
  await service.update('edit',schedule.id,1,{...input,title:'Edited review'})
  assert.deepEqual(service.getRun(run.run_id).terminal_summary,withheld)
  await service.markFinished(run.run_id,withheld)
  await assert.rejects(service.markFinished(run.run_id,summary),/run_result_conflict/)
  await service.close();await reopened.open()
  assert.deepEqual(reopened.getRun(run.run_id).terminal_summary,withheld)
 }finally{await service.close();await reopened.close();await rm(dir,{recursive:true,force:true})}
})
