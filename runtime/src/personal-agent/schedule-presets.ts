import {scheduleInputSchema,type ScheduleInput} from './scheduled-tasks.js'
export function schedulePresets(timezone:string):{id:string;description:string;input:ScheduleInput}[]{
 const context={todos:true,goals:true,tasks:true,memory:true,knowledge:true,search:false}
 return [
  {id:'daily-priorities',description:'从当前事项、目标和授权资料整理今天的优先级、风险与下一步。',input:scheduleInputSchema.parse({title:'每日优先级清单与风险提示',rule:{kind:'daily',timezone,time:'09:00'},context,
   goal:'基于本次运行时 App 中的事项、目标、Agent 任务及授权资料，整理今天的优先级清单与风险提示。先分页读取最新结构化数据，再按需检索来源。选择最多三项最值得优先处理的事情，说明依据、截止时间或依赖、具体下一步；列出真实存在的逾期、阻塞与信息缺口。区分事实、推断和建议。空数据时如实说明尚未记录事项，不编造任务、项目、风险或承诺。只输出建议，供用户决定是否转为事项。',
   acceptance:['用本次实时读取的证据说明最多三项优先事项及排序理由，每项有可执行的下一步。','有依据地报告截止时间、依赖和风险；没有证据的部分明确标为未知，不把建议当作已执行。','如实说明数据覆盖范围、缺失来源或截断；没有事项时交付清楚的空状态说明。']})},
  {id:'weekly-project-progress',description:'按已记录的重点项目整理本周进展、阻塞和下一步。',input:scheduleInputSchema.parse({title:'重点项目周度进展整理',rule:{kind:'weekly',timezone,time:'09:00',weekdays:[1]},context,
   goal:'整理截至本次运行的过去七天重点项目进展。通过最新 App 目标、关联事项、Agent 任务及授权资料识别实际已记录的项目，逐项概述有日期或历史证据支持的进展、当前阻塞、待决策问题和下一步。优先用户明确标为重点的项目；未标重点时说明选择依据，不编造项目。当前状态快照不能证明本周发生了变化；缺少历史或周内证据时明确写无法确认本周变化，并报告可核实的当前状态。建议下周行动，供用户决定是否转为事项或关联目标。',
   acceptance:['按实际存在的项目或目标组织内容，进展结论有过去七天的日期或历史证据；快照与周内变化明确区分。','每个有资料的项目说明当前状态、已知阻塞或待决策问题及具体下一步。','说明覆盖范围与缺失信息；没有重点项目记录时如实说明，不编造进展或完成情况。']})},
 ]
}
