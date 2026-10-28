import assert from 'node:assert/strict'
import test from 'node:test'
import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import electron from 'electron'
import {compactDecrypt, importJWK} from 'jose'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = JSON.parse(readFileSync(new URL('../../../relay/test/fixtures/jose-v1.json', import.meta.url), 'utf8'))

test('Electron Host delivers the existing wrapped content key protocol to independent JOSE clients', async () => {
  const child = spawnSync(electron, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import {readFileSync} from 'node:fs';
    import {wrapContentKey,unwrapContentKey,verifyEnvelope,decryptBody,encryptBody} from '@nova-personal-agent/relay/crypto';
    const f=JSON.parse(readFileSync('relay/test/fixtures/jose-v1.json','utf8'));
    assert.ok(process.versions.electron,'actual Electron runtime required');
    verifyEnvelope(f.keyEnvelope,f.host.signingPublicKey);
    assert.deepEqual(await unwrapContentKey(f.wrapped,f.client.encryptionPrivateKey),f.keyDelivery);
    assert.deepEqual(await decryptBody(f.envelope.body,Buffer.from(f.key,'base64url')),f.plaintext);
    const wrapped=await wrapContentKey(f.keyDelivery,f.client.encryptionPublicKey);
    const body=await encryptBody(f.plaintext,Buffer.from(f.key,'base64url'));
    console.log(JSON.stringify({wrapped,body}));
  `], {cwd: root, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, encoding: 'utf8', timeout: 15000})
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stderr)
  const {wrapped, body} = JSON.parse(child.stdout)
  const privateKey = await importJWK(fixture.client.encryptionPrivateKey, 'ECDH-ES+A256KW')
  const delivery = await compactDecrypt(wrapped, privateKey, {keyManagementAlgorithms: ['ECDH-ES+A256KW'], contentEncryptionAlgorithms: ['A256GCM']})
  assert.deepEqual(JSON.parse(Buffer.from(delivery.plaintext)), fixture.keyDelivery)
  const content = await compactDecrypt(Buffer.from(body, 'base64').toString(), Buffer.from(fixture.key, 'base64url'))
  assert.deepEqual(JSON.parse(Buffer.from(content.plaintext)), fixture.plaintext)
})
