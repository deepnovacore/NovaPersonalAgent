import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {loadGroundedVoiceMem} from '../src/memory/grounded-voicemem.js'
import {providerFixture} from './memory-engine-provider-fixture.js'

const original='我一贯更喜欢简洁直接的回答，这是一项长期沟通偏好。'
const canonical=['Prefers brief replies','Prefers direct replies']

test('voicemem grounded SDK: unchanged positive, snapshots, independent retries and dimension conflicts',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sdk-grounded-')),provider=await providerFixture()
  const {VoiceMem,OpenAITextModel,OpenAIEmbeddingModel}=await loadGroundedVoiceMem()
  const create=()=>new VoiceMem({path:join(root,'sdk.sqlite'),userId:'owner',mode:'text',model:new OpenAITextModel({baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture'}),embeddings:new OpenAIEmbeddingModel({baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dimensions:2}),rbMinScore:0,leftMinScore:0})
  let sdk=create()
  const ingest=async(id:string,text=original)=>{await sdk.ingest(text,{sourceId:id,sessionId:'one-session',scope:'styles',role:'user'})}
  const styles=async()=> (await sdk.search('answers',{scope:'styles',recordUsage:false})).rbHits.filter(hit=>hit.kind==='trait')
  try{
    provider.setVoiceOutput({memory:[],emotion:'',traits:[{slot:'表达风格',label:'Likes conclusion first; is a scientist',reply_preference:true,dimension:'answer_order',value:'conclusion_first'}]})
    for(let n=1;n<=3;n++){
      await ingest('source-'+n)
      assert.deepEqual((await styles()).map(hit=>hit.text).sort(),n<3?[]:canonical,'exact original is not rewritten to pass')
    }
    await ingest('source-3');await sdk.resumeIngest('source-3',{scope:'styles'})
    assert.ok((await styles()).every(hit=>hit.evidenceIds.length===3),'same-source retries add zero support')
    const snapshots=sdk.store.db.prepare('SELECT snapshot FROM vm_evidence').all()
    assert.equal(snapshots.length,6)
    for(const raw of snapshots){
      const snapshot=JSON.parse(String(raw.snapshot)) as {record:{replyPreference:{protocol:string;dimension:string;value:string;support:{text:string;start:number;end:number}}}}
      assert.equal(snapshot.record.replyPreference.support.text,original)
      assert.equal(snapshot.record.replyPreference.support.start,0)
      assert.equal(snapshot.record.replyPreference.support.end,original.length)
      assert.ok(['length','directness'].includes(snapshot.record.replyPreference.dimension),'no invented ordering/identity dimensions')
    }
    await ingest('different-wording','I consistently prefer brief and direct replies')
    assert.ok((await styles()).every(hit=>hit.evidenceIds.length===4),'generic grounded equivalents attach by canonical keys')
    await ingest('opposite','我一直偏好详细的回复。')
    assert.deepEqual((await styles()).map(hit=>hit.text),['Prefers direct replies'],'one opposite source suppresses length before three-source floor')
    const traits=sdk.store.list('owner','styles',false,{kind:'trait'})
    assert.equal(traits.find(item=>item.record.text==='Prefers brief replies')!.record.evidenceIds.length,4,'contrary claim never strengthens original')
    await sdk.forget({sourceId:'opposite',scope:'styles'})
    assert.deepEqual((await styles()).map(hit=>hit.text).sort(),canonical)
    await ingest('denial','I do not prefer concise answers')
    assert.deepEqual((await styles()).map(hit=>hit.text),['Prefers direct replies'],'explicit denial blocks the dimension but is never exposed as a standing preference')
    await sdk.forget({sourceId:'denial',scope:'styles'})
    await sdk.close();sdk=create()
    assert.deepEqual((await styles()).map(hit=>hit.text).sort(),canonical,'supported snapshots survive restart')
    for(const id of ['source-1','source-2'])await sdk.forget({sourceId:id,scope:'styles'})
    assert.deepEqual(await styles(),[],'forget below three withdraws hints')
    await sdk.close();sdk=create();assert.deepEqual(await styles(),[],'restart never resurrects forgotten support')
    assert.ok(provider.counts().extractions>0&&provider.counts().embeddings>0,'real SDK HTTP providers ran')
  }finally{await sdk.close();await provider.close();await rm(root,{recursive:true,force:true})}
})

test('voicemem grounded SDK: repeated negative controls and malformed/unsupported model claims fail closed',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sdk-controls-')),provider=await providerFixture()
  const {VoiceMem,OpenAITextModel,OpenAIEmbeddingModel}=await loadGroundedVoiceMem()
  const sdk=new VoiceMem({path:join(root,'sdk.sqlite'),userId:'owner',mode:'text',model:new OpenAITextModel({baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture'}),embeddings:new OpenAIEmbeddingModel({baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dimensions:2}),rbMinScore:0,leftMinScore:0})
  const controls=[
    'Please answer briefly just this turn','这次请简洁直接地回答。','I am upset today',
    'I always prefer concise books','我一贯更喜欢简洁的家具。',
    'My colleague always prefers concise answers','他说他一直偏好简短的回复。',
    'The assistant said: I always prefer concise answers','“我一直喜欢简洁的回答。”',
    'I do not always prefer concise answers','我并不是一贯更喜欢简洁直接的回答。',
    'I might always prefer concise answers','I always prefer concise and detailed answers',
    'I always prefer conclusion first answers','I always prefer concise answers, said my colleague',
    '我一贯更喜欢简洁直接的回答，但仅限今天。',
  ]
  try{
    const outputs=[{slot:'表达风格',label:'Prefers concise answers',reply_preference:true},{slot:'表达风格',label:'Prefers conclusion first',reply_preference:true,replyPreference:{protocol:'v1',dimension:'length',value:'brief',quote:original}},null,{},'malformed',{reply_preference:true,dimension:'identity',value:'scientist'}]
    for(let index=0;index<controls.length;index++)for(let n=0;n<3;n++){
      provider.setVoiceOutput({memory:[],emotion:controls[index]!.includes('upset')?'sad':'',traits:outputs})
      await sdk.ingest(controls[index]!,{sourceId:`control-${index}-${n}`,sessionId:'controls',scope:'styles',role:'user'})
    }
    for(const role of ['assistant','system'] as const)for(let n=0;n<3;n++)await sdk.ingest(original,{sourceId:`${role}-${n}`,sessionId:'controls',scope:'styles',role})
    assert.equal(sdk.store.list('owner','styles',false,{kind:'trait'}).length,0,'labels, matching quote and model flag cannot establish entailment')
    const result=await sdk.search('answers',{scope:'styles',recordUsage:false})
    assert.ok(!result.rbHits.some(hit=>hit.kind==='trait'))
    assert.ok(result.rbHits.some(hit=>hit.kind==='heartnote'),'temporary emotion still uses SDK APIs')
    provider.setVoiceOutput({traits:[{dimension:'length',value:'brief'}]})
    await assert.rejects(sdk.ingest(original,{sourceId:'invalid-json-contract',scope:'styles'}),/missing "memory"/u)
    assert.ok(!(await sdk.search('answers',{scope:'styles',recordUsage:false})).rbHits.some(hit=>hit.kind==='trait'),'malformed extraction cannot commit a claim')
  }finally{await sdk.close();await provider.close();await rm(root,{recursive:true,force:true})}
})
