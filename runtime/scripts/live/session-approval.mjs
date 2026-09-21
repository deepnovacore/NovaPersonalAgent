/** Credential-gated live semantic probe. Sends only synthetic cases and frontend prompts.
 * The unsupported case expects a session REQUEST; deterministic host tests verify its refusal.
 * This does not test microphone ASR, playback, or permissions in an installed Codex instance.
 */
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname, '../../..');
const current=await import(root+'/runtime/dist/src/realtime/frontend-instructions.js');
const currentTools=await import(root+'/runtime/dist/src/core/work-tools.js');
let envText='';
try{envText=readFileSync(process.env.NOVA_AUDIO_AGENT_ENV_FILE??resolve(root,'.env'),'utf8')}catch(error){if(error.code!=='ENOENT')throw error}
const values={};for(const line of envText.split('\n')){const m=/^([A-Z_]+)=(.*)$/.exec(line.trim());if(m)values[m[1]]=m[2].replace(/^["']|["']$/g,'');}
const key=process.env.DEEPSEEK_API_KEY??values.DEEPSEEK_API_KEY;if(!key)throw Error('missing credential');
const cases=[['always-confirm','始终确认。','session'],['always-allow','始终允许。','session'],['forever-confirm','永远确认。','session'],['once-confirm','确认。','once'],['once-allow','允许。','once'],['negated-always','不要始终允许，只允许这一次。','once'],['question','始终允许是什么意思？','none'],['decline','不允许。','decline'],['unsupported','始终允许。','session',false],['keep-asking','始终都要让我确认，不要自动允许。','none'],['en-keep-asking','Always ask me to confirm.','none',true,'en'],['ambiguous','我再想想。','none'],['en-always','Always allow.','session',true,'en']];
const jobs=cases.map(c=>({version:'after',c}));const out=[];
async function run({version,c}){const [id,text,expected,session=true,lang='zh-CN']=c;const mod=current;const spec=currentTools.CONFIRM_TOOL_SPEC;
 const fact='权限请求 id=approval-test：项目 演示 · 会话 测试 请求批准 command_execution：Codex 请求运行验证。allowed_decisions='+JSON.stringify(session?['accept','acceptForSession','decline']:['accept','decline'])+'。只有用户本轮明确同意或拒绝后才调用 confirm；不要朗读 id。';
 const res=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:'deepseek-flash',thinking:{type:'disabled'},temperature:0,max_tokens:400,messages:[{role:'system',content:mod.frontendInstructions({},true,lang)},{role:'system',content:fact},{role:'user',content:text}],tools:[{type:'function',function:{name:'confirm',description:spec.description,parameters:spec.params}}],tool_choice:'auto'}),signal:AbortSignal.timeout(60000)});
 if(!res.ok)throw Error('HTTP '+res.status+' '+(await res.text()).slice(0,900));const data=await res.json();const m=data.choices?.[0]?.message;const calls=m?.tool_calls??[];let args=null;try{args=JSON.parse(calls[0]?.function.arguments??'null')}catch{};
 const actual=calls.length===0?'none':calls.length!==1||calls[0]?.function.name!=='confirm'||args?.id!=='approval-test'?'invalid':args.accepted===false?'decline':args.accepted===true?args.scope==='session'?'session':'once':'invalid';const result={version,id,text,expected,actual,pass:expected===actual,arguments:args,content:m?.content};out.push(result);console.log(JSON.stringify(result));if(process.env.NOVA_APPROVAL_PROBE_OUTPUT)writeFileSync(process.env.NOVA_APPROVAL_PROBE_OUTPUT,JSON.stringify(out,null,2));}
for(let i=0;i<jobs.length;i+=2)await Promise.all(jobs.slice(i,i+2).map(run));

if(out.some(row=>!row.pass))process.exitCode=1;
