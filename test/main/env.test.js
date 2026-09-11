import { getCmcApiKey, getCmcMaxTokens, getCmcPollIntervalMs } from '../../main/env'

const KEYS = ['CMC_API_KEY', 'CMC_POLL_INTERVAL_MS', 'CMC_MAX_TOKENS']

describe('CMC env helpers', () => {
  const previous = {}

  beforeEach(() => {
    for (const key of KEYS) {
      previous[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of KEYS) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })

  it('reads a trimmed API key and treats blanks as unset', () => {
    process.env.CMC_API_KEY = '  abc123  '
    expect(getCmcApiKey()).toBe('abc123')

    process.env.CMC_API_KEY = '   '
    expect(getCmcApiKey()).toBe('')
  })

  it('clamps the poll interval to at least one minute', () => {
    expect(getCmcPollIntervalMs()).toBe(5 * 60_000)

    process.env.CMC_POLL_INTERVAL_MS = '10000'
    expect(getCmcPollIntervalMs()).toBe(60_000)

    process.env.CMC_POLL_INTERVAL_MS = '600000'
    expect(getCmcPollIntervalMs()).toBe(600_000)
  })

  it('caps the token list at 200', () => {
    expect(getCmcMaxTokens()).toBe(40)

    process.env.CMC_MAX_TOKENS = '999'
    expect(getCmcMaxTokens()).toBe(200)
  })
})
