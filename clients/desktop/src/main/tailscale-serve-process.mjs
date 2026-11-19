import {spawn} from 'node:child_process'

// An OS pipe closes even when Electron crashes: do not leave Serve forwarding
// a dead relay's ephemeral port to some future, unrelated local listener.
const child = spawn(process.argv[2], process.argv.slice(3), {stdio:'ignore', windowsHide:true})
let stopping = false, timer
const stop = () => {
  if (stopping) return
  stopping = true
  child.kill('SIGTERM')
  timer = setTimeout(() => child.kill('SIGKILL'), 1000)
}
child.once('error', () => process.exit(1))
child.once('exit', code => { clearTimeout(timer); process.exit(code ?? 1) })
process.stdin.resume()
process.stdin.once('end', stop)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
