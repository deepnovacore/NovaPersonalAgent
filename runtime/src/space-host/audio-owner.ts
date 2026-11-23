/**
 * One Host-wide audio owner shared by the desktop renderer, the legacy LAN phone and Space
 * voice calls (docs/design/space-voice.md §4). Every claim gets a monotonically increasing
 * lease; release requires the lease, so a stale stop can never release a newer call.
 * Start, takeover, stop and cleanup are serialized through `serial`.
 */
export type AudioOwnerKind='desktop'|'lan_phone'|`space:${string}`;
export interface AudioOwnerLease {readonly owner:AudioOwnerKind;readonly lease:number}
/** Fences and tears down a Space call; resolves once its owner lease was released. */
export type AudioPreemption=(reason:'taken_over'|'replaced')=>Promise<void>;

export class AudioOwnerArbiter {
 #current:(AudioOwnerLease&{preempt?:AudioPreemption})|null=null;
 #next=0;#tail:Promise<unknown>=Promise.resolve();
 readonly #listeners=new Set<()=>void>();
 get current():AudioOwnerLease|null{return this.#current?{owner:this.#current.owner,lease:this.#current.lease}:null}
 /** The device of the Space call that owns audio, if any. */
 get spaceDevice():string|undefined{const owner=this.#current?.owner;return owner?.startsWith('space:')?owner.slice(6):undefined}
 owns(lease:number):boolean{return this.#current?.lease===lease}
 /** Synchronous claim; refuses with voice_active while another owner holds audio. Re-claiming one's own kind keeps the lease. */
 claim(owner:AudioOwnerKind,preempt?:AudioPreemption):number{
  if(this.#current){if(this.#current.owner===owner&&!owner.startsWith('space:'))return this.#current.lease;throw Error('voice_active')}
  this.#current={owner,lease:++this.#next,...(preempt?{preempt}:{})};this.#notify();return this.#current.lease;
 }
 release(lease:number):boolean{if(this.#current?.lease!==lease)return false;this.#current=null;this.#notify();return true}
 /** Local desktop always takes over a Space call (approved decision 4). Other owners are left alone. */
 async takeOver(reason:'taken_over'|'replaced'='taken_over'):Promise<void>{
  const current=this.#current;
  if(!current?.owner.startsWith('space:'))return;
  await current.preempt?.(reason);
  // A preemption that failed to release must not leave the desktop locked out.
  if(this.#current?.lease===current.lease){this.#current=null;this.#notify()}
 }
 serial<T>(work:()=>Promise<T>):Promise<T>{const run=this.#tail.then(work);this.#tail=run.catch(()=>{ /* keep the queue usable */ });return run}
 subscribe(listener:()=>void):()=>void{this.#listeners.add(listener);return()=>this.#listeners.delete(listener)}
 #notify(){for(const listener of this.#listeners){try{listener()}catch{ /* observers cannot break ownership */ }}}
}
