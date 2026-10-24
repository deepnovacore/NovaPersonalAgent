import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadDeploymentConfig,main} from '../src/cli.js';

test('CLI deployment has explicit operator admission secret, private data directory and no public bind default',async()=> {
  const dir=mkdtempSync(join(tmpdir(),'relay-cli-'));const oldMask=process.umask();
  try {
    const path=join(dir,'config.json');const tokenPath=join(dir,'bootstrap');
    writeFileSync(tokenPath,'deployment-test-token-32-random-bytes\n');
    writeFileSync(path,JSON.stringify({dataDirectory:join(dir,'data'),bootstrapTokenFile:tokenPath}));
    const config=loadDeploymentConfig(path);
    assert.equal(config.bind,undefined);assert.equal(config.port,8080);
    assert.equal(config.bootstrapToken,'deployment-test-token-32-random-bytes');
    assert.equal(statSync(join(dir,'data')).mode & 0o777,0o700);
    await assert.rejects(()=>main([]),/Usage/);
    writeFileSync(path,JSON.stringify({dataDirectory:join(dir,'data'),bootstrapTokenFile:tokenPath,trustedProxyAddresses:['127.0.0.1'],maxControlOperationsPerSpace:12}));
    const proxyConfig=loadDeploymentConfig(path);assert.deepEqual(proxyConfig.trustedProxyAddresses,['127.0.0.1']);assert.equal(proxyConfig.maxControlOperationsPerSpace,12);
    writeFileSync(path,JSON.stringify({dataDirectory:join(dir,'data'),bootstrapTokenFile:tokenPath,tlsCertificateFile:'missing'}));
    assert.throws(()=>loadDeploymentConfig(path),/together/);
    writeFileSync(tokenPath,'short');
    writeFileSync(path,JSON.stringify({dataDirectory:join(dir,'data'),bootstrapTokenFile:tokenPath}));
    assert.throws(()=>loadDeploymentConfig(path),/at least 24/);
  } finally {process.umask(oldMask);rmSync(dir,{recursive:true,force:true});}
});
