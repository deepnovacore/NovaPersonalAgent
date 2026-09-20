/* eslint-disable @typescript-eslint/require-await */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {assertAcceptable,evaluateCandidates,validateCandidate} from '../src/understanding/candidates.js'
import {understandingFixture} from '../src/understanding/fixture.js'
test('one source projects into multiple life facets; offsets and stale acceptance are deterministic',()=>{
 const rows=understandingFixture();assert.deepEqual(rows.map(r=>r.candidate.kind),['goal','todo','profile'])
 for(const r of rows)assertAcceptable(r,r.source)
 const row=rows[0]!
 assert.throws(()=>assertAcceptable(row,{...row.source,version:2}),/stale/)
 const {id,...raw}=row.candidate;assert.ok(id)
 assert.throws(()=>validateCandidate(row.source,{...raw,span:{...raw.span,quote:'fabricated'}}),/span/)
})
test('typed attribution and modality gate proposals; importance cannot grant authority',async()=>{
 const rows=understandingFixture(),source=rows[0]!.source
 const result=await evaluateCandidates(source,rows.map(r=>r.candidate),async()=>Object.fromEntries(rows.map(r=>[r.candidate.id,{...r.decision,importance:'critical',attribution:'other'}])),new AbortController().signal)
 assert.ok(result.every(r=>r.status==='withheld'))
 assert.throws(()=>assertAcceptable({...result[0]!,status:'proposed'},source),/withheld/)
 await assert.rejects(evaluateCandidates(source,rows.map(r=>r.candidate),async()=>({}),new AbortController().signal),/incomplete/)
})
test('correcting source text without version bump invalidates prior acceptance',()=>{
 const r=understandingFixture()[0]!
 assert.throws(()=>assertAcceptable(r,{...r.source,text:r.source.text+'更正：暂时不学了。'}),/stale/)
})
