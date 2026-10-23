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
test('negation flips are rejected only when enough content words are shared',()=>{
 assert.equal(reason('需要报销',['不需要报销']),'negation_flipped')
 assert.equal(reason('不需要报销',['需要报销']),'negation_flipped')
 assert.equal(reason('The user eats spicy food',['The user does not eat spicy food']),'negation_flipped')
 assert.equal(reason('He never missed the meeting',['He missed the meeting']),'negation_flipped')
 assert.equal(reason('喜欢咖啡',['不吃辣']),'ok','unrelated content words')
 assert.equal(reason('不喜欢香菜',['喜欢咖啡和茶']),'ok','one shared bigram is not enough')
 assert.equal(reason('不需要报销',['不需要报销']),'ok')
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
