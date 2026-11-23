import assert from 'node:assert/strict'
import {existsSync, readdirSync, readFileSync} from 'node:fs'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

const root = new URL('../../../', import.meta.url)
test('public clients retain configurable login without pilot modules or an embedded login host', () => {
  for (const path of ['deploy/enterprise', 'runtime/src/enterprise-entry.ts', 'runtime/src/workspace-runtime.ts',
    'clients/ios/Nova/Nova/Protocol/CompanyWorkspace.swift', 'clients/ios/Nova/Nova/Views/CompanyWorkspaceView.swift']) {
    assert.equal(existsSync(new URL(path, root)), false, path)
  }
  const login = readFileSync(new URL('clients/ios/Nova/Nova/Protocol/EnterpriseSSO.swift', root), 'utf8')
  assert.ok(login.includes('NovaFeishuLoginOrigin'))
  assert.doesNotMatch(login, /https?:\/\/[a-z0-9]/iu)
  assert.ok(readFileSync(new URL('clients/ios/Nova/Nova/Views/ContentView.swift', root), 'utf8').includes('feishu-login'))
})

// Public Flutter and desktop sources must stay free of pilot modules, private hosts and organization-specific
// Feishu/Lark tenant hosts (AGENTS.md "Public and internal development").
const publicScopes = ['clients/flutter/lib', 'clients/desktop/src']
const textExtensions = /\.(?:dart|ts|tsx|js|mjs|cjs|json|css|html|md|yaml|yml|plist|swift|kt)$/iu
const forbiddenPathSegment = /(?:^|[\\/._-])(?:company|enterprise|weekly[-_]?reports?|work[-_]?records?|pilot|tenant[-_]?config)(?:[\\/._-]|$)/iu
const genericFeishuHosts = new Set(['open.feishu.cn', 'accounts.feishu.cn', 'open.larksuite.com', 'accounts.larksuite.com',
  'www.feishu.cn', 'www.larksuite.com'])
const feishuFamilyHost = /(?:^|\.)(?:feishu\.cn|feishu\.net|larksuite\.com|larkoffice\.com|feishucdn\.com)$/iu
const privateHost = /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$)|\.(?:internal|corp|intranet|lan|local|home\.arpa)$/iu
// Loopback and emulator addresses are legitimate for local development servers and relay discovery.
const allowedLocalHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '10.0.2.2'])

function publicFiles(scope: string): string[] {
  const out: string[] = []
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === 'node_modules' || entry.name === '.dart_tool' || entry.name.startsWith('.')) continue
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
      if (entry.isDirectory()) walk(child)
      else out.push(fileURLToPath(child).slice(fileURLToPath(root).length))
    }
  }
  walk(new URL(`${scope}/`, root))
  return out
}

for (const scope of publicScopes) {
  test(`${scope} contains no pilot modules, private endpoints or tenant-specific login hosts`, () => {
    const files = publicFiles(scope)
    assert.ok(files.length > 50, `${scope} should not be empty`)
    const problems: string[] = []
    for (const file of files) {
      if (forbiddenPathSegment.test(file.slice(scope.length))) problems.push(`path: ${file}`)
      if (!textExtensions.test(file)) continue
      const text = readFileSync(new URL(file, root), 'utf8')
      for (const match of text.matchAll(/https?:\/\/([^\s/'"`)\]}>\\:?#]+|\[[0-9a-f:]+\])/giu)) {
        const host = match[1]!.toLowerCase()
        if (allowedLocalHosts.has(host)) continue
        if (privateHost.test(host)) problems.push(`private host ${host}: ${file}`)
        else if (feishuFamilyHost.test(host) && !genericFeishuHosts.has(host) && host !== 'feishu.cn' && host !== 'larksuite.com')
          problems.push(`tenant-specific Feishu/Lark host ${host}: ${file}`)
      }
    }
    assert.deepEqual(problems, [])
  })
}
