import log from 'electron-log'

import store from '../store'
import { dappPathExists, isDappVerified } from './verify'

import type { Dapp } from '../store/state'

// Use a previously resolved content CID plus on-disk DappCache when nebula/IPFS is down.
// File presence alone is not enough: without a stored CID the cache is not marked ready.
export async function activateVerifiedCache(dappId: string, dapp: Dapp): Promise<boolean> {
  const exists = await dappPathExists(dappId)

  if (!dapp.content) {
    if (exists) {
      log.warn(
        `Dapp ${dapp.ens} has files in DappCache but no stored content CID to verify against; not marking ready`
      )
    }
    return false
  }

  if (!exists) {
    return false
  }

  try {
    if (!(await isDappVerified(dappId, dapp.content))) {
      log.warn(`Dapp ${dapp.ens} local cache failed CID verification against ${dapp.content}`)
      return false
    }
  } catch (e) {
    log.error(`Failed to verify local cache for ${dapp.ens}`, e)
    return false
  }

  log.info(`Dapp ${dapp.ens} is using the verified cache after nebula.resolve/IPFS failure`)
  store.updateDapp(dappId, { status: 'ready', openWhenReady: false, checkStatusRetryCount: 0 })
  return true
}
