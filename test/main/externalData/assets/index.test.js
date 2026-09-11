const mockCmcFeed = {
  start: jest.fn(),
  stop: jest.fn(),
  updateSubscription: jest.fn()
}

jest.mock('../../../../main/externalData/assets/cmc', () => ({
  createCmcPriceFeed: jest.fn(() => mockCmcFeed)
}))

import { AssetType } from '@framelabs/pylon-client'

import createRates from '../../../../main/externalData/assets'
import {
  resetCmcKeyStateForTests,
  resolveCmcApiKey,
  setInMemorySettingsCmcApiKey
} from '../../../../main/externalData/assets/cmcKey'

function createStore(cmcPriceApiEnabled) {
  let enabled = cmcPriceApiEnabled
  const store = jest.fn((path) => {
    if (path === 'main.cmcPriceApiEnabled') return enabled
    if (path === 'main.tokens.custom') return []
    return undefined
  })
  store.setCmcPriceApiEnabled = (value) => {
    enabled = value
  }
  store.setNativeCurrencyData = jest.fn()
  store.setRates = jest.fn()
  return store
}

describe('CMC / Pylon rate switching', () => {
  const previousKey = process.env.CMC_API_KEY
  let pylon
  let store
  let rates

  beforeEach(() => {
    delete process.env.CMC_API_KEY
    resetCmcKeyStateForTests()
    pylon = {
      on: jest.fn(),
      off: jest.fn(),
      rates: jest.fn()
    }
    store = createStore(true)
    rates = createRates(pylon, store)
  })

  afterEach(() => {
    rates?.stop()
    resetCmcKeyStateForTests()
    if (previousKey === undefined) delete process.env.CMC_API_KEY
    else process.env.CMC_API_KEY = previousKey
  })

  it('does not start Pylon rates when the toggle is on and no CMC key is set', () => {
    rates.start()

    expect(pylon.on).not.toHaveBeenCalled()
    expect(mockCmcFeed.start).toHaveBeenCalled()
  })

  it('starts Pylon when the toggle is off even if a Settings key is saved', () => {
    setInMemorySettingsCmcApiKey('settingsBBBBsecret')
    store.setCmcPriceApiEnabled(false)
    rates.start()
    rates.updateSubscription([1, 8453], '0x1111111111111111111111111111111111111111')

    expect(pylon.on).toHaveBeenCalledWith('rates', expect.any(Function))
    expect(pylon.rates).toHaveBeenCalledWith([
      { type: AssetType.NativeCurrency, chainId: 1 },
      { type: AssetType.NativeCurrency, chainId: 8453 }
    ])
    expect(mockCmcFeed.start).not.toHaveBeenCalled()
    expect(mockCmcFeed.updateSubscription).not.toHaveBeenCalled()
    expect(resolveCmcApiKey()).toBe('settingsBBBBsecret')
  })

  it('starts Pylon when the toggle is off even if an env key exists', () => {
    process.env.CMC_API_KEY = 'envAAAAsecret'
    store.setCmcPriceApiEnabled(false)
    rates.start()
    rates.updateSubscription([1])

    expect(pylon.on).toHaveBeenCalledWith('rates', expect.any(Function))
    expect(mockCmcFeed.start).not.toHaveBeenCalled()
    expect(resolveCmcApiKey()).toBe('envAAAAsecret')
  })

  it('starts CMC and drops any Pylon rates subscription when a Settings key appears', () => {
    rates.start()
    rates.updateSubscription([1, 8453], '0x1111111111111111111111111111111111111111')
    expect(pylon.rates).toHaveBeenCalledWith([])

    setInMemorySettingsCmcApiKey('settingsBBBBsecret')
    rates.applyResolvedKey()

    expect(pylon.off).toHaveBeenCalledWith('rates', expect.any(Function))
    expect(pylon.rates).toHaveBeenCalledWith([])
    expect(pylon.on).not.toHaveBeenCalled()
    expect(mockCmcFeed.start).toHaveBeenCalled()
    expect(mockCmcFeed.updateSubscription).toHaveBeenCalledWith(
      [1, 8453],
      '0x1111111111111111111111111111111111111111'
    )
  })

  it('stops CMC and does not start Pylon after the Settings key is cleared while the toggle stays on', () => {
    setInMemorySettingsCmcApiKey('settingsBBBBsecret')
    rates.start()
    mockCmcFeed.start.mockClear()
    mockCmcFeed.stop.mockClear()

    setInMemorySettingsCmcApiKey('')
    rates.applyResolvedKey()

    expect(mockCmcFeed.start).toHaveBeenCalled()
    expect(pylon.on).not.toHaveBeenCalled()
    expect(pylon.rates).toHaveBeenCalledWith([])
  })

  it('hot-switches from CMC to Pylon when the toggle is turned off without clearing the saved key', () => {
    setInMemorySettingsCmcApiKey('settingsBBBBsecret')
    rates.start()
    rates.updateSubscription([1], '0x1111111111111111111111111111111111111111')
    mockCmcFeed.start.mockClear()
    mockCmcFeed.stop.mockClear()
    pylon.on.mockClear()
    pylon.off.mockClear()
    pylon.rates.mockClear()

    store.setCmcPriceApiEnabled(false)
    rates.applyResolvedKey()

    expect(mockCmcFeed.stop).toHaveBeenCalled()
    expect(mockCmcFeed.start).not.toHaveBeenCalled()
    expect(pylon.on).toHaveBeenCalledWith('rates', expect.any(Function))
    expect(pylon.rates).toHaveBeenCalledWith([{ type: AssetType.NativeCurrency, chainId: 1 }])
    expect(resolveCmcApiKey()).toBe('settingsBBBBsecret')
  })

  it('hot-switches from Pylon to CMC when the toggle is turned on with a key', () => {
    setInMemorySettingsCmcApiKey('settingsBBBBsecret')
    store.setCmcPriceApiEnabled(false)
    rates.start()
    rates.updateSubscription([1, 8453], '0x1111111111111111111111111111111111111111')
    mockCmcFeed.start.mockClear()
    mockCmcFeed.stop.mockClear()
    pylon.on.mockClear()
    pylon.off.mockClear()
    pylon.rates.mockClear()

    store.setCmcPriceApiEnabled(true)
    rates.applyResolvedKey()

    expect(mockCmcFeed.start).toHaveBeenCalled()
    expect(mockCmcFeed.updateSubscription).toHaveBeenCalledWith(
      [1, 8453],
      '0x1111111111111111111111111111111111111111'
    )
    expect(pylon.off).toHaveBeenCalledWith('rates', expect.any(Function))
    expect(pylon.rates).toHaveBeenCalledWith([])
  })

  it('lets env win so a Settings key never arms Pylon while the toggle is on', () => {
    process.env.CMC_API_KEY = 'envAAAAsecret'
    setInMemorySettingsCmcApiKey('settingsBBBBsecret')
    rates.start()
    rates.updateSubscription([1])

    expect(pylon.on).not.toHaveBeenCalled()
    expect(mockCmcFeed.start).toHaveBeenCalled()
    expect(mockCmcFeed.updateSubscription).toHaveBeenCalledWith([1], undefined)
  })

  it('uses Pylon on first run when no toggle is stored and no key exists', () => {
    store.setCmcPriceApiEnabled(undefined)
    rates.start()
    rates.updateSubscription([1])

    expect(pylon.on).toHaveBeenCalledWith('rates', expect.any(Function))
    expect(mockCmcFeed.start).not.toHaveBeenCalled()
  })

  it('uses CMC on first run when no toggle is stored and a key already exists', () => {
    store.setCmcPriceApiEnabled(undefined)
    setInMemorySettingsCmcApiKey('settingsBBBBsecret')
    rates.start()
    rates.updateSubscription([1])

    expect(pylon.on).not.toHaveBeenCalled()
    expect(mockCmcFeed.start).toHaveBeenCalled()
    expect(mockCmcFeed.updateSubscription).toHaveBeenCalledWith([1], undefined)
  })
})
