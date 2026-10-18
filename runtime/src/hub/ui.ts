import type {IncomingMessage,ServerResponse} from 'node:http'
import {hubPage,hubIcon} from './ui/page.js'
import {hubStyles} from './ui/styles.js'
import {hubClient} from './ui/client.js'

const assets=new Map([
 ['/',{type:'text/html',body:hubPage}],
 ['/hub-ui/style.css',{type:'text/css',body:hubStyles}],
 ['/hub-ui/app.js',{type:'text/javascript',body:hubClient}],
 ['/hub-ui/icon.svg',{type:'image/svg+xml',body:hubIcon}],
])

/** Only the static shell is public. No database or credential is embedded in it. */
export function serveHubUi(req:IncomingMessage,res:ServerResponse):boolean{
 if(req.method!=='GET'&&req.method!=='HEAD')return false
 const asset=assets.get((req.url??'').split('?')[0]??'')
 if(!asset)return false
 res.writeHead(200,{
  'content-type':`${asset.type}; charset=utf-8`,
  'cache-control':'no-store',
  'x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer',
  'x-frame-options':'DENY',
  'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
 })
 res.end(req.method==='HEAD'?undefined:asset.body)
 return true
}
