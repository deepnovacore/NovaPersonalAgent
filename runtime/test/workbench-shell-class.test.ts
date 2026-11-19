import assert from 'node:assert/strict'
import {test} from 'node:test'
import {approvalClasses,classDenied} from '../src/personal-agent/workbench-copy.js'
import {shellClasses} from '../src/personal-agent/workbench-shell-class.js'
import {localShellTreeState} from '../src/personal-agent/local-shell.js'

const project='/work/proj'
const classes=(command:string,cwd?:string)=>shellClasses(command,cwd,project)
const shell=(command:string,cwd?:string)=>approvalClasses({name:'shell_execute',arguments:{command,...(cwd?{cwd}:{})}},project)
const denies=(denied:string,attempt:string)=>classDenied(shell(attempt),new Set(shell(denied)))

test('every constituent of a compound command gets its own class',()=>{
  const list=classes('echo x; rm target.txt && ls | grep a')
  assert.ok(list.includes('shell:rm@rel:target.txt'));assert.ok(list.includes('shell:ls'));assert.ok(list.includes('file-write:/work/proj/target.txt'))
  assert.ok(classes('echo $(rm a.txt)').includes('shell:rm@rel:a.txt'))
  assert.ok(classes('echo `rm a.txt`').includes('shell:rm@rel:a.txt'))
  assert.ok(classes('(rm a.txt)\nls').includes('shell:rm@rel:a.txt'))
})

test('a denied command also denies its constituents, wrappers and respellings',()=>{
  assert.equal(denies('echo x; rm target.txt','rm target.txt'),true)
  assert.equal(denies('rm target.txt','echo x && rm ./target.txt'),true)
  assert.equal(denies('rm target.txt','sh -c "rm target.txt"'),true)
  assert.equal(denies('rm target.txt',"bash -lc 'echo hi; rm target.txt'"),true)
  assert.equal(denies('rm target.txt','sudo rm -f target.txt'),true)
  assert.equal(denies('rm target.txt','cd . && rm target.txt'),true)
  assert.equal(denies('rm target.txt','ls'),false)
  assert.equal(denies('rm target.txt','rm other.txt'),false)
})

test('ambiguous commands conservatively match a denied shell class',()=>{
  for(const attempt of ['eval "$CMD"','sh -c "$CMD"','rm $FILE','find . -exec rm {} +','xargs rm'])assert.ok(classes(attempt).includes('shell:*'),attempt)
  assert.equal(denies('rm target.txt','eval "$CMD"'),true)
  assert.equal(denies('ls','echo hi'),false)
})

test('implicit and explicit working directory are the same class',()=>{
  assert.deepEqual(shell('rm a.txt'),shell('rm a.txt',project));assert.deepEqual(shell('rm a.txt'),shell('rm a.txt','.'))
  assert.notDeepEqual(shell('rm a.txt'),shell('rm a.txt','/tmp'))
})

test('a shell write and a file tool reach the same resource',()=>{
  const write=(path:string)=>approvalClasses({name:'file_write',arguments:{path,content:'x'}},project)
  for(const command of ['echo hi > out.txt','echo hi >> ./out.txt','printf x | tee out.txt','rm out.txt','mv a.txt out.txt','cp a.txt out.txt','sed -i s/a/b/ out.txt'])assert.equal(classDenied(shell(command),new Set(write('out.txt'))),true,command)
  assert.equal(classDenied(write('out.txt'),new Set(shell('echo hi > out.txt'))),true)
  assert.equal(classDenied(shell('echo hi > other.txt'),new Set(write('out.txt'))),false)
  assert.equal(classDenied(shell('echo hi > /dev/null'),new Set(write('out.txt'))),false)
  assert.equal(classDenied(shell('echo hi > /tmp/out.txt'),new Set(write('/tmp/out.txt'))),true)
})

test('a shell read below a denied outside directory matches a file_read denial',()=>{
  const read=(path:string)=>approvalClasses({name:'file_read',arguments:{path}},project)
  for(const command of ['cat /etc/hosts','head -n1 /etc/passwd','grep root /etc/passwd','find /etc -name x','ls /etc','cat < /etc/hosts'])assert.equal(classDenied(shell(command),new Set(read('/etc/hosts'))),true,command)
  assert.equal(classDenied(shell('cat /var/log/x'),new Set(['file-read-outside:/etc'])),false)
  assert.equal(classDenied(shell('cat src/a.ts'),new Set(['file-read-outside:/etc'])),false)
  assert.equal(classDenied(read('/etc/hosts'),new Set(shell('cat /etc/passwd'))),true)
})

test('tree state never treats a vanished Windows leader as proof its tree ended',()=>{
  assert.equal(localShellTreeState({platform:'win32',pid:2**30},'win32'),'unknown')
  assert.equal(localShellTreeState({platform:'win32',pid:process.pid},'win32'),'alive')
  assert.equal(localShellTreeState({platform:'darwin',pid:2**30},'win32'),'unknown')
  if(process.platform==='darwin')assert.equal(localShellTreeState({platform:'darwin',pid:2**30},'darwin'),'gone')
})
