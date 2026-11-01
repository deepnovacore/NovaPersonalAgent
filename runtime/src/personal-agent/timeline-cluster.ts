/**
 * Near-identical timeline cards: the same cited message with a similar title. A long message can legitimately yield several
 * different cards, so a shared citation alone never merges; the titles must also describe the same matter.
 */
export interface ClusterCard {
  readonly title:string
  readonly refs:readonly string[]
  readonly facts:readonly unknown[]
  /** A card that revises a published card carries that identity and is never folded away. */
  readonly prior_id?:string|undefined
  readonly time?:{readonly as_of?:string|null}|undefined
}
export const TIMELINE_DUPLICATE_THRESHOLD=0.35
const normalized=(title:string)=>title.replace(/[\s，。、：:；（）()“”"'·\-—]+/gu,'')
const grams=(title:string):Set<string>=>{const text=normalized(title),out=new Set<string>();for(let i=0;i<text.length-1;i++)out.add(text.slice(i,i+2));return out}
export function titleSimilarity(a:string,b:string):number{
  const left=grams(a),right=grams(b)
  if(!left.size||!right.size)return normalized(a)===normalized(b)&&normalized(a)!==''?1:0
  let shared=0;for(const gram of left)if(right.has(gram))shared++
  return shared/(left.size+right.size-shared)
}
export interface CardCluster<T> {readonly leader:T;readonly members:readonly T[]}
/** Greedy leader clustering: the strongest card leads, later cards join the first leader they duplicate. Output keeps input order of the leaders. */
export function clusterCards<T extends ClusterCard>(cards:readonly T[],threshold=TIMELINE_DUPLICATE_THRESHOLD):CardCluster<T>[]{
  const rank=cards.map((card,index)=>({card,index})).sort((a,b)=>
    Number(!!b.card.prior_id)-Number(!!a.card.prior_id)
    ||(b.card.time?.as_of??'').localeCompare(a.card.time?.as_of??'')
    ||b.card.facts.length-a.card.facts.length||b.card.refs.length-a.card.refs.length||a.index-b.index)
  const clusters:{leader:T;index:number;members:T[];refs:Set<string>}[]=[]
  for(const {card,index} of rank){
    const home=card.prior_id?undefined:clusters.find(cluster=>card.refs.some(ref=>cluster.refs.has(ref))&&titleSimilarity(card.title,cluster.leader.title)>=threshold)
    if(home)home.members.push(card)
    else clusters.push({leader:card,index,members:[],refs:new Set(card.refs)})
  }
  return clusters.sort((a,b)=>a.index-b.index).map(cluster=>({leader:cluster.leader,members:cluster.members}))
}
