import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {request} from 'node:http'
import {mkdir, lstat, chmod, readFile, writeFile, rename, unlink} from 'node:fs/promises'
import {join, isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
const exec = promisify(execFile)
const xml = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;')

export function hubLaunchPlist({label, executable, entry, dataDir, port = 8787}) {
  for (const path of [executable,entry,dataDir]) if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw Error('invalid_service_path')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${[executable,entry,'--data-dir',dataDir,'--port',String(port)].map(value=>`<string>${xml(value)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer></dict></plist>\n`
}

export function hubAdmin(socketPath, frame, {timeout = 6000} = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(frame)
    const req = request({socketPath,path:'/admin',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}}, res => {
      let bytes = 0; const chunks = []
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) req.destroy(Error('invalid_admin_response')); else chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString())
          if (res.statusCode !== 200) throw Error(['device_capacity','invalid_request'].includes(value.error) ? value.error : 'hub_unavailable')
          resolve(value)
        } catch (error) { reject(error) }
      })
    })
    const timer = setTimeout(() => req.destroy(Error('hub_timeout')), timeout)
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(body)
  })
}

async function privateDirectory(path) {
  await mkdir(path,{recursive:true,mode:0o700})
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('unsafe_hub_directory')
  await chmod(path,0o700)
}
async function readOwned(path) {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('unsafe_hub_file')
    return await readFile(path,'utf8')
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function atomicWrite(path, text) {
  await readOwned(path)
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp,text,{mode:0o600,flag:'wx'})
  try { await rename(temp,path) } finally { await unlink(temp).catch(()=>{}) }
}

export function createHubService({homeDir, executable, entry, appVersion, development = false, run = exec, adminRequest = hubAdmin, port = 8787}) {
  const suffix = development ? `-dev-${createHash('sha256').update(entry).digest('hex').slice(0,8)}` : ''
  const label = `ai.deepnovacore.nova.hub${suffix}`
  const dataDir = join(homeDir,'.nova',`hub-desktop${suffix}`)
  const socket = join(dataDir,'admin.sock')
  const agentsDir = join(homeDir,'Library','LaunchAgents')
  const plistPath = join(agentsDir,`${label}.plist`)
  const manifestPath = join(dataDir,'service.json')
  const domain = `gui/${process.getuid?.()}`
  const plist = () => hubLaunchPlist({label,executable,entry,dataDir,port})
  const launchctl = args => run('/bin/launchctl',args,{timeout:15000,maxBuffer:65536})
  const metadata = async () => { const raw = await readOwned(manifestPath); return raw ? JSON.parse(raw) : null }
  const admin = frame => adminRequest(socket,frame)
  // Startup restoration shares this queue with UI mutations. Internal helpers
  // deliberately do not enqueue themselves, so remove -> stop cannot deadlock.
  let lifecycle = Promise.resolve()
  const serialize = operation => {
    const result = lifecycle.then(operation)
    lifecycle = result.catch(() => {})
    return result
  }
  async function jobLoaded() {
    try { await launchctl(['print',`${domain}/${label}`]); return true }
    catch { return false }
  }
  async function status() {
    const manifest = await metadata()
    try { return {installed:Boolean(manifest),enabled:manifest?.enabled === true,running:true,...await admin({action:'status'})} }
    catch { return {installed:Boolean(manifest),enabled:manifest?.enabled === true,running:false} }
  }
  async function stopJob() {
    if (!await jobLoaded()) return
    await launchctl(['bootout',`${domain}/${label}`])
    // bootout can return while launchd still holds a SIGTERMed job. Its
    // socket may already be closed, but bootstrap must wait for both to vanish.
    for (let attempt=0;attempt<100;attempt++) {
      const loaded = await jobLoaded()
      let responding = false
      try { await admin({action:'status'}); responding = true } catch {}
      if (!loaded && !responding) return
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    throw Error('hub_stop_timeout')
  }
  async function enable() {
    if (Buffer.byteLength(socket) > 100) throw Error('hub_path_too_long')
    if (!development && (!executable.includes('.app/Contents/MacOS/') || executable.includes('/AppTranslocation/') || executable.startsWith('/Volumes/'))) throw Error('install_app_first')
    await privateDirectory(join(homeDir,'.nova')); await privateDirectory(dataDir)
    await mkdir(agentsDir,{recursive:true,mode:0o700})
    const current = await metadata(), existing = await readOwned(plistPath)
    if (!current && (existing || await jobLoaded())) throw Error('hub_service_conflict')
    const text = plist()
    if (current?.enabled && existing === text && current.appVersion === appVersion && (await status()).running) return
    await stopJob()
    await atomicWrite(plistPath,text)
    await atomicWrite(manifestPath,JSON.stringify({label,enabled:true,appVersion,executable,entry}))
    try {
      await launchctl(['bootstrap',domain,plistPath])
      for (let attempt=0;attempt<50;attempt++) {
        if ((await status()).running) return
        await new Promise(resolve=>setTimeout(resolve,100))
      }
      throw Error('hub_start_failed')
    } catch {
      await stopJob()
      await atomicWrite(manifestPath,JSON.stringify({label,enabled:false,appVersion,executable,entry}))
      if (await readOwned(plistPath)) await unlink(plistPath)
      throw Error('hub_start_failed')
    }
  }
  async function stop() {
    const current = await metadata(); if (!current) return
    // Cancel while the daemon is reachable, before terminating its admin socket.
    // An offline daemon must still be disabled; startup also invalidates invites.
    try { await admin({action:'cancel'}) } catch {}
    await stopJob(); await atomicWrite(manifestPath,JSON.stringify({...current,enabled:false}))
    // A stopped service must stay stopped at the next login.
    if (await readOwned(plistPath)) await unlink(plistPath)
  }
  return {
    dataDir, label, port, admin, status,
    enable: () => serialize(enable),
    restore: () => serialize(async () => { const current = await metadata(); if (current?.enabled) await enable() }),
    stop: () => serialize(stop),
    remove: () => serialize(async () => { await stop(); if (await readOwned(manifestPath)) await unlink(manifestPath) }),
    async networkOwned(value) {
      const path=join(dataDir,'serve-owned.json')
      if (value === undefined) return Boolean(await readOwned(path))
      if (value) await atomicWrite(path,JSON.stringify({port:8443,target:`http://127.0.0.1:${port}`}))
      else if (await readOwned(path)) await unlink(path)
    },
  }
}
