import log from 'electron-log'

import Pylon, { AssetType } from '@framelabs/pylon-client'

import { getCmcApiKey } from '../../env'
import { getAddress } from '../../../resources/utils'
import { createCmcPriceFeed } from './cmc'

import type { AssetId } from '@framelabs/pylon-client/dist/assetId'
import type { UsdRate } from '../../provider/assets'
import type { NativeCurrency, Rate, Token } from '../../store/state'

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
    setNativeCurrencyData: (chainId: number, currencyData: NativeCurrency) =>
      store.setNativeCurrencyData('ethereum', chainId, currencyData),
    setNativeCurrencyRate: (chainId: number, rate: Rate) =>
      store.setNativeCurrencyData('ethereum', chainId, { usd: rate }),
    setTokenRates: (rates: Record<Address, UsdRate>) => store.setRates(rates)
  }

  let pylonActive = false
  let lastChains: number[] = []
  let lastAddress: Address | undefined

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

  const cmc = createCmcPriceFeed(store, handleRatesUpdates, fallbackToPylon)

  function useCmc() {
    return Boolean(getCmcApiKey())
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

  function startPylonRates() {
    if (pylonActive) return
    pylonActive = true
    log.info('using Pylon for token USD rates')
    pylon.on('rates', handleRatesUpdates)
  }

  function fallbackToPylon(reason: string) {
    if (pylonActive) return
    log.warn('CMC unavailable, falling back to Pylon', { reason })
    cmc.stop()
    startPylonRates()
    subscribePylon(lastChains, lastAddress)
  }

  function updateSubscription(chains: number[], address?: Address) {
    lastChains = chains
    lastAddress = address

    if (useCmc() && !pylonActive) {
      cmc.updateSubscription(chains, address)
      return
    }

    subscribePylon(chains, address)
  }

  function start() {
    if (useCmc()) {
      log.info('using CoinMarketCap for token USD rates; Pylon rates stay unused while CMC_API_KEY is set')
      cmc.start()
      return
    }

    log.verbose('starting asset updates')
    startPylonRates()
  }

  function stop() {
    cmc.stop()

    if (pylonActive) {
      log.verbose('stopping asset updates')
      pylon.off('rates', handleRatesUpdates)
      pylon.rates([])
      pylonActive = false
    }
  }

  function setAssets(assetIds: AssetId[]) {
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
    updateSubscription
  }
}
