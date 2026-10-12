import type {ScheduledRunAuthority,ScheduledRunGrant} from './scheduled-run-authority.js'
/** Identity comes from session-owned host items and tool continuation receipts, never call JSON. */
export class ScheduledResponseScope{
 readonly #responses=new Map<string,string>()
 readonly #calls=new Map<string,string>()
 constructor(readonly authority:ScheduledRunAuthority,readonly grant:ScheduledRunGrant){authority.validate(grant)}
 bind(epoch:number,responseId:string,hostItems:readonly string[],callIds:readonly string[],pendingRoots:ReadonlySet<string>):string|null{
  this.authority.validate(this.grant)
  const key=epoch+':'+responseId,roots=hostItems.filter(id=>pendingRoots.has(id))
  const parents=callIds.map(id=>this.#calls.get(epoch+':'+id))
  const root=roots.length===1?roots[0]:callIds.length&&parents.every(parent=>parent!==undefined&&parent===parents[0])?parents[0]:undefined
  if(!root)return null
  if(this.#responses.size>=256&&!this.#responses.has(key))throw Error('scheduled_response_capacity')
  this.#responses.set(key,root);return root
 }
 acceptCall(epoch:number,responseId:string,callId:string,active:boolean):ScheduledRunGrant{
  this.authority.assert(this.grant,this.grant.fence)
  if(!active)throw Error('scheduled_response_stale')
  const root=this.#responses.get(epoch+':'+responseId);if(!root)throw Error('scheduled_response_unbound')
  const key=epoch+':'+callId
  if(this.#calls.size>=256&&!this.#calls.has(key))throw Error('scheduled_response_capacity')
  this.#calls.set(key,root);return this.grant
 }
}
