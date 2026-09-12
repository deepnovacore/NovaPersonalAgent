import {readdir, realpath, stat} from 'node:fs/promises'
import {join, isAbsolute} from 'node:path'
import {DatabaseSync} from 'node:sqlite'

export interface LocalCodexSession {
  readonly threadId: string
  readonly title: string
  readonly cwd: string
  readonly updatedAt: number
}

/** Read-only discovery. Resume always goes through app-server, never through copied rollout files. */
export async function readLocalCodexSessions(home: string): Promise<readonly LocalCodexSession[]> {
  const files = (await readdir(home)).filter(name => /^state_\d+\.sqlite$/u.test(name))
    .sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)))
  if (!files[0]) return []
  const db = new DatabaseSync(join(home, files[0]), {readOnly: true})
  let rows: Record<string, unknown>[]
  try {
    const columns = db.prepare('PRAGMA table_info(threads)').all().map(row => row.name)
    const name = columns.includes('name') ? "COALESCE(NULLIF(name, ''), title)" : 'title'
    rows = db.prepare(`SELECT id, ${name} AS title, cwd, updated_at FROM threads
      WHERE archived = 0 AND source IN ('cli', 'vscode', 'exec', 'app-server')
      ORDER BY updated_at DESC, id LIMIT 200`).all()
  } finally { db.close() }
  const sessions: LocalCodexSession[] = []
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id || row.id.length > 256
      || typeof row.title !== 'string' || !row.title.trim()
      || typeof row.cwd !== 'string' || !isAbsolute(row.cwd)
      || typeof row.updated_at !== 'number' || !Number.isFinite(row.updated_at)) continue
    try {
      const cwd = await realpath(row.cwd)
      if (!(await stat(cwd)).isDirectory()) continue
      sessions.push({threadId: row.id, title: [...row.title.replace(/\s+/gu, ' ').trim()].slice(0, 80).join(''), cwd, updatedAt: row.updated_at})
    } catch { /* A remote or deleted workspace cannot be resumed on this host. */ }
  }
  return sessions
}
