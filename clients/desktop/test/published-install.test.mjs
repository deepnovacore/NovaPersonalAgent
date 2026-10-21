import assert from 'node:assert/strict'
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {existsSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {test} from 'node:test'

const bash=process.platform==='win32'
  ? [process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.LOCALAPPDATA&&join(process.env.LOCALAPPDATA,'Programs')].filter(Boolean).map(root=>join(root,'Git','bin','bash.exe')).find(existsSync)
  : 'bash'
const bashPath=value=>process.platform==='win32'?'/'+value[0].toLowerCase()+value.slice(2).replaceAll('\\','/'):value

test('published installation retries only the missing requested version, with a five-attempt limit', {skip:!bash?'Requires Git Bash to execute the POSIX installer on Windows':false}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-install-retry-'))
  try {
    await writeFile(join(root, 'npm'), `#!/bin/bash
count=0; test ! -f "$NOVA_TEST_COUNT" || count=$(cat "$NOVA_TEST_COUNT")
count=$((count+1)); echo "$count" > "$NOVA_TEST_COUNT"
case "$NOVA_TEST_MODE" in
  success) exit 0;;
  late) if test "$count" -eq 3; then exit 0; fi;;
  auth) echo 'npm error code E401'; exit 1;;
  other) echo 'npm error code E404'; echo 'missing unrelated-dependency@1'; exit 1;;
esac
echo 'npm error code ETARGET'; echo 'No matching version found for nova-audio-agent-server@0.3.1'; exit 1
`, {mode: 0o700})
    await writeFile(join(root, 'sleep'), '#!/bin/bash\nexit 0\n', {mode: 0o700})
    for (const [mode, attempts, status] of [['success',1,0],['late',3,0],['missing',5,1],['auth',1,1],['other',1,1]]) {
      const counter = join(root, `${mode}.count`)
      const result = spawnSync(bash, ['--noprofile','--norc','-c','export PATH="$NOVA_TEST_BIN:$PATH"; exec bash "$@"','fixture',bashPath(fileURLToPath(new URL('../../../scripts/install-published-package.sh', import.meta.url))), 'nova-audio-agent-server@0.3.1', bashPath(join(root, mode))], {
        env: {...process.env, NOVA_TEST_BIN:bashPath(root), NOVA_TEST_MODE: mode, NOVA_TEST_COUNT: bashPath(counter)}, encoding: 'utf8', timeout:15000,
      })
      assert.equal(result.status, status, `${mode}: ${result.stderr}`)
      assert.equal(Number(await readFile(counter, 'utf8')), attempts, mode)
    }
  } finally {await rm(root, {recursive: true, force: true})}
})
