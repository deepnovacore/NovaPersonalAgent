import test from 'node:test'
import assert from 'node:assert/strict'
import {checkFactFidelity} from '../src/memory-substrate/fact-fidelity.js'

const reason=(generated:string,sources:string[])=>{const r=checkFactFidelity(generated,sources);return r.ok?'ok':r.reason}

test('NanoMuse G4 counterexample: 100 yuan rewritten to 99999 yuan is rejected',()=>{
 assert.equal(reason('Budget is 99999 yuan monthly',['Budget is 100 yuan monthly']),'number_not_in_sources')
 assert.equal(reason('每月预算是99999元',['每月预算100元']),'number_not_in_sources')
 assert.equal(reason('预算 ¥99999',['预算 ¥100']),'number_not_in_sources')
 assert.equal(reason('Budget is 100 yuan monthly',['Budget is 100 yuan monthly']),'ok')
})
test('number normalization: separators, trailing zeros, percent and currency units',()=>{
 assert.equal(reason('Budget 1,000 yuan',['Budget 1000 yuan']),'ok')
 assert.equal(reason('Budget 1000 yuan',['Budget 1,000 yuan']),'ok')
 assert.equal(reason('Weighs 100.0 kg',['Weighs 100 kg']),'ok')
 assert.equal(reason('Weighs 2.50 kg',['Weighs 2.5 kg']),'ok')
 assert.equal(reason('完成率 30%',['完成率是30%']),'ok')
 assert.equal(reason('预算100元',['预算 100 yuan']),'ok')
 assert.equal(reason('Weighs 2.6 kg',['Weighs 2.5 kg']),'number_not_in_sources')
 assert.equal(reason('1. Budget 100',['Budget 100']),'ok','list numbering is not a fact')
})
test('dates must come from the sources',()=>{
 assert.equal(reason('报销截止 2026-10-21',['报销截止 2026-10-12']),'date_not_in_sources')
 assert.equal(reason('截止10月21日',['截止2026-10-12']),'date_not_in_sources')
 assert.equal(reason('截止2026年10月12日',['deadline 2026-10-12']),'ok')
 assert.equal(reason('deadline 2026/10/12',['截止2026年10月12日']),'ok')
 assert.equal(reason('截止10月12日',['截止2026-10-12']),'ok')
 assert.equal(reason('deadline 2026-10-12',['截止10月12日']),'ok','year-less source cannot contradict')
 assert.equal(reason('deadline 2026-10-12',['deadline 2026-10-9']),'date_not_in_sources')
 assert.equal(reason('下周提交，昨天开会',['提交报告','开会']),'ok','relative dates are not checked')
})
test('dates tolerate spaces around 年/月/日 and compare equal to the compact form',()=>{
 assert.equal(reason('准备 10 月 21 日的汇报',['正在准备 10 月 12 日的季度汇报']),'date_not_in_sources')
 assert.equal(reason('截止 2026 年 10 月 21 日',['截止 2026 年 10 月 12 日']),'date_not_in_sources')
 assert.equal(reason('10月 21日开会',['10月12日开会']),'date_not_in_sources')
 assert.equal(reason('10 月 12 日的汇报',['10月12日的汇报']),'ok')
 assert.equal(reason('10月12日的汇报',['10 月 12 日的汇报']),'ok')
 assert.equal(reason('2026 年 10 月 12 日',['2026-10-12']),'ok')
 assert.equal(reason('10 月份的 12 个任务',['任务清单']),'ok','not a date')
})
test('only numbers with a unit, currency or percent sign are checked; bare counts pass',()=>{
 assert.equal(reason('预算每月 99999 元',['预算每月 100 元']),'number_not_in_sources')
 assert.equal(reason('每周跑步 5 次',['每周跑 3 次']),'number_not_in_sources')
 assert.equal(reason('每天 8 小时',['每天 3 小时']),'number_not_in_sources')
 assert.equal(reason('$999',['$100']),'number_not_in_sources')
 assert.equal(reason('完成率 90%',['完成率30%']),'number_not_in_sources')
 assert.equal(reason('当前关注 4 个方面',['关注饮食']),'ok')
 assert.equal(reason('共 3 项',['提醒']),'ok')
 assert.equal(reason('第 2 点',['提醒']),'ok')
})
test('faithful rewording with other negation phrasing is not rejected (negation is deliberately not checked)',()=>{
 assert.equal(reason('用户倾向于上午开会，避免电话沟通',['不喜欢电话沟通']),'ok')
 assert.equal(reason('我吃辣',['我不吃辣']),'ok')
})
test('normal consolidation is not killed',()=>{
 const sources=['我不吃辣，但喜欢咖啡和茶。周五下午有项目评审会议。','Prefers morning meetings; does not want calls after 6 pm.','预算每月 1,000 元，截止 2026-10-12。']
 for(const generated of [
  '喜欢咖啡和茶，不吃辣',
  '周五下午的项目评审会议',
  'Prefers morning meetings and no calls after 6 pm',
  '每月预算1000元，截止2026年10月12日',
  '饮食上偏清淡',
  '用户的日程以会议为主',
  '非常喜欢咖啡',
  '未来几周关注项目评审',
  '1. 项目评审会议\n2. 咖啡偏好',
 ])assert.equal(reason(generated,sources),'ok',generated)
})
test('empty inputs are allowed',()=>{
 assert.equal(reason('预算 99999',[]),'ok');assert.equal(reason('预算 99999',['  ']),'ok');assert.equal(reason('',['预算100']),'ok')
})
