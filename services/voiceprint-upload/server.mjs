import {createServer} from 'node:http'
import {mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import {TosClient} from '@volcengine/tos-sdk'
import {createBroker} from './broker.mjs'

const env = process.env
for (const key of ['TOS_ACCESS_KEY_ID','TOS_SECRET_ACCESS_KEY','TOS_BUCKET','TOS_REGION','PUBLIC_BASE_URL','IP_HASH_SALT']) {
  if (!env[key]) throw new Error(`Missing ${key}`)
}
process.umask(0o077)
const database = env.DATABASE_PATH ?? './data/uploads.sqlite'
mkdirSync(dirname(database), {recursive:true, mode:0o700})
const client = new TosClient({accessKeyId:env.TOS_ACCESS_KEY_ID, accessKeySecret:env.TOS_SECRET_ACCESS_KEY,
  region:env.TOS_REGION, endpoint:`tos-${env.TOS_REGION}.volces.com`, requestTimeout:15000, maxRetryCount:1})
const storage = {
  put: (key, body) => client.putObject({bucket:env.TOS_BUCKET,key,body,contentType:'audio/wav',forbidOverwrite:true}),
  get: async key => (await client.getObjectV2({bucket:env.TOS_BUCKET,key,dataType:'buffer'})).data.content,
  delete: key => client.deleteObject({bucket:env.TOS_BUCKET,key}),
}
let storageReady = false
async function probeStorage() {
  try {
    await client.getObjectV2({bucket:env.TOS_BUCKET,key:'voiceprint-tmp/healthcheck',dataType:'buffer'})
    storageReady = true
   } catch (error) {
    storageReady = error.code === 'NoSuchKey'
    // The TOS SDK leaves GET error bodies as streams, even with dataType=buffer.
    if (error.statusCode === 404 && error.data?.[Symbol.asyncIterator]) {
      try {
        let body = ''
        for await (const chunk of error.data) {
          body += chunk.toString()
          if (body.length > 16384) throw new Error('oversized_storage_error')
        }
        storageReady = JSON.parse(body).Code === 'NoSuchKey'
      } catch {storageReady = false}
    }
  }
}
await probeStorage()
const probeTimer = setInterval(() => {void probeStorage()},60000)
probeTimer.unref()
const broker = createBroker({database, storage, healthy:()=>storageReady, ipSalt:env.IP_HASH_SALT, publicBase:env.PUBLIC_BASE_URL,
  perIp:Number(env.PER_IP_DAILY_LIMIT ?? 5), globalLimit:Number(env.GLOBAL_DAILY_LIMIT ?? 100),
  trustedProxies:(env.TRUSTED_PROXY_IPS ?? '').split(',').filter(Boolean)})
await broker.cleanup()
const server = createServer({requestTimeout:15000, headersTimeout:10000, maxHeaderSize:8192}, broker.handler)
server.maxConnections = 32
server.listen(Number(env.PORT ?? 8787), env.HOST ?? '127.0.0.1', () => console.log('voiceprint_upload_ready'))
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
  clearInterval(probeTimer)
  server.close(() => {broker.close(); process.exit(0)})
  setTimeout(() => process.exit(1), 20000).unref()
})
