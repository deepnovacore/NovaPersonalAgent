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
      batch_id: 'batch', recipe: 'recipe', exhausted: false, calls: [],
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
