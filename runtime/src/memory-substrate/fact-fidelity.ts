/**
 * Deterministic, model-free consistency check between a generated rewrite and the source texts it
 * cites. It lowers the chance of a silently altered number, date or negation; it is not a proof.
 * Every rule errs toward `ok` when the evidence is ambiguous.
 */
export type FactFidelityResult={ok:true}|{ok:false;reason:'number_not_in_sources'|'date_not_in_sources'|'negation_flipped';detail:string}

const pad=(value:string):string=>value.padStart(2,'0')
const FULL_DATE=/(?<![\d.])(\d{4})(?:[-/](\d{1,2})[-/](\d{1,2})|年(\d{1,2})月(\d{1,2})[日号]?)(?!\d)/gu
const SHORT_DATE=/(?<![\d年])(\d{1,2})月(\d{1,2})[日号]/gu
const NUMBER=/(?<![A-Za-z0-9_.,])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/gu
const LIST_MARKER=/^[ \t]*(?:[-*•]\s*)?\d{1,3}[.)、:：]\s*/gmu

function normalizeNumber(raw:string):string{
 const [integer='0',fraction='']=raw.replaceAll(',','').split('.')
 const whole=integer.replace(/^0+(?=\d)/u,''),frac=fraction.replace(/0+$/u,'')
 return frac?`${whole}.${frac}`:whole
}
interface Dates {full:Set<string>;monthDay:Set<string>;shortOnly:Set<string>}
function extractDates(text:string):{dates:Dates;rest:string}{
 const dates:Dates={full:new Set(),monthDay:new Set(),shortOnly:new Set()}
 let rest=text.replace(FULL_DATE,(_,year:string,m1:string|undefined,d1:string|undefined,m2:string|undefined,d2:string|undefined)=>{
  const month=pad((m1??m2)!),day=pad((d1??d2)!)
  dates.full.add(`${year}-${month}-${day}`);dates.monthDay.add(`${month}-${day}`);return ' '
 })
 rest=rest.replace(SHORT_DATE,(_,m:string,d:string)=>{const key=`${pad(m)}-${pad(d)}`;dates.monthDay.add(key);dates.shortOnly.add(key);return ' '})
 return {dates,rest}
}
function numbersOf(text:string,keepListNumbers:boolean):Set<string>{
 const cleaned=keepListNumbers?text:text.replace(LIST_MARKER,'')
 return new Set([...cleaned.matchAll(NUMBER)].map(match=>normalizeNumber(match[0])))
}

const NEGATION_ZH=['没有','不要','不会','不能','不','没','未','无','非','别']
// Words that merely contain a negation character and do not negate anything.
const NEGATION_FALSE_FRIENDS=['非常','未来','别人','别的','无论','不过','不仅','不但','不错','不管','不少','不久','不断','无线','无聊','无限','无数','无关紧要']
const NEGATION_EN=/\b(?:not|no|never|without|cannot)\b|n['’]t\b/giu
const STOP_EN=new Set(['the','and','for','that','this','with','are','was','were','has','have','had','will','would','can','could','should','from','but','you','your','his','her','its','our','their','they','them','who','what','when','where','which','also','than','then','into','out','about','been','being','does','did','doing','user'])
const STOP_ZH=/[的了是在和与也都就还有我你他她它这那一个]/u
const SEPARATOR='\u0000'

interface Clause {negated:boolean;terms:Set<string>}
function clausesOf(text:string):Clause[]{
 const result:Clause[]=[]
 for(const raw of text.normalize('NFKC').split(/[。！？!?；;，,、:：\n（）()]|\.(?=\s|$)|\b(?:and|but|while|however|though|yet|or|because)\b|但是?|而且?|并且?|同时|然而|不过|因为|所以/u)){
  let clause=raw.toLowerCase()
  if(!clause.trim())continue
  for(const word of NEGATION_FALSE_FRIENDS)clause=clause.replaceAll(word,SEPARATOR)
  let negations=(clause.match(NEGATION_EN)??[]).length
  clause=clause.replace(NEGATION_EN,SEPARATOR)
  for(const marker of NEGATION_ZH){const parts=clause.split(marker);negations+=parts.length-1;clause=parts.join(SEPARATOR)}
  const terms=new Set<string>()
  for(const word of clause.match(/[a-z]{3,}/gu)??[])if(!STOP_EN.has(word))terms.add(word.length>4?word.replace(/(?:ing|ed|es|s)$/u,''):word)
  for(const run of clause.match(/\p{Script=Han}+/gu)??[])for(let i=0;i+1<run.length;i++){const gram=run.slice(i,i+2);if(!STOP_ZH.test(gram))terms.add(gram)}
  if(terms.size)result.push({negated:negations%2===1,terms})
 }
 return result
}

export function checkFactFidelity(generated:string,sources:readonly string[]):FactFidelityResult{
 if(!generated.trim()||!sources.some(source=>source.trim()))return {ok:true}
 const text=generated.normalize('NFKC'),origin=sources.map(source=>source.normalize('NFKC'))
 const sourceDates:Dates={full:new Set(),monthDay:new Set(),shortOnly:new Set()}
 for(const source of origin){const {dates}=extractDates(source);for(const key of Object.keys(sourceDates) as (keyof Dates)[])for(const value of dates[key])sourceDates[key].add(value)}
 const {dates:generatedDates,rest}=extractDates(text)
 for(const date of generatedDates.full)if(!sourceDates.full.has(date)&&!sourceDates.shortOnly.has(date.slice(5)))return {ok:false,reason:'date_not_in_sources',detail:date}
 for(const key of generatedDates.monthDay)if(!sourceDates.monthDay.has(key))return {ok:false,reason:'date_not_in_sources',detail:key}
 const sourceNumbers=new Set<string>()
 for(const source of origin)for(const value of numbersOf(source,true))sourceNumbers.add(value)
 for(const value of numbersOf(rest,false))if(!sourceNumbers.has(value))return {ok:false,reason:'number_not_in_sources',detail:value}
 const sourceClauses=origin.flatMap(clausesOf)
 for(const clause of clausesOf(text))for(const source of sourceClauses){
  if(clause.negated===source.negated)continue
  let shared=0;for(const term of clause.terms)if(source.terms.has(term)&&++shared>=2)return {ok:false,reason:'negation_flipped',detail:[...clause.terms].filter(term=>source.terms.has(term)).slice(0,4).join(',')}
 }
 return {ok:true}
}
