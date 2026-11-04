import {z} from 'zod'
import sources from './sources.json' with {type:'json'}
import {createHash} from 'node:crypto'
import {SaxesParser} from 'saxes'
export interface NewsSource {id:string;name:string;url:string;language?:'zh-CN'|'en'}
export interface Article {id:string;source_id:string;title:string;summary:string;url:string;published_at:string|null;first_seen:string;content_hash:string}
const sourceSchema=z.object({id:z.string(),name:z.string(),url:z.url(),language:z.enum(['zh-CN','en'])})
export const NEWS_SOURCES:NewsSource[]=sourceSchema.array().parse(sources)
export const newsLanguage=(locale:string):'zh-CN'|'en'=>/^zh(?:[-_]|$)/iu.test(locale)?'zh-CN':'en'
export const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
export function articleUrl(value:string):string|null{
 try{const u=new URL(value);if(value.length>4096||!['http:','https:'].includes(u.protocol)||u.username||u.password)return null
  if(u.hostname==='localhost'||u.hostname.endsWith('.local')||u.hostname.includes(':')||/^\d+(?:\.\d+){3}$/u.test(u.hostname))return null
  u.hash='';for(const key of [...u.searchParams.keys()])if(key.startsWith('utm_'))u.searchParams.delete(key)
  return u.href
 }catch{return null}
}
function plain(text:string){return text.replace(/<[^>]*>/gu,' ').replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gu,v=>({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[v]??v)).replace(/&#(x[0-9a-f]+|[0-9]+);/giu,(_all,value:string)=>{const hex=/^x/iu.test(value),code=Number.parseInt(hex?value.slice(1):value,hex?16:10);return code>0&&code<=0x10ffff?String.fromCodePoint(code):''}).replace(/\s+/gu,' ').trim()}
export function parseFeed(xml:string,source:NewsSource,now:Date):Article[]{
 if(Buffer.byteLength(xml)>1024*1024)throw Error('feed_too_large')
 const parser=new SaxesParser({xmlns:false});const stack:string[]=[];let root='',fields:Record<string,string>|null=null,itemDepth=0
 const articles:Article[]=[]
 parser.on('doctype',()=>{throw Error('feed_doctype')})
 parser.on('error',()=>{throw Error('invalid_feed')})
 parser.on('opentag',tag=>{const name=tag.name.toLowerCase();stack.push(name);if(stack.length>32)throw Error('feed_depth')
  if(stack.length===1)root=name
  if(name==='item'||name==='entry'){fields={};itemDepth=stack.length}
  if(fields&&name==='link'&&typeof tag.attributes.href==='string'&&(!tag.attributes.rel||tag.attributes.rel==='alternate'))fields.link=tag.attributes.href
 })
 const text=(value:string)=>{if(fields){const key=stack[itemDepth];if(key)fields[key]=(fields[key]??'')+value}}
 parser.on('text',text);parser.on('cdata',text)
 parser.on('closetag',()=>{if(fields&&stack.length===itemDepth){
   const title=plain(fields.title??'').slice(0,300),url=articleUrl((fields.link??'').trim())
   const summary=plain(fields.description??fields.summary??fields['content:encoded']??fields.content??'').slice(0,1500)
   const timestamp=Date.parse(fields.pubdate??fields.published??fields.updated??fields['dc:date']??'')
   const published_at=Number.isFinite(timestamp)&&timestamp<=now.getTime()+300000?new Date(timestamp).toISOString():null
   if(title&&url&&articles.length<200){const id=digest(url);articles.push({id,source_id:source.id,title,summary,url,published_at,first_seen:now.toISOString(),content_hash:digest(title+'\n'+summary)})}
   fields=null
  }stack.pop()})
 parser.write(xml).close();if(!['rss','feed','rdf:rdf'].includes(root))throw Error('invalid_feed')
 return [...new Map(articles.map(a=>[a.id,a])).values()]
}
/** The only headers a feed read sends; the acceptance gate re-sends feed reads with exactly these. */
export const FEED_HEADERS:Readonly<Record<string,string>>={Accept:'application/rss+xml, application/atom+xml, application/xml, text/xml','User-Agent':'NovaPersonalAgent-News/0.3'}
export async function fetchFeed(source:NewsSource,signal:AbortSignal,fetcher:typeof fetch=fetch,now=new Date()):Promise<Article[]>{
 const response=await fetcher(source.url,{signal,redirect:'error',headers:FEED_HEADERS})
 if(!response.ok)throw Error('source_http_'+response.status)
 if(response.headers.get('content-type')?.includes('text/html'))throw Error('invalid_feed')
 if(Number(response.headers.get('content-length'))>1024*1024)throw Error('feed_too_large')
 if(!response.body)throw Error('empty_feed')
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;const value:unknown=chunk.value;if(!(value instanceof Uint8Array))throw Error('invalid_feed_bytes');size+=value.length;if(size>1024*1024)throw Error('feed_too_large');chunks.push(value)}}finally{await reader.cancel().catch(()=>{/* optional cleanup/observer */});reader.releaseLock()}
 return parseFeed(Buffer.concat(chunks).toString('utf8'),source,now)
}
