import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {ICO_SIZES, ICON_SIZES, TRAY_SIZES, makeIcons} from '../scripts/make-icons.mjs'

test('icon build writes PNG ladder, ICO and tray assets and reuses complete output', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'nova-icons-'))
  try {
    await makeIcons({outputDir, icns: false, log() {}})
    for (const size of ICON_SIZES) {
      const png = await readFile(join(outputDir, `build/icons/${size}x${size}.png`))
      assert.equal(png.subarray(1, 4).toString(), 'PNG')
      assert.equal(png.readUInt32BE(16), size)
      assert.equal(png.readUInt32BE(20), size)
    }
    const ico = await readFile(join(outputDir, 'build/icon.ico'))
    assert.equal(ico.readUInt16LE(2), 1)
    assert.equal(ico.readUInt16LE(4), ICO_SIZES.length)
    for (const size of TRAY_SIZES) {
      assert.ok((await readFile(join(outputDir, `resources/tray/tray-${size}@2x.png`))).length > 0)
    }
    assert.equal((await makeIcons({outputDir, icns: false, ifMissing: true, log() {}})).skipped, true)
  } finally { await rm(outputDir, {recursive: true, force: true}) }
})
