import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createLocalMemoryGateway} from '../../dist/src/composition/realtime-assembly.js'
import {GatewayPersonalWriter} from '../../dist/src/model/personal-writer.js'
import {RealClock} from '../../dist/src/core/clock.js'
// Earlier stages are intentionally stubbed: the real production final verifier must
// reject injected errors while retaining supported facts. No personal data is used.
const directory=resolve(process.argv[2]);mkdirSync(directory,{recursive:true,mode:0o700})
const apiKey=process.env.DASHSCOPE_API_KEY;assert(apiKey)
const actual=createLocalMemoryGateway({baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',apiKey,clock:new RealClock(),requestTimeout:120,metrics:{record(){}}})
const entries=[{id:'one',version:1,origin:'stated',content:'我是林舟，正在开发个人开源读书笔记工具 PaperNest。这周由我负责离线检索，已经完成分页接口；向量检索还只是计划。'},{id:'two',version:1,origin:'stated',content:'我做 PaperNest 时希望保留笔记原文引用，协作前先写清输入输出和验收条件。'},{id:'three',version:1,origin:'stated',content:'今天我完成了 PaperNest 关键词检索回归测试，断点恢复仍待验证。'}]
entries.push({id:'four',version:1,origin:'stated',content:'PaperNest 发布前先跑回归测试，这是我约定的发布流程。'},{id:'five',version:1,origin:'stated',content:'我目前尚未与任何人建立协作关系。'})
const narrative={about:{paragraphs:[{text:'你是林舟，正在独立开发个人开源读书笔记工具 PaperNest。你负责 PaperNest 的离线检索，已完成分页接口；向量检索还只是计划。',refs:['e0']},{text:'你反复强调写清验收条件。尚未建立协作关系。',refs:['e1']}]},work:[{title:'PaperNest',text:'关键词检索回归测试已完成，断点恢复仍待验证。',refs:['e2']},{title:'已上线的 PaperNest',text:'关键词检索回归测试已完成。',refs:['e2']}],interests:[]}
narrative.about.paragraphs.push({text:'PaperNest 尚未发布。',refs:['e3']},{text:'目前尚未与任何人建立协作关系。',refs:['e4']})
let verdict,calls=0
const gateway={complete:async r=>{if(r.system.includes('画像发布逐句核验')){calls++;const reply=await actual.complete(r);verdict=JSON.parse(reply.text);return reply}if(r.system.includes('逐条判定画像材料'))return {text:JSON.stringify({sources:entries.map((_,i)=>({id:'e'+i,relevance:'ongoing_work'}))})};if(r.system.includes('独立审查整份画像'))return {text:'{"review_notes":[]}'};if(r.system.includes('统一修订整份画像'))return {text:JSON.stringify({profile:narrative,review_notes:[]})};return {text:JSON.stringify(narrative)}}}
const result=await new GatewayPersonalWriter({gateway,model:'qwen3-vl-plus'}).generateProfile(entries,new AbortController().signal,[{kind:'work',text:'Project facts',refs:entries.map(e=>({entry_id:e.id,version:1}))}])
const report={scope:'Real final verifier on injected flawed synthetic draft; earlier writing stages stubbed',calls,verdict,result,status:'pending'}
try{const text=JSON.stringify(result);assert.doesNotMatch(text,/独立开发|反复强调|尚未建立协作关系。|尚未发布|已上线/);assert.match(text,/分页接口/);assert.match(text,/关键词/);assert.match(text,/恢复/);assert.match(text,/目前尚未与任何人建立协作关系/);report.status='passed'}catch(error){report.status='failed';report.error=error.message;process.exitCode=1}
writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report))
