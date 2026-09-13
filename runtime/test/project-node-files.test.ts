import assert from 'node:assert/strict'
import {closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {createProjectNodeFiles} from '../src/project-node-files.js'

test('Node project files bind real descriptors, reject replaced roots and preserve exact children', () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'nova-node-files-')))
  const path = join(parent, 'root')
  mkdirSync(path)
  const fd = openSync(path, 'r')
  try {
    const files = createProjectNodeFiles()
    files.bindDirectory!(fd, path)
    assert.equal(files.probe(fd).status, 'ok')
    assert.equal(files.createFileAt(fd, 'state', true).status, 'ok')
    assert.equal(files.createFileAt(fd, 'state', true).status, 'exists')
    assert.equal(files.lookupAt(fd, '../escape').status, 'failed')
    const stored = files.lookupAt(fd, 'state')
    assert.equal(stored.status, 'ok')
    if (stored.status !== 'ok') throw new Error('missing state')
    assert.equal(typeof stored.identity.inode, 'bigint')
    assert.equal(files.unlinkAt(fd, 'state', {device: -1n, inode: -1n}, 'file').status, 'mismatch')
    assert.equal(files.renameNoReplaceAt!(fd, 'state', 'renamed', stored.identity).status, 'ok')
    assert.equal(files.unlinkAt(fd, 'renamed', stored.identity, 'file').status, 'ok')
    mkdirSync(join(parent, 'outside'))
    symlinkSync(join(parent, 'outside'), join(path, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(files.lookupAt(fd, 'link').status, 'failed')
    renameSync(path, join(parent, 'old'))
    mkdirSync(path)
    writeFileSync(join(path, 'keep'), 'untouched')
    assert.equal(files.probe(fd).status, 'failed')
    assert.equal(files.createFileAt(fd, 'unexpected', true).status, 'failed')
    assert.equal(fstatSync(fd).isDirectory(), true)
  } finally {
    closeSync(fd)
    rmSync(parent, {recursive: true, force: true})
  }
})
