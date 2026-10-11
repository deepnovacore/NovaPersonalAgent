// Opt-in disposable fixture: node runtime/scripts/serve-gui-acceptance.mjs
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const statePath=join(tmpdir(),'nova-gui-acceptance-state.json');
createServer(async(req,res)=>{try{
 if(req.method==='POST'&&req.url==='/state'){
  let body='';for await(const part of req){body+=part;if(body.length>4096)throw Error('fixture_body_limit')}
  await writeFile(statePath,JSON.stringify(JSON.parse(body)),{mode:0o600});res.end('ok');
 }else if(req.method==='GET'&&req.url==='/'){
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile(new URL('./gui-acceptance.html',import.meta.url)));
 }else{res.statusCode=404;res.end()}
}catch{res.statusCode=400;res.end('invalid fixture request')}}).listen(18765,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:18765',statePath})));
