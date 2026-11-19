const quiet=(time,start,end)=>start===end?false:start<end?time>=start&&time<end:time>=start||time<end
/** True when a brief that is switched on is scheduled inside quiet hours, so the host would skip it every day. */
export function briefQuietConflict(params){
 return ['outlook','review'].some(kind=>params[`briefing_${kind}_enabled`]===true&&quiet(params[`briefing_${kind}_time`],params.quiet_start,params.quiet_end))
}
