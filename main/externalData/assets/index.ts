import log from 'electron-log'

import Pylon, { AssetType } from '@framelabs/pylon-client'

import { isCmcPriceApiToggleOn, shouldUseCmcPriceFeed } from './cmcKey'
import { getAddress } from '../../../resources/utils'
import { createCmcPriceFeed } from './cmc'

import type { AssetId } from '@framelabs/pylon-client/dist/assetId'
import type { UsdRate } from '../../provider/assets'
import type { Rate, Token } from '../../store/state'

interface RateUpdate {
  id: AssetId
  data: {
    usd: number
    usd_24h_change: number
  }
}

function isPricedUsd(value: number) {
  return Number.isFinite(value) && value > 0
}

function tokenRateKeys(address: string) {
  return Array.from(new Set([address, address.toLowerCase(), getAddress(address)]))
}

export default function rates(pylon: Pylon, store: Store) {
  const storeApi = {
    getKnownTokens: (address?: Address) =>
      ((address && store('main.tokens.known', address)) || []) as Token[],
    getCustomTokens: () => (store('main.tokens.custom') || []) as Token[],
    setNativeCurrencyRate: (chainId: number, rate: Rate) =>
      store.setNativeCurrencyData('ethereum', chainId, { usd: rate }),
    setTokenRates: (rates: Record<Address, UsdRate>) => store.setRates(rates)
  }

  let pylonActive = false
  let lastChains: number[] = []
  let lastAddress: Address | undefined

  function cmcToggle() {
    return store('main.cmcPriceApiEnabled') as boolean | undefined
  }

  function cmcUiEnabled() {
    return isCmcPriceApiToggleOn(cmcToggle())
  }

  function useCmc() {
    return shouldUseCmcPriceFeed(cmcToggle())
  }

  function handleRatesUpdates(updates: RateUpdate[]) {
    if (updates.length === 0) return

    const nativeCurrencyUpdates = updates.filter(
      (u) => u.id.type === AssetType.NativeCurrency && isPricedUsd(u.data.usd)
    )

    if (nativeCurrencyUpdates.length > 0) {
      log.debug(`got currency rate updates for chains: ${nativeCurrencyUpdates.map((u) => u.id.chainId)}`)

      nativeCurrencyUpdates.forEach((u) => {
        storeApi.setNativeCurrencyRate(u.id.chainId, {
          price: u.data.usd,
          change24hr: u.data.usd_24h_change
        })
      })
    }

    const tokenUpdates = updates.filter((u) => u.id.type === AssetType.Token && isPricedUsd(u.data.usd))

    if (tokenUpdates.length > 0) {
      log.debug(`got token rate updates for addresses: ${tokenUpdates.map((u) => u.id.address)}`)

      const tokenRates = tokenUpdates.reduce((allRates, update) => {
        const address = update.id.address as string
        const rate = {
          usd: {
            price: update.data.usd,
            change24hr: update.data.usd_24h_change
          }
        }

        for (const key of tokenRateKeys(address)) {
          allRates[key] = rate
        }

        return allRates
      }, {} as Record<string, UsdRate>)

      storeApi.setTokenRates(tokenRates)
    }
  }

  const cmc = createCmcPriceFeed(store, (updates) => {
    if (!useCmc()) return
    handleRatesUpdates(updates)
  })

  function handlePylonRatesUpdates(updates: RateUpdate[]) {
    if (useCmc() || !pylonActive) return
    handleRatesUpdates(updates)
  }

  function stopPylonRates() {
    pylon.off('rates', handlePylonRatesUpdates)
    pylon.rates([])
    if (pylonActive) {
      log.info('stopped Pylon token USD rates')
    }
    pylonActive = false
  }

  function startPylonRates() {
    if (pylonActive) return
    pylon.on('rates', handlePylonRatesUpdates)
    pylonActive = true
  }

  function subscribePylon(chains: number[], address?: Address) {
    const subscribedCurrencies = chains.map((chainId) => ({ type: AssetType.NativeCurrency, chainId }))
    const knownTokens = storeApi.getKnownTokens(address).filter((token) => chains.includes(token.chainId))
    const customTokens = storeApi
      .getCustomTokens()
      .filter(
        (token) => !knownTokens.some((kt) => kt.address === token.address && kt.chainId === token.chainId)
      )

    const subscribedTokens = [...knownTokens, ...customTokens].map((token) => ({
      type: AssetType.Token,
      chainId: token.chainId,
      address: token.address
    }))

    setAssets([...subscribedCurrencies, ...subscribedTokens])
  }

  function applyFeed() {
    if (useCmc()) {
      stopPylonRates()
      log.info('using CoinMarketCap for token USD rates; Pylon rates stay unused while CMC Price API is enabled')
      cmc.start()
      cmc.updateSubscription(lastChains, lastAddress)
      return
    }

    if (cmcUiEnabled()) {
      stopPylonRates()
      log.info('no CMC API key; CMC polling and Pylon rates stay unused')
      cmc.start()
      return
    }

    cmc.stop()
    startPylonRates()
    subscribePylon(lastChains, lastAddress)
    log.info('using Pylon for token USD rates')
  }

  function updateSubscription(chains: number[], address?: Address) {
    lastChains = chains
    lastAddress = address

    if (useCmc()) {
      stopPylonRates()
      cmc.updateSubscription(chains, address)
      return
    }

    if (cmcUiEnabled()) {
      stopPylonRates()
      return
    }

    cmc.stop()
    startPylonRates()
    subscribePylon(chains, address)
  }

  function start() {
    applyFeed()
  }

  function applyResolvedKey() {
    applyFeed()
  }

  function stop() {
    cmc.stop()
    stopPylonRates()
  }

  function setAssets(assetIds: AssetId[]) {
    if (useCmc() || !pylonActive) {
      pylon.rates([])
      return
    }

    log.verbose(
      'subscribing to rates updates for native currencies on chains:',
      assetIds.filter((a) => a.type === AssetType.NativeCurrency).map((a) => a.chainId)
    )
    log.verbose(
      'subscribing to rates updates for tokens:',
      assetIds.filter((a) => a.type === AssetType.Token).map((a) => a.address)
    )

    pylon.rates(assetIds)
  }

  return {
    start,
    stop,
    setAssets,
    updateSubscription,
    applyResolvedKey
  }
}
