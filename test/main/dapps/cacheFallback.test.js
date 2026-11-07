import log from 'electron-log'

import store from '../../../main/store'
import { activateVerifiedCache } from '../../../main/dapps/cacheFallback'
import { dappPathExists, isDappVerified } from '../../../main/dapps/verify'

jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../../../main/store', () => {
  const store = jest.fn()
  store.updateDapp = jest.fn()
  return store
})

jest.mock('../../../main/dapps/verify', () => ({
  dappPathExists: jest.fn(),
  isDappVerified: jest.fn(),
  getDappCacheDir: jest.fn()
}))

const SEND_ID = '0xe8d705c28f65bc3fe10df8b22f9daa265b99d0e1893b2df49fd38120f0410bca'
const CONTENT_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

const dappRecord = (overrides = {}) => ({
  ens: 'send.frame.eth',
  status: 'loading',
  config: { key: 'value' },
  content: CONTENT_CID,
  manifest: {},
  openWhenReady: false,
  checkStatusRetryCount: 4,
  ...overrides
})

describe('#activateVerifiedCache', () => {
  beforeEach(() => {
    dappPathExists.mockResolvedValue(true)
    isDappVerified.mockResolvedValue(true)
  })

  it('marks a dapp ready when the cache verifies against the stored content CID', async () => {
    const dapp = dappRecord()

    await expect(activateVerifiedCache(SEND_ID, dapp)).resolves.toBe(true)

    expect(isDappVerified).toHaveBeenCalledWith(SEND_ID, CONTENT_CID)
    expect(store.updateDapp).toHaveBeenCalledWith(SEND_ID, {
      status: 'ready',
      openWhenReady: false,
      checkStatusRetryCount: 0
    })
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/using the verified cache/i))
  })

  it('does not mark ready from file presence alone when no content CID is stored', async () => {
    const dapp = dappRecord({ content: undefined })

    await expect(activateVerifiedCache(SEND_ID, dapp)).resolves.toBe(false)

    expect(isDappVerified).not.toHaveBeenCalled()
    expect(store.updateDapp).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/no stored content CID to verify against; not marking ready/)
    )
  })

  it('does not mark ready when the cache is missing', async () => {
    dappPathExists.mockResolvedValue(false)

    await expect(activateVerifiedCache(SEND_ID, dappRecord())).resolves.toBe(false)

    expect(isDappVerified).not.toHaveBeenCalled()
    expect(store.updateDapp).not.toHaveBeenCalled()
  })

  it('does not mark ready when the cache fails CID verification', async () => {
    isDappVerified.mockResolvedValue(false)

    await expect(activateVerifiedCache(SEND_ID, dappRecord())).resolves.toBe(false)

    expect(store.updateDapp).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/failed CID verification/))
  })

  it('does not mark ready when verification throws', async () => {
    isDappVerified.mockRejectedValue(new Error('hash failed'))

    await expect(activateVerifiedCache(SEND_ID, dappRecord())).resolves.toBe(false)

    expect(store.updateDapp).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to verify local cache/),
      expect.any(Error)
    )
  })
})
