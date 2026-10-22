import assert from 'node:assert/strict'
import test from 'node:test'
import {join} from 'node:path'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {configureDesktopIdentity, DESKTOP_PRODUCT_NAME, LEGACY_STORAGE_NAME} from '../src/main/desktop-identity.mjs'

test('first packaged launch reuses an existing source profile without replacing an established packaged profile',async()=>{
 const root=mkdtempSync(join(tmpdir(),'nova-existing-profile-')),source='@nova-audio-agent/ambient-orb'
 try{
  mkdirSync(join(root,source),{recursive:true});writeFileSync(join(root,source,'ambient-orb-settings.json'),'{}')
  for(const packaged of [false,true]){
   if(packaged){mkdirSync(join(root,LEGACY_STORAGE_NAME),{recursive:true});writeFileSync(join(root,LEGACY_STORAGE_NAME,'ambient-orb-settings.json'),'{}')}
   let storageName,userData
   const app={isPackaged:true,commandLine:{hasSwitch:()=>false},setName:name=>{storageName??=name},getPath:()=>root,setPath:(_key,value)=>{userData=value},whenReady:()=>Promise.resolve()}
   await configureDesktopIdentity(app)
   assert.equal(storageName,packaged?LEGACY_STORAGE_NAME:source)
   assert.equal(userData,join(root,packaged?LEGACY_STORAGE_NAME:source))
  }
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('desktop rename preserves encryption identity before ready and displays the new name after ready', async () => {
  let ready, name
  const paths = {appData: '/profile', userData: '/new-default'}
  const pending = new Promise(resolve => { ready = resolve })
  const app = {
    isPackaged: true,
    commandLine: {hasSwitch: () => false},
    setName(value) { name = value },
    getPath(key) { return paths[key] },
    setPath(key, value) { paths[key] = value },
    whenReady: () => pending,
  }
  const configured = configureDesktopIdentity(app)
  assert.equal(name, LEGACY_STORAGE_NAME)
  assert.equal(paths.userData, join('/profile', LEGACY_STORAGE_NAME))
  ready()
  await configured
  assert.equal(name, DESKTOP_PRODUCT_NAME)
})

test('an explicit isolated user-data directory is preserved', async () => {
  const configured = configureDesktopIdentity({
    commandLine: {hasSwitch: name => name === 'user-data-dir'},
    setName() {},
    getPath() { throw new Error('must not read a default profile') },
    setPath() { throw new Error('must not replace isolated profile') },
    whenReady: () => Promise.resolve(),
  })
  await configured
})

test('source desktop rename keeps the original package profile used by local launchers', async () => {
  let name
  const paths = {appData: '/profile', userData: '/new-default'}
  const app = {isPackaged: false, commandLine: {hasSwitch: () => false},
    setName(value) {name = value}, getPath(key) {return paths[key]}, setPath(key, value) {paths[key] = value},
    whenReady: () => new Promise(() => {}),
  }
  void configureDesktopIdentity(app)
  assert.equal(name, '@nova-audio-agent/ambient-orb')
  assert.equal(paths.userData, join('/profile', '@nova-audio-agent/ambient-orb'))
})
