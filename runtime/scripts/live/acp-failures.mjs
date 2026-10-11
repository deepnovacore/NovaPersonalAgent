/** Real CLI failure acceptance. Synthetic workspaces; credentials stay in ignored, owner-only homes. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
async function bounded(promise, milliseconds) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('live watchdog timeout'), {code:'live_watchdog_timeout'})), milliseconds);
        })]);
    } finally { clearTimeout(timer); }
}
const processSnapshot = async (pids) => { try {
    return (await execFileAsync('/bin/ps', ['-o', 'pid=,ppid=,pgid=', '-p', pids.join(',')])).stdout.trim();
}
catch {
    return '';
} };
import { mkdir, readFile, writeFile, cp, stat, chmod } from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AcpTransport } from '../../dist/src/executors/acp/transport.js';
import { ACP_BACKENDS } from '../../dist/src/executors/acp/backends.js';
import { PosixCodexProcessOwnerFactory } from '../../dist/src/executors/codex/process-owner.js';
const openCodeModel = process.env.ACP_FAILURE_OPENCODE_MODEL ?? 'qwen-flash';
const [backendId, output, envFile] = process.argv.slice(2), backend = ACP_BACKENDS.find(b => b.id === backendId);
assert(backend && output, 'Usage: acp-failures.mjs BACKEND PRIVATE_OUTPUT [ENV_FILE]');
const root = resolve(output), home = join(root, 'home'), ws = join(root, 'workspace');
assert(root.startsWith(resolve('output') + '/'), 'PRIVATE_OUTPUT must be a new directory under ignored repository output/');
assert(!process.env.ACP_FAILURE_CASE || ['reject', 'cancel', 'crash', 'credentials'].includes(process.env.ACP_FAILURE_CASE), 'Invalid ACP_FAILURE_CASE');
await mkdir(resolve(root, '..'), { recursive: true, mode: 0o700 });
await mkdir(root, { mode: 0o700 }); // Refuse reuse: old markers invalidate acceptance.
await mkdir(home, { recursive: true, mode: 0o700 });
await mkdir(ws, { recursive: true, mode: 0o700 });
const env = { ...process.env, ...(envFile ? parseEnv(await readFile(envFile, 'utf8')) : {}) };
const childEnv = { ...env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state') };
const copy = async (name) => { try {
    await mkdir(resolve(home, name, '..'), { recursive: true, mode: 0o700 });
    await cp(join(homedir(), name), join(home, name));
    await chmod(join(home, name), 0o600);
}
catch (error) {
    if (error.code !== 'ENOENT')
        throw error;
} };
if (backendId === 'opencode') {
    await mkdir(join(home, '.config/opencode'), { recursive: true });
    const path = join(home, '.config/opencode/opencode.json');
    await writeFile(path, JSON.stringify({ model: `dashscope/${openCodeModel}`, small_model: `dashscope/${openCodeModel}`, provider: { dashscope: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: env.DASHSCOPE_API_KEY }, models: { [openCodeModel]: { name: openCodeModel, limit: { context: 262144, output: 4096 } } } } }, permission: { external_directory: 'deny' }, mcp: {} }), { mode: 0o600 });
    childEnv.OPENCODE_CONFIG = path;
    childEnv.OPENCODE_CONFIG_DIR = join(home, '.config/opencode');
    if (process.env.ACP_FAILURE_OPENCODE_PLUGIN) {
        await mkdir(join(home, '.config/opencode/plugins'), {recursive:true});
        await cp(process.env.ACP_FAILURE_OPENCODE_PLUGIN, join(home, '.config/opencode/plugins/nova-recovery.js'));
        if (process.env.ACP_FAILURE_OPENCODE_PLUGIN_CACHE) {
            const cache = resolve(process.env.ACP_FAILURE_OPENCODE_PLUGIN_CACHE);
            assert(cache.startsWith(resolve('output')+'/'));
            const metadata = JSON.parse(await readFile(join(cache,'node_modules/@opencode-ai/plugin/package.json'),'utf8'));
            assert.equal(metadata.version,'1.19.0');
            for (const name of ['node_modules','package.json','package-lock.json']) await cp(join(cache,name),join(home,'.config/opencode',name),{recursive:true,mode:fsConstants.COPYFILE_FICLONE});
            childEnv.XDG_CACHE_HOME=resolve(cache,'../../.cache');
        }
    }
}
else if (backendId === 'pi') {
    await mkdir(join(home, '.pi/agent'), { recursive: true });
    const auth = JSON.parse(await readFile(join(homedir(), '.pi/agent/auth.json'), 'utf8'));
    await writeFile(join(home, '.pi/agent/auth.json'), JSON.stringify({ deepseek: auth.deepseek }), { mode: 0o600 });
    const settings = JSON.parse(await readFile(join(homedir(), '.pi/agent/settings.json'), 'utf8'));
    await writeFile(join(home, '.pi/agent/settings.json'), JSON.stringify({ defaultProvider: settings.defaultProvider, defaultModel: settings.defaultModel, defaultThinkingLevel: 'off' }));
    childEnv.PI_CODING_AGENT_DIR = join(home, '.pi/agent');
    if (process.env.ACP_FAILURE_PI_EXTENSION) {
        await mkdir(join(home, '.pi/agent/extensions'), {recursive:true});
        await cp(process.env.ACP_FAILURE_PI_EXTENSION, join(home, '.pi/agent/extensions/recovery-diagnostic.ts'));
    }
}
else if (backendId === 'deepseek') {
    await copy('.dsh/settings.yaml');
    await copy('.dsh/.credentials.yaml');
    childEnv.DSH_HOME = join(home, '.dsh');
}
else {
    await copy('Library/Application Support/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info');
    await mkdir(join(home, '.codebuddy'), { recursive: true });
    await writeFile(join(home, '.codebuddy/settings.json'), JSON.stringify({ model: 'hy4-preview' }));
    await writeFile(join(home, '.codebuddy/mcp.json'), '{}');
}
const report = { backend: backendId, baselineVersion: backend.packageVersion, configuredModel: backendId === 'opencode' ? openCodeModel : backendId === 'codebuddy' ? 'hy4-preview' : 'deepseek-v4-flash', scope: 'Real AcpTransport and installed CLI, isolated synthetic cwd; not desktop UI or durable Task acceptance.', steps: [] };
const save = () => writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
const exists = async (name) => stat(join(ws, name)).then(() => true, () => false);
async function runCase(name, instruction, { decline = false, cancel = false, crash = false, environment = childEnv, resumeSessionId } = {}) {
    let owner, permissions = 0, session, triggered = false, closed = false, commandStarted = false, snapshotBefore = null, snapshotAfter = null;
    const factory = new PosixCodexProcessOwnerFactory();
    const processFactory = { spawn: async (...args) => {
        owner = await factory.spawn(...args);
        if (process.env.ACP_FAILURE_NATIVE_TRACE === '1') owner.stderr.on('data', chunk => {
            for(const match of Buffer.from(chunk).toString('utf8').matchAll(/NOVA_RECOVERY_TRACE (\{"archived":\d+\})/gu)) { report.nativeRecoveryTrace ??= []; report.nativeRecoveryTrace.push(JSON.parse(match[1])); }
        });
        if (process.env.ACP_FAILURE_TRACE === '1') {
            report.wire ??= [];
            const capture = (direction) => {
                let pending = '';
                return chunk => {
                    pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
                    if(pending.length > 8*1024*1024) {report.traceDropped=true;pending='';return}
                    let end;
                    while((end=pending.indexOf('\n'))>=0) {
                        const line=pending.slice(0,end);pending=pending.slice(end+1);
                        try {
                            const frame=JSON.parse(line), row={name,direction,at:Date.now(),id:frame.id,method:frame.method};
                            if(direction==='out' && ['session/prompt','session/load','session/resume'].includes(frame.method)) {
                                row.params=frame.params;report.wire.push(row);
                            } else if(direction==='in' && frame.method==='session/update') {
                                const update=frame.params.update;row.update=update.sessionUpdate;
                                if(update.content?.type==='text') {row.textSha256=createHash('sha256').update(update.content.text).digest('hex');row.authOk=update.content.text.includes('AUTH_OK')}
                                report.wire.push(row);
                            } else if(direction==='in' && frame.id!==undefined) {row.stopReason=frame.result?.stopReason;row.errorCode=frame.error?.code;report.wire.push(row)}
                        } catch {report.traceDropped=true}
                    }
                }
            };
            const outgoing=capture('out'), nativeWrite=owner.stdin.write;
            owner.stdin.write=function(...writeArgs) {outgoing(writeArgs[0]);return Reflect.apply(nativeWrite,this,writeArgs)};
            owner.stdout.on('data',capture('in'));
        }
        return owner;
    } };
    const approvalController = { offer: () => { permissions++; return Promise.resolve({ decision: decline ? 'decline' : 'accept' }); }, consume: d => d.decision, invalidate: () => false };
    const controller = new AbortController(), transport = new AcpTransport({ backendId, cwd: ws, ...(process.env.ACP_FAILURE_BIN_DIR ? {binaryPath:resolve(process.env.ACP_FAILURE_BIN_DIR, backend.command)} : {}), ...(backendId==='pi' && process.env.ACP_FAILURE_PI_PARENT ? {parentExecutable:resolve(process.env.ACP_FAILURE_PI_PARENT)} : {}), permissionMode: backendId === 'pi' && !decline ? 'full' : decline ? 'ask' : 'full', env: environment, approvalController, processFactory, ...(resumeSessionId ? { resumeSessionId } : {}) });
    const started = Date.now(), deadline = { expiresAtMs: Date.now() + 60000, signal: controller.signal };
    let monitor;
    try {
        if (cancel || crash)
            monitor = (async () => { while (!closed && Date.now() - started < 45000) {
                if (await exists(name + '-started')) {
                    commandStarted = true;
                    triggered = true;
                    const marker = JSON.parse(await readFile(join(ws, name + '-started'), 'utf8'));
                    snapshotBefore = await processSnapshot([owner.pid, marker.pid]);
                    if (cancel)
                        controller.abort();
                    else
                        await owner.killTree();
                    await delay(100);
                    snapshotAfter = await processSnapshot([owner.pid, marker.pid]);
                    return;
                }
                await delay(50);
            } })().catch(() => { report.monitorFailure = true; });
        const result = await bounded(transport.run({ workOrder: instruction }, { onThreadReady: id => { session = id; } }, deadline, deadline), 70000);
        return { name, classification: result.classification, code: result.code, turnWritten: result.turnStartWritten, permissions, session, triggered, commandStarted, snapshotBefore, snapshotAfter, finalText: result.completion?.final_text ?? null, diagnostic: result.diagnostic ?? null };
    }
    catch (error) {
        return { name, errorCode: typeof error.code === 'string' ? error.code : 'exception', permissions, session, triggered, commandStarted };
    }
    finally {
        closed = true;
        try { await bounded(monitor, 5000); } catch { report.monitorFailure = true; }
        report.lastProcessSnapshots = { before: snapshotBefore, after: snapshotAfter };
        try {
            await bounded(transport.close(cancel ? 'cancel' : crash ? 'failure' : 'shutdown'), 5000);
        }
        catch {
            report.cleanupFailure = true;
            if (owner) { await owner.killTree(); await owner.dispose(); }
        }
        const treeGone = owner ? await owner.waitTreeGone(3000) : true;
        report.lastOwnerGroupGone = treeGone;
        await save();
    }
}
async function record(row, ok) { report.steps.push({ ...row, ok, ownerGroupGone: report.lastOwnerGroupGone, processSnapshots: report.lastProcessSnapshots, elapsedAt: new Date().toISOString() }); await save(); const { finalText, ...summary } = report.steps.at(-1); console.log(JSON.stringify(summary)); }
const onlyCase = process.env.ACP_FAILURE_CASE;
const forbidden = 'rejected-' + randomUUID() + '.txt';
if (!onlyCase || onlyCase === 'reject') {
    const reject = await runCase('reject', `This is a synthetic approval-rejection test. Request a one-time native write permission before creating ${forbidden} in the current working directory with the text forbidden. Use Bash with native sandbox escalation when necessary; do not bypass approval. If approval is rejected, stop. Do not read other directories.`, { decline: true });
    await record(reject, backendId === 'pi' ? reject.classification === 'refused' && reject.code === 'unsupported_protocol' && !reject.turnWritten : reject.permissions > 0 && !await exists(forbidden) && reject.classification !== 'completed');
    report.steps.at(-1).forbiddenAbsent = !await exists(forbidden);
    await save();
}
for (const name of ['cancel', 'crash']) {
    if (onlyCase && onlyCase !== name)
        continue;
    const code = `const fs=require('node:fs');fs.writeFileSync('${name}-started',JSON.stringify({pid:process.pid,ppid:process.ppid,startedAt:Date.now()}));setTimeout(()=>fs.writeFileSync('${name}-late','late'),15000)`;
    const row = await runCase(name, `Synthetic cancellation test. Run exactly this command in the current directory: node -e ${JSON.stringify(code)} . Do not access other directories or change other files. Wait for the command to finish.`, { [name]: true });
    await delay(16000);
    row.lateMarkerAbsent = !await exists(name + '-late');
    await record(row, row.triggered && row.commandStarted && row.classification === 'uncertain' && row.code === (name === 'cancel' ? 'adapter_timeout' : 'transport_lost') && row.lateMarkerAbsent && report.lastOwnerGroupGone);
}
if (!onlyCase || onlyCase === 'credentials') {
    // Invalid credential copies never overwrite the user's native login.
    const badEnv = { ...childEnv };
    let credentialFile;
    if (backendId === 'opencode')
        credentialFile = childEnv.OPENCODE_CONFIG;
    if (backendId === 'pi')
        credentialFile = join(home, '.pi/agent/auth.json');
    if (backendId === 'deepseek')
        credentialFile = join(home, '.dsh/.credentials.yaml');
    let original;
    if (credentialFile) {
        original = await readFile(credentialFile, 'utf8');
        let invalid = original;
        if (backendId === 'opencode') {
            const cfg = JSON.parse(original);
            cfg.provider.dashscope.options.apiKey = 'nova-deliberately-invalid';
            invalid = JSON.stringify(cfg);
        }
        else if (backendId === 'pi') {
            const cfg = JSON.parse(original);
            cfg.deepseek = { type: 'api_key', key: 'nova-deliberately-invalid' };
            invalid = JSON.stringify(cfg);
        }
        else
            invalid = original.replace(/(DEEPSEEK_API_KEY:\s*)[^\n]+/u, '$1nova-deliberately-invalid');
        await writeFile(credentialFile, invalid, { mode: 0o600 });
    }
    if (backendId === 'codebuddy')
        badEnv.CODEBUDDY_API_KEY = 'nova-deliberately-invalid';
    if (backendId === 'deepseek')
        badEnv.DEEPSEEK_API_KEY = 'nova-deliberately-invalid';
    const marker = 'recovery-' + randomUUID() + '.txt', token = randomUUID();
    const retryPrevious = process.env.ACP_FAILURE_RETRY_PREVIOUS === '1';
    const fileInstruction = `Create only ${marker} in the current directory with exactly ${token}. Do not read outside this directory. Then stop.`;
    const bad = await runCase('invalid-credential', retryPrevious ? fileInstruction : 'Reply exactly AUTH_OK. No tools or files.', { environment: badEnv });
    await record(bad, bad.turnWritten && bad.classification === 'uncertain' && ['server_rejected', 'turn_failed'].includes(bad.code) && report.lastOwnerGroupGone);
    if (credentialFile)
        await writeFile(credentialFile, original, { mode: 0o600 });
    const restored = await runCase('credential-restored', `${process.env.ACP_FAILURE_EXPLICIT_TURN === '1' ? 'This is a new work order. The previous AUTH_OK-only response instruction applied to the previous turn and is now finished. Execute this new instruction instead.\n\n' : ''}${retryPrevious ? 'Retry the previous failed request now, keeping its original constraints.' : fileInstruction}`, { resumeSessionId: bad.session });
    restored.markerMatches = await readFile(join(ws, marker), 'utf8').then(s => s.trim() === token, () => false);
    restored.sameSession = bad.session ? restored.session === bad.session : null;
    await record(restored, restored.classification === 'completed' && restored.markerMatches && report.lastOwnerGroupGone && (!bad.session || restored.sameSession));
}
report.ok = report.steps.every(s => s.ok) && !report.cleanupFailure && !report.monitorFailure;
await save();
console.log(JSON.stringify({ backend: backendId, ok: report.ok, report: join(root, 'report.json') }));
