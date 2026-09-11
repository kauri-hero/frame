import fs from 'fs'
import os from 'os'
import path from 'path'

const mockSafeStorage = {
  available: true,
  encryptString: jest.fn((value) => Buffer.from(`enc:${value}`, 'utf8')),
  decryptString: jest.fn((buf) => Buffer.from(buf).toString('utf8').replace(/^enc:/, '')),
  isEncryptionAvailable: jest.fn(() => mockSafeStorage.available)
}

const mockApp = {
  ready: true,
  userData: '',
  isReady: jest.fn(() => mockApp.ready),
  getPath: jest.fn((name) => mockApp.userData || name),
  setName: jest.fn(),
  setPath: jest.fn()
}

jest.mock('electron', () => ({
  app: mockApp,
  safeStorage: mockSafeStorage
}))

import {
  CMC_KEY_FILENAME,
  clearSettingsCmcApiKey,
  getCmcKeyFilePath,
  getCmcKeyStatus,
  isCmcPriceApiToggleOn,
  resetCmcKeyStateForTests,
  resolveCmcApiKey,
  resolveCmcApiKeyValue,
  setInMemorySettingsCmcApiKey,
  setSettingsCmcApiKey,
  shouldUseCmcPriceFeed
} from '../../../../main/externalData/assets/cmcKey'

const KEYS = ['CMC_API_KEY']

describe('CMC API key resolver', () => {
  const previous = {}

  beforeEach(() => {
    for (const key of KEYS) {
      previous[key] = process.env[key]
      delete process.env[key]
    }
    resetCmcKeyStateForTests()
    mockSafeStorage.available = true
  })

  afterEach(() => {
    resetCmcKeyStateForTests()
    for (const key of KEYS) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })

  it('lets a trimmed env key win over a Settings key', () => {
    process.env.CMC_API_KEY = '  envAAAAsecret  '
    setInMemorySettingsCmcApiKey('settingsBBBBsecret')

    expect(resolveCmcApiKeyValue('  envAAAAsecret  ', 'settingsBBBBsecret')).toBe('envAAAAsecret')
    expect(resolveCmcApiKey()).toBe('envAAAAsecret')

    const status = getCmcKeyStatus()
    expect(status).toEqual({ source: 'env', last4: 'cret' })
    expect(status).not.toHaveProperty('key')
    expect(JSON.stringify(status)).not.toMatch(/envAAAA|settingsBBBB/)
  })

  it('uses the Settings key when env is blank', () => {
    process.env.CMC_API_KEY = '   '
    setInMemorySettingsCmcApiKey('settingsBBBBsecret')

    expect(resolveCmcApiKey()).toBe('settingsBBBBsecret')
    expect(getCmcKeyStatus()).toEqual({ source: 'settings', last4: 'cret' })
  })

  it('resolves to none when both sources are empty', () => {
    expect(resolveCmcApiKey()).toBe('')
    expect(getCmcKeyStatus()).toEqual({ source: 'none' })
  })

  it('treats an unset CMC Price API toggle as on only when a key exists', () => {
    expect(isCmcPriceApiToggleOn(undefined, false)).toBe(false)
    expect(isCmcPriceApiToggleOn(undefined, true)).toBe(true)
    expect(isCmcPriceApiToggleOn(false, true)).toBe(false)
    expect(isCmcPriceApiToggleOn(true, false)).toBe(true)
  })

  it('does not use the CMC feed when the toggle is off even if an env key exists', () => {
    process.env.CMC_API_KEY = 'envAAAAsecret'

    expect(shouldUseCmcPriceFeed(false)).toBe(false)
    expect(resolveCmcApiKey()).toBe('envAAAAsecret')
    expect(shouldUseCmcPriceFeed(true)).toBe(true)
  })

  it('keeps a Settings key when the feed is decided off', () => {
    setInMemorySettingsCmcApiKey('settingsBBBBsecret')

    expect(shouldUseCmcPriceFeed(false)).toBe(false)
    expect(resolveCmcApiKey()).toBe('settingsBBBBsecret')
  })
})

describe('CMC Settings key file', () => {
  const previous = {}
  let userData

  beforeEach(() => {
    for (const key of KEYS) {
      previous[key] = process.env[key]
      delete process.env[key]
    }
    resetCmcKeyStateForTests()
    mockSafeStorage.available = true
    mockApp.ready = true
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-key-'))
    mockApp.userData = userData
  })

  afterEach(() => {
    resetCmcKeyStateForTests()
    for (const key of KEYS) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    fs.rmSync(userData, { recursive: true, force: true })
  })

  it('refuses to save when OS encryption is unavailable', () => {
    mockSafeStorage.available = false

    const result = setSettingsCmcApiKey('settingsBBBBsecret')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/encryption/i)
    expect(fs.existsSync(getCmcKeyFilePath(userData))).toBe(false)
    expect(resolveCmcApiKey()).toBe('')
  })

  it('encrypts to userData and never returns the raw key in status', () => {
    const result = setSettingsCmcApiKey('settingsBBBBsecret')
    expect(result.ok).toBe(true)
    expect(result.status).toEqual({ source: 'settings', last4: 'cret' })
    expect(JSON.stringify(result)).not.toMatch(/settingsBBBB/)

    const filePath = path.join(userData, CMC_KEY_FILENAME)
    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf8')).toBe('enc:settingsBBBBsecret')
    expect(resolveCmcApiKey()).toBe('settingsBBBBsecret')

    const cleared = clearSettingsCmcApiKey()
    expect(cleared.ok).toBe(true)
    expect(cleared.status).toEqual({ source: 'none' })
    expect(fs.existsSync(filePath)).toBe(false)
    expect(resolveCmcApiKey()).toBe('')
  })

  it('does not delete the encrypted key file when the CMC feed is toggled off', () => {
    const result = setSettingsCmcApiKey('settingsBBBBsecret')
    expect(result.ok).toBe(true)

    const filePath = path.join(userData, CMC_KEY_FILENAME)
    expect(shouldUseCmcPriceFeed(false)).toBe(false)
    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf8')).toBe('enc:settingsBBBBsecret')
    expect(resolveCmcApiKey()).toBe('settingsBBBBsecret')
    expect(getCmcKeyStatus()).toEqual({ source: 'settings', last4: 'cret' })
  })
})
