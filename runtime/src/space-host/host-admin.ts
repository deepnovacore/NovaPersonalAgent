import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {BoundedJsonStore} from '../storage/bounded-json.js';
import {environmentContract} from '../config/environment-contract.js';
import type {PersonalAgentHost} from '../personal-agent/host.js';
/** Phone-editable, non-secret Host settings. Each entry reuses the Host's own command handler and validation; build, plan, local-approval and notification-binding commands stay desktop-only. */
export const SPACE_SETTINGS_METHODS=['identity.configure','soul.set','discovery.configure','news.configure'] as const;
export const settingsPatchSchema=z.object({method:z.enum(SPACE_SETTINGS_METHODS),params:z.record(z.string(),z.unknown())}).strict();
/** Secret environment variables a phone may store: provider API keys only; host-private, token and file variables never travel over Space. */
export const SPACE_SECRET_NAMES:readonly string[]=Object.freeze(environmentContract.filter(entry=>entry.secret&&entry.owner!=='host_private'&&!/TOKEN|_FILE$/u.test(entry.name)).map(entry=>entry.name).filter((name,index,all)=>all.indexOf(name)===index).sort());
const secretName=z.string().refine(name=>SPACE_SECRET_NAMES.includes(name),'secret_not_allowed');
export const secretPutSchema=z.object({name:secretName,value:z.string().min(1).max(4096).refine(value=>!/[\0\r\n]/u.test(value),'invalid_secret')}).strict();
export const secretClearSchema=z.object({name:secretName}).strict();
const feishuActions={'app.start':'feishu.app.start','app.status':'feishu.app.status','app.cancel':'feishu.app.cancel',login:'feishu.login',complete:'feishu.complete',logout:'feishu.disconnect',status:'feishu.status'} as const;
export const connectorFeishuSchema=z.object({action:z.enum(Object.keys(feishuActions) as [keyof typeof feishuActions,...(keyof typeof feishuActions)[]])}).strict();
export const feishuMethod=(action:keyof typeof feishuActions)=>feishuActions[action];
export const secretFingerprint=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,8);
const fileSchema=z.object({v:z.literal(1),secrets:z.record(z.string(),z.string())});
type SecretFile=z.infer<typeof fileSchema>;
/** Credentials a Space owner sent from a phone. Operator environment always wins; changes apply on the next Host start. A damaged file is dropped rather than blocking startup, and the owner projection asks the phone to enter the keys again. */
export class HostSecretStore {
 readonly #store;#state:SecretFile={v:1,secrets:{}};#tail:Promise<unknown>=Promise.resolve();#damaged=false;
 constructor(readonly path:string){this.#store=new BoundedJsonStore(path,fileSchema,1024*1024)}
 get damaged(){return this.#damaged}
 async open(){try{this.#state=await this.#store.read(this.#state)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;this.#damaged=true}}
 #serial<T>(work:()=>Promise<T>):Promise<T>{const run=this.#tail.then(work);this.#tail=run.catch(()=>{ /* Keep the serial queue usable after a caller-visible failure. */ });return run}
 put(name:string,value:string){return this.#serial(async()=>{const next={v:1 as const,secrets:{...this.#state.secrets,[name]:value}};await this.#store.write(next);this.#state=next;this.#damaged=false})}
 clear(name:string){return this.#serial(async()=>{const {[name]:_removed,...rest}=this.#state.secrets;const next={v:1 as const,secrets:rest};await this.#store.write(next);this.#state=next;this.#damaged=false})}
 value(name:string):string|undefined{return this.#state.secrets[name]}
}
export const spaceSecretsPath=(configPath:string)=>configPath+'.secrets.json';
/** Synchronous startup overlay: stored Space credentials fill only variables the operator left unset. A damaged file is ignored, keeps its bytes for the operator and never blocks the Host. */
export function overlaySpaceSecrets(environment:NodeJS.ProcessEnv,configPath:string|undefined,onDiagnostic?:(code:string)=>void):NodeJS.ProcessEnv{
 if(!configPath)return environment;
 let text:string;try{text=readFileSync(spaceSecretsPath(configPath),'utf8')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return environment;throw error}
 // BoundedJsonStore leaves an empty private file until the first write.
 if(!text)return environment;let parsed:z.infer<typeof fileSchema>;
 try{parsed=fileSchema.parse(JSON.parse(text))}catch{onDiagnostic?.('space_secrets_invalid_dropped');return environment}
 const next={...environment};for(const [name,value]of Object.entries(parsed.secrets))if(SPACE_SECRET_NAMES.includes(name)&&!environment[name]?.trim())next[name]=value;return next;
}
/** Never projects values. `damaged` tells the phone that a stored file was ignored, so it can prompt for the keys again. */
export function credentialsView(store:HostSecretStore|undefined,environment:NodeJS.ProcessEnv){
 return {damaged:store?.damaged===true,credentials:SPACE_SECRET_NAMES.map(name=>{const operator=environment[name]?.trim()?environment[name]:undefined,stored=store?.value(name),value=operator??stored;return {name,configured:value!==undefined,source:operator!==undefined?'environment' as const:stored!==undefined?'space' as const:null,...(value!==undefined?{fingerprint:secretFingerprint(value)}:{})}})};
}
export function settingsView(host:PersonalAgentHost){
 const state=host.snapshot(),s=state.settings,soul=state.soul,news=state.news;
 const pick=['discovery_enabled','discovery_interval_minutes','timezone','briefing_outlook_enabled','briefing_review_enabled','briefing_outlook_time','briefing_review_time','briefing_weekdays','quiet_start','quiet_end','proactive_daily_cap','news_rank_fallback','diary_enabled'] as const;
 return {identity:host.identity(),soul:{available:soul.available,role:soul.role,version:soul.version},discovery:Object.fromEntries(pick.filter(key=>(s as Record<string,unknown>)[key]!==undefined).map(key=>[key,(s as Record<string,unknown>)[key]])),news:{enabled:news.enabled,explore:news.explore,interests:news.interests.map(row=>row.text),profile_version:news.profile_version}};
}
function safeUrl(value:unknown,setup:boolean):string|undefined{
 if(typeof value!=='string'||value.length>4096)return undefined;
 try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password)return undefined;
  if(setup)return url.origin==='https://open.feishu.cn'&&url.pathname==='/page/cli'?url.href:undefined;
  return ['feishu.cn','larksuite.com'].some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain))?url.href:undefined;
 }catch{return undefined}
}
/** Connection state only: no tokens, account or tenant identifiers, chats, or app secrets. */
export function feishuView(raw:unknown){
 const view=(typeof raw==='object'&&raw!==null?raw:{}) as Record<string,unknown>,setup=(typeof view.app_setup==='object'&&view.app_setup!==null?view.app_setup:undefined) as Record<string,unknown>|undefined;
 const login=safeUrl(view.verification_url,false),setupUrl=safeUrl(setup?.verification_url,true);
 // beginLogin pauses the connector, and logout keeps the account id: only the connector's signed_in flag means signed in.
 return {available:view.available===true,configured:view.configured===true,connected:!login&&view.signed_in===true&&view.auth_issue===undefined,...(login?{login_pending:true}:{}),state:typeof view.state==='string'?view.state:'unauthorized',...(typeof view.auth_issue==='string'?{auth_issue:view.auth_issue}:{}),
  ...(setup&&typeof setup.state==='string'?{app_setup:{state:setup.state,...(setupUrl?{verification_url:setupUrl}:{}),...(typeof setup.error==='string'?{error:setup.error.slice(0,200)}:{})}}:{}),...(login?{verification_url:login}:{})};
}
