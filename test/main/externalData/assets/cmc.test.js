import {
  applySymbolQuotes,
  collectQuoteSymbols,
  extractUsdQuote,
  fingerprintTargets,
  flattenCmcInfo,
  hasPositiveBalance,
  isCmcQuoteSymbol,
  matchCmcId,
  normalizeQuoteAssets,
  platformMatches,
  selectRateTargets,
  targetKey
} from '../../../../main/externalData/assets/cmc'

const VVV = '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf'

describe('hasPositiveBalance', () => {
  it('treats hex zero as empty', () => {
    expect(hasPositiveBalance('0x0')).toBe(false)
    expect(hasPositiveBalance('0x00')).toBe(false)
  })

  it('treats a positive hex balance as held', () => {
    expect(hasPositiveBalance('0x1')).toBe(true)
  })
})

describe('selectRateTargets', () => {
  const isTestnet = (chainId) => chainId === 84532 || chainId === 11155111

  it('includes natives and held tokens, keeps custom, then caps known extras', () => {
    const selection = selectRateTargets({
      connectedChainIds: [1, 8453, 84532],
      isTestnet,
      maxTokens: 2,
      balances: [
        { chainId: 8453, address: VVV, balance: '0x10', symbol: 'VVV' },
        { chainId: 8453, address: '0x1111111111111111111111111111111111111111', balance: '0x0', symbol: 'DUST' }
      ],
      customTokens: [{ chainId: 8453, address: '0x2222222222222222222222222222222222222222', symbol: 'FOO' }],
      knownTokens: [{ chainId: 1, address: '0x3333333333333333333333333333333333333333', symbol: 'BAR' }]
    })

    expect(selection.natives).toBe(2)
    expect(selection.tokens).toBe(2)
    expect(selection.custom).toBe(1)
    expect(selection.customSymbols).toEqual(['FOO'])
    expect(selection.capped).toBe(true)
    expect(selection.skipped).toBe(1)
    expect(
      selection.targets.filter((target) => target.type === 'native').map((target) => target.chainId)
    ).toEqual([1, 8453])
    expect(selection.targets.find((target) => target.symbol === 'VVV').address).toBe(VVV)
    expect(collectQuoteSymbols(selection.targets)).toEqual(['ETH', 'VVV', 'FOO'])
  })

  it('reserves custom tokens inside the cap instead of appending past it', () => {
    const held = Array.from({ length: 40 }, (_, i) => ({
      chainId: 1,
      address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      balance: '0x10',
      symbol: `H${i}`
    }))

    const selection = selectRateTargets({
      connectedChainIds: [1, '8453'],
      isTestnet,
      maxTokens: 40,
      balances: held,
      customTokens: [{ chainId: '8453', address: VVV.toUpperCase(), symbol: 'vvv' }]
    })

    const tokenTargets = selection.targets.filter((target) => target.type === 'token')
    expect(tokenTargets).toHaveLength(40)
    expect(tokenTargets.filter((target) => target.source === 'held')).toHaveLength(39)
    expect(tokenTargets.some((target) => target.address === VVV && target.symbol === 'VVV')).toBe(true)
    expect(selection.customSymbols).toEqual(['VVV'])
    expect(collectQuoteSymbols(selection.targets)).toContain('VVV')
    expect(collectQuoteSymbols(selection.targets)).toContain('ETH')
  })

  it('skips sparse custom rows and non-string addresses without throwing', () => {
    const selection = selectRateTargets({
      connectedChainIds: ['8453', 1],
      isTestnet,
      customTokens: [
        null,
        { chainId: '8453', address: 12345, symbol: 'BAD' },
        { chainId: '8453', address: VVV, symbol: 'VVV' }
      ],
      knownTokens: undefined
    })

    expect(selection.customSymbols).toEqual(['VVV'])
    expect(collectQuoteSymbols(selection.targets)).toEqual(['ETH', 'VVV'])
  })

  it('keeps a custom token even when the known list far exceeds the cap', () => {
    const knownTokens = Array.from({ length: 60 }, (_, i) => ({
      chainId: 1,
      address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      symbol: `K${i}`
    }))

    const selection = selectRateTargets({
      connectedChainIds: ['8453', 1],
      isTestnet,
      maxTokens: 40,
      customTokens: [{ chainId: '8453', address: VVV.toUpperCase(), symbol: 'vvv' }],
      knownTokens
    })

    const tokenTargets = selection.targets.filter((target) => target.type === 'token')
    expect(tokenTargets).toHaveLength(40)
    expect(tokenTargets.some((target) => target.address === VVV && target.symbol === 'VVV')).toBe(true)
    expect(selection.customSymbols).toEqual(['VVV'])
    expect(collectQuoteSymbols(selection.targets)).toContain('VVV')
    expect(selection.capped).toBe(true)
    expect(selection.skipped).toBe(21)
  })

  it('skips unmapped and testnet chains', () => {
    const selection = selectRateTargets({
      connectedChainIds: [84532, 999999],
      isTestnet,
      balances: [{ chainId: 84532, address: VVV, balance: '0x10' }]
    })

    expect(selection.targets).toEqual([])
  })
})

describe('CMC info matching', () => {
  it('flattens address-keyed and array payloads', () => {
    const infos = flattenCmcInfo({
      [VVV]: {
        id: 31848,
        platform: { slug: 'base', token_address: VVV }
      }
    })

    expect(infos[0].id).toBe(31848)
    expect(flattenCmcInfo([{ id: 1 }])).toEqual([{ id: 1 }])
  })

  it('prefers the Base listing when the same address is ambiguous', () => {
    const cmcId = matchCmcId(
      [
        {
          id: 1,
          cmc_rank: 1,
          platform: { slug: 'ethereum', token_address: VVV }
        },
        {
          id: 31848,
          cmc_rank: 200,
          platform: { slug: 'base', token_address: VVV }
        }
      ],
      VVV,
      8453
    )

    expect(cmcId).toBe(31848)
    expect(platformMatches(8453, { slug: 'base' })).toBe(true)
  })

  it('matches a contract_address deployment when the primary platform differs', () => {
    const cmcId = matchCmcId(
      [
        {
          id: 3408,
          symbol: 'USDC',
          platform: { slug: 'zksync', token_address: '0x1111111111111111111111111111111111111111' },
          contract_address: [
            { contract_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', platform: { slug: 'base' } }
          ]
        }
      ],
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      8453
    )

    expect(cmcId).toBe(3408)
  })
})

describe('CMC symbol filter', () => {
  it('keeps ETH/POL/VVV and drops junk tickers that would 400 a batch', () => {
    expect(isCmcQuoteSymbol('ETH')).toBe(true)
    expect(isCmcQuoteSymbol('POL')).toBe(true)
    expect(isCmcQuoteSymbol('VVV')).toBe(true)
    expect(isCmcQuoteSymbol('BASE.VULT')).toBe(false)
    expect(isCmcQuoteSymbol('USD COIN')).toBe(false)

    expect(
      collectQuoteSymbols([
        { type: 'native', chainId: 1 },
        { type: 'token', chainId: 8453, address: VVV, symbol: 'VVV', source: 'custom' },
        {
          type: 'token',
          chainId: 8453,
          address: '0x1111111111111111111111111111111111111111',
          symbol: 'BASE.VULT',
          source: 'custom'
        }
      ])
    ).toEqual(['ETH', 'VVV'])
  })
})

describe('quote parsing', () => {
  it('reads v3 array quotes and legacy USD objects', () => {
    expect(
      extractUsdQuote({
        quote: [{ symbol: 'USD', price: 22.4, percent_change_24h: 1.5 }]
      })
    ).toEqual({ usd: 22.4, usd_24h_change: 1.5 })

    expect(
      extractUsdQuote({
        quote: { USD: { price: 7.21, percent_change_24h: -2 } }
      })
    ).toEqual({ usd: 7.21, usd_24h_change: -2 })

    expect(extractUsdQuote({ quote: { USD: { price: 0, percent_change_24h: 0 } } })).toBeUndefined()

    expect(
      extractUsdQuote({
        quotes: [{ quote: { USD: { price: 2460, percent_change_24h: 1 } } }]
      })
    ).toEqual({ usd: 2460, usd_24h_change: 1 })
  })

  it('normalizes both array and id-keyed quote payloads', () => {
    const quotes = normalizeQuoteAssets({
      1027: { id: 1027, quote: { USD: { price: 3300, percent_change_24h: 0.2 } } }
    })

    expect(quotes).toEqual([{ id: 1027, usd: 3300, usd_24h_change: 0.2 }])
    expect(
      normalizeQuoteAssets([
        { id: 1027, symbol: 'ETH', quote: { USD: { price: 2460, percent_change_24h: 1 } } },
        { id: 28321, symbol: 'POL', quote: { USD: { price: 0.27, percent_change_24h: -1 } } }
      ]).map((quote) => quote.symbol)
    ).toEqual(['ETH', 'POL'])
  })
})

describe('symbol quote mapping', () => {
  it('applies one USDC quote to every matching held address and ETH to each ETH native', () => {
    const updates = applySymbolQuotes(
      [
        { type: 'native', chainId: 1 },
        { type: 'native', chainId: 8453 },
        { type: 'native', chainId: 137 },
        { type: 'token', chainId: 8453, address: VVV, symbol: 'VVV' },
        {
          type: 'token',
          chainId: 8453,
          address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          symbol: 'USDC'
        },
        {
          type: 'token',
          chainId: 1,
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          symbol: 'usdc'
        }
      ],
      [
        { symbol: 'ETH', usd: 2460, usd_24h_change: 1 },
        { symbol: 'POL', usd: 0.27, usd_24h_change: -1 },
        { symbol: 'VVV', usd: 22.4, usd_24h_change: 3 },
        { symbol: 'USDC', usd: 1, usd_24h_change: 0 }
      ]
    )

    expect(updates.filter((update) => update.id.type === 0).map((update) => update.id.chainId)).toEqual([
      1, 8453, 137
    ])
    expect(updates.find((update) => update.id.address === VVV).data.usd).toBe(22.4)
    expect(updates.filter((update) => update.data.usd === 1)).toHaveLength(2)
  })

  it('maps a checksummed Base custom address when CMC keys the quote by VVV', () => {
    const checksummed = '0xacFE6019Ed1A7Dc6f7B508C02d1b04EC88cC21bf'
    const quotes = normalizeQuoteAssets({
      VVV: {
        id: 31848,
        quote: { USD: { price: 22.4, percent_change_24h: 3 } },
        platform: { slug: 'base', token_address: checksummed }
      }
    })

    const updates = applySymbolQuotes(
      [{ type: 'token', chainId: 8453, address: checksummed, symbol: 'VVV' }],
      quotes
    )

    expect(quotes[0].symbol).toBe('VVV')
    expect(quotes[0].addresses).toEqual([VVV])
    expect(quotes[0].chainIds).toEqual([8453])
    expect(updates).toEqual([
      {
        id: { type: 1, chainId: 8453, address: VVV },
        data: { usd: 22.4, usd_24h_change: 3 }
      }
    ])
  })
})

describe('subscription fingerprint', () => {
  it('is stable regardless of target order', () => {
    const a = [
      { type: 'native', chainId: 8453 },
      { type: 'token', chainId: 8453, address: VVV }
    ]
    const b = [
      { type: 'token', chainId: 8453, address: VVV.toUpperCase() },
      { type: 'native', chainId: 8453 }
    ]

    expect(fingerprintTargets(a)).toBe(fingerprintTargets(b))
    expect(targetKey(b[0])).toBe(`t:8453:${VVV}`)
  })
})
