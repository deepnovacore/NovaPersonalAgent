import {createHash} from 'node:crypto'
import {goalCheckinEligible} from './life.js'

/** A `progress` goal with no check-in, recorded progress or creation this long ago is due anyway. */
export const GOAL_CHECKIN_SILENCE_MS=7*86400000
/** The summary waits this much at most after the day's first activity, so it does not land at the same moment every day. */
export const GOAL_CHECKIN_JITTER_MS=15*60000
export const GOAL_CHECKIN_MAX_GOALS=5

export const localDateOf=(timezone:string,at:number):string=>new Date(at).toLocaleDateString('en-CA',{timeZone:timezone})
/** First instant of the next local date, found by bisection so DST days need no offset arithmetic. */
export function localDateEnd(timezone:string,at:number):number{
 const today=localDateOf(timezone,at);let low=at,high=at+12*3600000
 while(localDateOf(timezone,high)===today){low=high;high+=12*3600000}
 while(high-low>1){const middle=Math.floor((low+high)/2);if(localDateOf(timezone,middle)===today)low=middle;else high=middle}
 return high
}
/** Deterministic per local date so tests and restarts agree; never Math.random. */
export const goalCheckinJitterMs=(localDate:string):number=>Number.parseInt(createHash('sha256').update('goal-checkin:'+localDate).digest('hex').slice(0,8),16)%(GOAL_CHECKIN_JITTER_MS+1)

export interface CheckinGoal {id:string;status:string;cadence:'daily'|'progress'|'off';importance?:'normal'|'high'|undefined;created_at:string}
export interface CheckinTodo {goal_id:string|null;status:string;updated_at:string}
export interface DueGoalCheckinInput {
 discovery_enabled:boolean
 timezone:string
 now:number
 goals:readonly CheckinGoal[]
 todos:readonly CheckinTodo[]
 /** When each goal's last check-in was delivered. */
 last_checkin_at:Readonly<Record<string,string>>
 /** `last_progress_at` of each goal's derived progress record. */
 last_progress_at:Readonly<Record<string,string|null>>
 silence_ms?:number
}
/**
 * Goals due for today's summary, most important first. `daily`: once per local date. `progress`: a linked todo was
 * completed since the last check-in, or the latest of last check-in, last progress and creation is at least the
 * silence window old. Either way a goal appears at most once per local date.
 */
export function dueGoalCheckins(input:DueGoalCheckinInput):string[]{
 if(!input.discovery_enabled)return []
 const today=localDateOf(input.timezone,input.now),silence=input.silence_ms??GOAL_CHECKIN_SILENCE_MS
 const due=input.goals.filter(goal=>{
  if(!goalCheckinEligible(input,goal.id).eligible)return false
  const last=input.last_checkin_at[goal.id]
  if(last&&localDateOf(input.timezone,Date.parse(last))===today)return false
  if(goal.cadence==='daily')return true
  const since=Date.parse(last??goal.created_at)
  if(input.todos.some(todo=>todo.goal_id===goal.id&&todo.status==='done'&&Date.parse(todo.updated_at)>since))return true
  const latest=Math.max(...[last,input.last_progress_at[goal.id],goal.created_at].filter((value):value is string=>!!value).map(Date.parse))
  return input.now-latest>=silence
 })
 return due.sort((a,b)=>Number(b.importance==='high')-Number(a.importance==='high')||a.created_at.localeCompare(b.created_at)).slice(0,GOAL_CHECKIN_MAX_GOALS).map(goal=>goal.id)
}
