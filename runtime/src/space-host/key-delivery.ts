import {z} from 'zod';
import {BoundedJsonStore} from '../storage/bounded-json.js';
const schema=z.record(z.string(),z.object({envelope:z.record(z.string(),z.unknown()),sent:z.boolean()}));
/** Save randomized wrapping/signature before network send; retries never mint new deliveries. */
export class DurableKeyDelivery {
 readonly #store;#state:z.infer<typeof schema>={};#tail:Promise<unknown>=Promise.resolve();
 constructor(readonly options:{path:string;create:(epoch:number,device:string)=>Promise<Record<string,unknown>>;send:(value:Record<string,unknown>)=>Promise<void>}){this.#store=new BoundedJsonStore(options.path,schema,4*1024*1024)}
 async open(){try{this.#state=await this.#store.read({})}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}}
 deliver(epoch:number,device:string):Promise<void>{const run=this.#tail.then(async()=>{const key=JSON.stringify([epoch,device]);let entry=this.#state[key];if(entry?.sent)return;if(!entry){entry={envelope:await this.options.create(epoch,device),sent:false};this.#state[key]=entry;await this.#store.write(this.#state)}await this.options.send(entry.envelope);entry.sent=true;await this.#store.write(this.#state)});this.#tail=run.catch(()=>{ /* Keep the serial queue usable after a caller-visible failure. */ });return run}
}
