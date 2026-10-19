import QRCode from 'qrcode'

export function createHubConnection({service, network, renderQr = payload => QRCode.toDataURL(JSON.stringify(payload),{width:280,margin:4,errorCorrectionLevel:'M'}), now = Date.now}) {
  let queue = Promise.resolve(), generation = 0, invitation, image
  const clear = () => { invitation = undefined; image = undefined }
  async function execute(action, deviceId, epoch) {
    if (['stop','remove'].includes(action)) {
      clear()
      try { await service.admin({action:'cancel'}) } catch {}
      await service[action]()
      let networkCleanupPending = false
      try {
        if (await service.networkOwned()) {
          const result = await network('remove')
          if (result.removed || result.state === 'needs_serve') await service.networkOwned(false)
          else networkCleanupPending = true
        }
      } catch { networkCleanupPending = true }
      return {state:'idle',installed:action === 'stop',network_cleanup_pending:networkCleanupPending}
    }
    if (action === 'cancel') {
      clear(); let running = false
      try { await service.admin({action:'cancel'}); running = true } catch {}
      return {state:running ? 'available' : 'idle',service:running}
    }
    if (action === 'enable') await service.enable()
    const serviceState = await service.status()
    if (!serviceState.running) return {state:serviceState.enabled ? 'hub_unavailable' : 'idle',installed:serviceState.installed,network_cleanup_pending:!serviceState.enabled && Boolean(await service.networkOwned?.())}
    if (action === 'revoke') await service.admin({action:'revoke',device_id:deviceId})
    const net = await network(action === 'enable' ? 'configure' : 'status')
    if (net.created) await service.networkOwned(true)
    if (net.state !== 'ready') {
      clear(); await service.admin({action:'cancel'})
      const {devices} = await service.admin({action:'devices'})
      return {...net,service:true,devices:devices.filter(device=>!device.revoked)}
    }
    if (invitation && invitation.url !== net.url) { clear(); await service.admin({action:'cancel'}) }
    if (['enable','refresh'].includes(action)) {
      if (epoch !== generation) return {state:'idle'}
      clear()
      const payload = await service.admin({action:'invite',url:net.url})
      const rendered = await renderQr(payload)
      if (epoch !== generation) { await service.admin({action:'cancel'}); return {state:'idle'} }
      invitation = payload; image = rendered
    }
    const status = await service.admin({action:'status'})
    const {devices} = await service.admin({action:'devices'})
    const expired = invitation && invitation.expires_at <= now()
    const redeemed = invitation && !expired && !status.invitation_active
    if (expired || redeemed || epoch !== generation) clear()
    return {state:redeemed ? 'paired' : expired ? 'expired' : image ? 'ready' : 'available',service:true,host:net.url,image,expires_at:invitation?.expires_at,devices:devices.filter(device=>!device.revoked)}
  }
  return {
    action(action, deviceId) {
      if (!['status','enable','refresh','cancel','revoke','stop','remove'].includes(action) || (action === 'revoke' ? typeof deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(deviceId) : deviceId !== undefined)) return Promise.resolve({state:'unavailable'})
      if (['cancel','stop','remove'].includes(action)) { generation++; clear() }
      const epoch = generation
      const task = queue.then(()=>execute(action,deviceId,epoch)).catch(error => ({state:['device_capacity','install_app_first','hub_path_too_long','hub_service_conflict','hub_start_failed','hub_stop_timeout'].includes(error.message) ? error.message : 'hub_unavailable'}))
      queue = task.then(()=>{})
      return task
    },
  }
}
