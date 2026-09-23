import {DatabaseSync} from 'node:sqlite'
import {createHash, createHmac, randomBytes, randomUUID} from 'node:crypto'
import {isIP} from 'node:net'

const MAX_BYTES = 960044
const TTL = 15 * 60000
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = (status, code) => Object.assign(new Error(code), {status})

export function ipBucket(ip) {
  if (!isIP(ip)) throw fail(400, 'invalid_address')
  if (isIP(ip) === 4) return ip
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1)
  if (normalized.startsWith('::ffff:')) {
    const words = normalized.slice(7).split(':').map(word => parseInt(word, 16))
    return [words[0] >> 8, words[0] & 255, words[1] >> 8, words[1] & 255].join('.')
  }
  const [left, right = ''] = normalized.split('::')
  const a = left ? left.split(':') : [], b = right ? right.split(':') : []
  return [...a, ...Array(8 - a.length - b.length).fill('0'), ...b].slice(0, 4).map(x => parseInt(x, 16).toString(16)).join(':') + '::/64'
}

function validWav(b) {
  return b.length >= 160044 && b.length <= MAX_BYTES && b.length % 2 === 0
    && b.toString('ascii', 0, 4) === 'RIFF' && b.readUInt32LE(4) === b.length - 8
    && b.toString('ascii', 8, 16) === 'WAVEfmt ' && b.readUInt32LE(16) === 16
    && b.readUInt16LE(20) === 1 && b.readUInt16LE(22) === 1 && b.readUInt32LE(24) === 16000
    && b.readUInt32LE(28) === 32000 && b.readUInt16LE(32) === 2 && b.readUInt16LE(34) === 16
    && b.toString('ascii', 36, 40) === 'data' && b.readUInt32LE(40) === b.length - 44
}

export function createBroker({database, ipSalt, storage, publicBase, perIp = 5, globalLimit = 100,
  trustedProxies = [], now = Date.now, healthy = () => true}) {
  const base = new URL(publicBase)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
    || typeof ipSalt !== 'string' || ipSalt.length < 32
    || !Number.isSafeInteger(perIp) || perIp < 0 || !Number.isSafeInteger(globalLimit) || globalLimit < 0) throw new Error('invalid_configuration')
  const urlBase = publicBase.replace(/\/$/, '')
  const db = new DatabaseSync(database)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS uploads (token TEXT PRIMARY KEY, object_key TEXT NOT NULL, ip TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, reads INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS quota_created ON uploads(created); CREATE INDEX IF NOT EXISTS quota_ip ON uploads(ip, created);')
  let active = 0, cleaning = false
  async function remove(row) {
    await storage.delete(row.object_key)
    // Keep quota accounting after deletion, but forget the bearer and object name.
    db.prepare('UPDATE uploads SET ready=0, object_key=? WHERE token=?').run('', row.token)
  }
  async function cleanup() {
    if (cleaning) return
    cleaning = true
    try {
      for (const row of db.prepare('SELECT * FROM uploads WHERE expires <= ? AND object_key != ? LIMIT 100').all(now(), '')) {
        try {await remove(row)} catch {console.error('voiceprint_cleanup_failed')}
      }
      db.prepare('DELETE FROM uploads WHERE created < ? AND object_key = ?').run(now() - 2 * 86400000, '')
    } finally {cleaning = false}
  }
  const timer = setInterval(() => {void cleanup()}, 60000)
  timer.unref()
  const send = (res, status, body) => {
    res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'})
    res.end(body === undefined ? undefined : JSON.stringify(body))
  }
  async function handle(req, res) {
    if (req.url === '/healthz' && req.method === 'GET') {
      const ok = healthy() && perIp > 0 && globalLimit > 0
      return send(res, ok ? 200 : 503, {ok})
    }
    if (active >= 4) return send(res, 503, {error:'busy'})
    active++
    try {
      if (req.method === 'POST' && req.url === '/uploads') {
        if (!perIp || !globalLimit || !healthy()) throw fail(503, 'uploads_disabled')
        const length = Number(req.headers['content-length'])
        if (req.headers['content-type'] !== 'audio/wav' || !Number.isSafeInteger(length) || length < 160044 || length > MAX_BYTES) throw fail(400, 'invalid_audio')
        const peer = req.socket.remoteAddress
        const address = trustedProxies.includes(peer) ? req.headers['x-real-ip'] : peer
        const ip = createHmac('sha256', ipSalt).update(ipBucket(address)).digest('hex')
        const day = Math.floor(now() / 86400000) * 86400000
        // ponytail: one SQLite writer, one service instance; use shared quotas before horizontal scaling.
        db.exec('BEGIN IMMEDIATE')
        let ticket, token, objectKey
        try {
          const own = db.prepare('SELECT COUNT(*) AS total, MAX(created) AS latest FROM uploads WHERE ip=? AND created>=?').get(ip, day)
          const all = db.prepare('SELECT COUNT(*) AS total FROM uploads WHERE created>=?').get(day)
          if (own.total >= perIp || all.total >= globalLimit || own.latest > now() - 60000) throw fail(429, 'quota_exceeded')
          ticket = randomBytes(32).toString('hex'); token = hash(ticket); objectKey = `voiceprint-tmp/${randomUUID()}.wav`
          db.prepare('INSERT INTO uploads(token,object_key,ip,created,expires) VALUES(?,?,?,?,?)').run(token, objectKey, ip, now(), now() + TTL)
          db.exec('COMMIT')
        } catch (error) {db.exec('ROLLBACK'); throw error}
        const chunks = []; let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > MAX_BYTES || size > length) throw fail(413, 'too_large')
          chunks.push(chunk)
        }
        const audio = Buffer.concat(chunks)
        if (size !== length || !validWav(audio)) throw fail(400, 'invalid_audio')
        await storage.put(objectKey, audio)
        db.prepare('UPDATE uploads SET ready=1 WHERE token=?').run(token)
        return send(res, 201, {ticket, audioUrl:`${urlBase}/audio/${ticket}`, expiresIn:900})
      }
      const match = /^\/(audio|uploads)\/([a-f0-9]{64})$/.exec(req.url)
      if (!match) throw fail(404, 'not_found')
      const row = db.prepare('SELECT * FROM uploads WHERE token=?').get(hash(match[2]))
      if (match[1] === 'uploads' && req.method === 'DELETE') {
        if (row?.object_key) await remove(row)
        return send(res, 204)
      }
      if (match[1] !== 'audio' || !['GET', 'HEAD'].includes(req.method)) throw fail(404, 'not_found')
      if (!row?.ready || !row.object_key || row.expires <= now()) throw fail(404, 'not_found')
      if (row.reads >= 3) throw fail(429, 'download_limit')
      db.prepare('UPDATE uploads SET reads=reads+1 WHERE token=?').run(row.token)
      const audio = await storage.get(row.object_key)
      if (!Buffer.isBuffer(audio) || !validWav(audio)) throw fail(502, 'storage_error')
      res.writeHead(200, {'Content-Type':'audio/wav','Content-Length':audio.length,'Cache-Control':'no-store', 'Content-Disposition':'attachment; filename="voiceprint.wav"','X-Content-Type-Options':'nosniff'})
      res.end(req.method === 'HEAD' ? undefined : audio)
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(res, error.status ?? 502, {error:error.status ? error.message : 'storage_unavailable'})
    } finally {active--}
  }
  return {handler:(req, res) => {void handle(req, res)}, cleanup, close() {clearInterval(timer); db.close()}}
}
