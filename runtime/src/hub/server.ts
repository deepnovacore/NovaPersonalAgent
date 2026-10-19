import {createServer} from 'node:http'
import {z,ZodError} from 'zod'
import {spaceId} from '../device/space-authority.js'
import type {HubStore} from './store.js'
import {pairingHandler} from './pairing-http.js'

export function createHubServer(store:HubStore){
 const redeem=pairingHandler(store)
 return createServer((req,res)=>{void (async()=>{
  if(req.method==='POST'&&req.url==='/hub/v1/pairing/redeem'){await redeem(req,res);return}
  const reply=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value))}
  const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization??'')?.[1]
  try{
   if(!token)throw Error('unauthorized')
   store.snapshot(token)
   const url=new URL(req.url??'','http://hub.local')
   if(req.method==='GET'&&url.pathname==='/hub/v1/state'){reply(200,store.snapshot(token));return}
   if(req.method==='GET'&&url.pathname==='/hub/v1/identity'){reply(200,store.identity(token));return}
   if(req.method==='GET'&&url.pathname==='/hub/v1/changes'){reply(200,store.changes(token,Number(url.searchParams.get('after')??0)));return}
   if(req.method==='GET'&&url.pathname==='/hub/v1/devices'){reply(200,store.routing.devices(token));return}
   if(req.method==='GET'&&url.pathname==='/hub/v1/commands'){reply(200,store.routing.inbox(token));return}
   if(req.method==='GET'&&url.pathname==='/hub/v1/tasks'){reply(200,store.routing.tasks(token));return}
   if(req.method==='GET'&&url.pathname==='/hub/v1/authority'){reply(200,store.authority.snapshot(token));return}
   if(req.method==='GET'&&url.pathname==='/hub/v1/authority/members'){reply(200,store.authority.members(token));return}
   if(req.method==='GET'&&url.pathname==='/hub/v1/context'){reply(200,store.context.snapshot(token));return}
   if(req.method==='GET'&&url.pathname==='/hub/v1/schedule-owners'){reply(200,store.scheduleOwnership.list(token));return}
   if(req.method==='GET'&&url.pathname==='/hub/v1/context/changes'){reply(200,store.context.pull(token,Number(url.searchParams.get('after')??0)));return}
   if(req.method==='GET'&&url.pathname==='/hub/v1/context/deletions'){reply(200,store.context.deletionStatus(token));return}
   const transition=(value:unknown)=>z.object({transition_id:spaceId}).strict().parse(value).transition_id
   const routes:Record<string,(value:unknown)=>unknown>={
    '/hub/v1/schedule-owners/register':value=>store.scheduleOwnership.register(token,value),
    '/hub/v1/schedule-owners/claim':value=>store.scheduleOwnership.claim(token,value),
    '/hub/v1/schedule-owners/checkpoint':value=>store.scheduleOwnership.checkpoint(token,value),
    '/hub/v1/schedule-owners/handoff':value=>store.scheduleOwnership.handoff(token,value),
    '/hub/v1/schedule-owners/control':value=>store.scheduleOwnership.control(token,value),
    '/hub/v1/authority/initialize':value=>{z.object({}).strict().parse(value);return store.authority.initialize(token)},
    '/hub/v1/context/events':value=>store.context.append(token,value),
    '/hub/v1/context/delete':value=>store.context.deleteSource(token,value),
    '/hub/v1/context/discard':value=>store.context.discard(token,value),
    '/hub/v1/context/publish':value=>store.context.publish(token,value),
    '/hub/v1/context/ack':value=>store.context.acknowledge(token,z.object({cursor:z.number().int().nonnegative()}).strict().parse(value).cursor),
    '/hub/v1/authority/prepare':value=>store.authority.prepare(token,value),
    '/hub/v1/authority/ack':value=>store.authority.acknowledge(token,transition(value)),
    '/hub/v1/authority/commit':value=>store.authority.commit(token,transition(value)),
    '/hub/v1/authority/cancel':value=>store.authority.cancel(token,transition(value)),
    '/hub/v1/mutations':value=>store.mutate(token,value),
    '/hub/v1/devices/heartbeat':value=>store.routing.heartbeat(token,value),
    '/hub/v1/commands':value=>store.routing.submit(token,value),
    '/hub/v1/commands/ack':value=>store.routing.ack(token,value),
    '/hub/v1/tasks/events':value=>store.routing.publish(token,value),
   }
   const route=routes[url.pathname]
   if(req.method!=='POST'||!route){reply(404,{error:'not_found'});return}
   if(!req.headers['content-type']?.startsWith('application/json')){reply(415,{error:'json_required'});return}
   const chunks:Buffer[]=[];let bytes=0
   for await(const value of req){const chunk:unknown=value;if(!(chunk instanceof Buffer))throw Error('invalid_chunk');bytes+=chunk.length;if(bytes>64*1024){reply(413,{error:'payload_too_large'});return}chunks.push(chunk)}
   reply(200,route(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
  }catch(error){
   const message=error instanceof Error?error.message:'internal_error'
   if(message==='unauthorized'){reply(401,{error:message});return}
   if(['schedule_owner_required','schedule_recipient_required'].includes(message)){reply(403,{error:message});return}
   if(['shared_schedule_missing','shared_schedule_conflict','stale_schedule_owner','occurrence_conflict','schedule_unresolved','stale_schedule_frontier','occurrence_missing','occurrence_terminal','schedule_handoff_conflict','schedule_handoff_missing','invalid_schedule_target','schedule_capacity'].includes(message)){reply(409,{error:message});return}
   if(['primary_required','publisher_required'].includes(message)){reply(403,{error:message});return}
   if(['space_mismatch','producer_mismatch','source_owner_required','upload_consent_required','processing_consent_required'].includes(message)){reply(403,{error:message});return}
   if(['producer_sequence_gap','source_deleted','stale_consent','evidence_conflict','context_capacity','derived_revision_conflict','stale_inputs','duplicate_projection_key'].includes(message)){reply(409,{error:message});return}
   if(['stale_authority','authority_transition','authority_uninitialized','transition_not_found','transition_id_conflict','already_primary','handoff_incomplete','recovery_required','pc_primary_required','device_kind_required','device_unavailable'].includes(message)){reply(409,{error:message});return}
   if(['recipient_required','owner_required','task_control_denied','sender_revoked'].includes(message)){reply(403,{error:message});return}
   if(['command_id_conflict','task_id_conflict','command_already_decided','event_id_conflict','sequence_gap','terminal_task','verification_required','task_not_accepted'].includes(message)){reply(409,{error:message});return}
   if(['target_unavailable','command_expired','deadline_invalid','invalid_target'].includes(message)){reply(400,{error:message});return}
   if(error instanceof ZodError||error instanceof SyntaxError){reply(400,{error:'invalid_request',...(token?{snapshot:store.snapshot(token)}:{})});return}
   const conflict=['version_conflict','item_not_found','idea_not_found','item_deleted','goal_not_found','idea_archived','store_capacity','op_id_conflict','entity_id_conflict']
   if(conflict.includes(message)&&token){reply(409,{error:message,snapshot:store.snapshot(token)});return}
   if(['cursor_invalid','due_only_for_todo','criteria_only_for_goal','goal_cannot_parent'].includes(message)){reply(400,{error:message});return}
   reply(500,{error:'internal_error'})
  }
 })().catch(()=>{if(!res.headersSent){res.writeHead(500);res.end()}else res.destroy()})})
}
