/**
 * Deterministic, model-free consistency check between a generated rewrite and the source texts it
 * cites. It lowers the chance of a silently altered number, date or negation; it is not a proof.
 * Every rule errs toward `ok` when the evidence is ambiguous.
 *
 * Deliberately NOT done: negation-flip detection (paraphrases such as "避免/拒绝/少用" express negation
 * without a marker, so it misfired on faithful summaries), bare integers without a unit ("共 3 项" is a
 * legitimate summary count), Chinese numerals and relative dates.
 */
export type FactFidelityResult={ok:true}|{ok:false;reason:'number_not_in_sources'|'date_not_in_sources';detail:string}

const pad=(value:string):string=>value.padStart(2,'0')
const FULL_DATE=/(?<![\d.])(\d{4})(?:[-/](\d{1,2})[-/](\d{1,2})|\s{0,2}年\s{0,2}(\d{1,2})\s{0,2}月\s{0,2}(\d{1,2})(?:\s{0,2}[日号])?)(?!\d)/gu
const SHORT_DATE=/(?<![\d年])(\d{1,2})\s{0,2}月\s{0,2}(\d{1,2})\s{0,2}[日号]/gu
const NUMBER_TEXT=String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`
const UNITS=String.raw`%|元|块|万|千|小时|分钟|天|周|月(?!份)|年|公里|次|yuan|usd|rmb|dollars?|kg|km`
const MEASURED=new RegExp(String.raw`(?<![A-Za-z0-9_.,])(?:([¥$])\s?(${NUMBER_TEXT})|(${NUMBER_TEXT})\s?(?:${UNITS})(?![a-z]))`,'giu')
const NUMBER=/(?<![A-Za-z0-9_.,])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/gu

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
function numbersOf(text:string):Set<string>{return new Set([...text.matchAll(NUMBER)].map(match=>normalizeNumber(match[0])))}
/** Numbers directly attached to a currency symbol, percent sign or unit word. */
function measuredNumbers(text:string):Set<string>{return new Set([...text.matchAll(MEASURED)].map(match=>normalizeNumber(match[2]??match[3]!)))}

export function checkFactFidelity(generated:string,sources:readonly string[]):FactFidelityResult{
 if(!generated.trim()||!sources.some(source=>source.trim()))return {ok:true}
 const text=generated.normalize('NFKC'),origin=sources.map(source=>source.normalize('NFKC'))
 const sourceDates:Dates={full:new Set(),monthDay:new Set(),shortOnly:new Set()}
 for(const source of origin){const {dates}=extractDates(source);for(const key of Object.keys(sourceDates) as (keyof Dates)[])for(const value of dates[key])sourceDates[key].add(value)}
 const {dates:generatedDates,rest}=extractDates(text)
 for(const date of generatedDates.full)if(!sourceDates.full.has(date)&&!sourceDates.shortOnly.has(date.slice(5)))return {ok:false,reason:'date_not_in_sources',detail:date}
 for(const key of generatedDates.monthDay)if(!sourceDates.monthDay.has(key))return {ok:false,reason:'date_not_in_sources',detail:key}
 const sourceNumbers=new Set<string>()
 for(const source of origin)for(const value of numbersOf(source))sourceNumbers.add(value)
 for(const value of measuredNumbers(rest))if(!sourceNumbers.has(value))return {ok:false,reason:'number_not_in_sources',detail:value}
 return {ok:true}
}
