import {SpaceHost} from '../../src/space-host/service.js'

/**
 * Production starts the first relay delivery in the background so an unreachable relay cannot hold startup.
 * Tests that assert on delivered messages right after open() import this to wait for that pass.
 */
const original = SpaceHost.prototype.open
SpaceHost.prototype.open = async function (this: SpaceHost): Promise<void> {
  await original.call(this)
  await this.initialDelivery
}
