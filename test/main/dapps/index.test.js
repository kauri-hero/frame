const SEND_ID = '0xe8d705c28f65bc3fe10df8b22f9daa265b99d0e1893b2df49fd38120f0410bca'
const CONTENT_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

const mockNebula = {
  ready: jest.fn(() => true),
  once: jest.fn(),
  resolve: jest.fn(),
  ipfs: { get: jest.fn() }
}

const mockVerify = {
  dappPathExists: jest.fn(),
  isDappVerified: jest.fn(),
  getDappCacheDir: jest.fn(() => '/tmp/DappCache')
}

let dappsState

const mockStore = jest.fn((key, id) => {
  if (key === 'main.dapps') {
    return id ? dappsState[id] : dappsState
  }
  return undefined
})
mockStore.updateDapp = jest.fn((id, update) => {
  dappsState[id] = { ...dappsState[id], ...update }
})
mockStore.observer = jest.fn()
mockStore.appDapp = jest.fn()
mockStore.addFrameView = jest.fn()
mockStore.setCurrentFrameView = jest.fn()

jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('tar-fs', () => ({ extract: jest.fn() }))

jest.mock('../../../main/nebula', () => () => mockNebula)

jest.mock('../../../main/store', () => mockStore)

jest.mock('../../../main/dapps/server', () => ({
  sessions: { add: jest.fn(), remove: jest.fn() }
}))

jest.mock('../../../main/windows/extractColors', () => jest.fn())

jest.mock('../../../main/dapps/verify', () => mockVerify)

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

async function flushPromises() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

async function loadDappsModule() {
  await import('../../../main/dapps')
  await flushPromises()
}

describe('dapp load when nebula.resolve fails', () => {
  beforeEach(() => {
    dappsState = {}
    mockNebula.ready.mockReturnValue(true)
    mockNebula.once.mockReset()
    mockNebula.resolve.mockReset()
    mockNebula.resolve.mockRejectedValue(new Error('HTTPError'))
    mockVerify.dappPathExists.mockReset()
    mockVerify.isDappVerified.mockReset()
    mockVerify.dappPathExists.mockResolvedValue(true)
    mockVerify.isDappVerified.mockResolvedValue(true)
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.resetModules()
  })

  it('sets ready from a verified cache instead of failed', async () => {
    dappsState[SEND_ID] = dappRecord({ status: 'failed' })

    await loadDappsModule()

    expect(dappsState[SEND_ID].status).toBe('ready')
  })

  it('does not mark ready from file presence alone when no content CID is stored', async () => {
    dappsState[SEND_ID] = dappRecord({ status: 'loading', content: undefined, checkStatusRetryCount: 4 })

    await loadDappsModule()

    expect(dappsState[SEND_ID].status).toBe('failed')
  })

  it('does not flip a ready dapp to loading while a background update check runs', async () => {
    dappsState[SEND_ID] = dappRecord({ status: 'ready' })
    mockNebula.resolve.mockReturnValue(new Promise(() => {}))

    await loadDappsModule()

    expect(mockStore.updateDapp).not.toHaveBeenCalledWith(
      SEND_ID,
      expect.objectContaining({ status: 'loading' })
    )
    expect(dappsState[SEND_ID].status).toBe('ready')
  })

  it('keeps a ready dapp ready when the background nebula check fails and the cache verifies', async () => {
    dappsState[SEND_ID] = dappRecord({ status: 'ready', checkStatusRetryCount: 0 })

    await loadDappsModule()

    expect(dappsState[SEND_ID].status).toBe('ready')
    expect(mockStore.updateDapp).not.toHaveBeenCalledWith(
      SEND_ID,
      expect.objectContaining({ status: 'failed' })
    )
    expect(mockStore.updateDapp).not.toHaveBeenCalledWith(
      SEND_ID,
      expect.objectContaining({ status: 'initial' })
    )
  })
})
