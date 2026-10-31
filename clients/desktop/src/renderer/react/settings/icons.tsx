import React from 'react'
import {Settings2,BookOpen,Palette,ChartColumn,Bot,Sparkles,Blocks,Plug,ShieldCheck,Database,Library,KeyRound,Network,Smartphone,Code2,Bell,MessagesSquare,FileText,Mail,Calendar,Search,Camera,type LucideIcon} from 'lucide-react'
const categories:Record<string,LucideIcon>={general:Settings2,diary:BookOpen,themes:Palette,usage:ChartColumn,models:Bot,skills:Sparkles,capabilities:Blocks,connectors:Plug,space:Smartphone,permissions:ShieldCheck,privacy:Database,knowledge:Library,secrets:KeyRound,hub:Network,phone:Smartphone,codex:Code2}
export const moduleIcons:Record<string,LucideIcon>={search:Search,camera:Camera,coding:Code2,knowledge:Library}
export const cardIcons:Record<string,LucideIcon>={'主动消息':Bell,'飞书':MessagesSquare,'每日日记':BookOpen,'每日简报':Calendar,'主动发现':Sparkles,'每日主动消息上限':Bell,'资讯相关度':Search,'记忆':Database,'邮件':Mail,'日程':Calendar,'本机文档':FileText}
export function SettingsCategoryIcon({id}:{id:string}){const Icon=categories[id]??Settings2;return <Icon className="ui-icon" size={18} aria-hidden="true"/>}
export {Plug}
