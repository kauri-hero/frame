import fs from 'fs'
import path from 'path'
import log from 'electron-log'

import { getCmcApiKey } from '../../env'

export const CMC_KEY_FILENAME = 'cmc-api-key.bin'

export type CmcKeySource = 'env' | 'settings' | 'none'

export type CmcKeyStatus = {
  source: CmcKeySource
  last4?: string
}

export type CmcKeyWriteResult =
  | { ok: true; status: CmcKeyStatus }
  | { ok: false; error: string; status: CmcKeyStatus }

type CmcKeyListener = () => void

let settingsKey = ''
const listeners = new Set<CmcKeyListener>()

export function resolveCmcApiKeyValue(envValue?: string | null, settingsValue?: string | null) {
  const env = (envValue || '').trim()
  if (env) return env
  return (settingsValue || '').trim()
}

export function resolveCmcApiKey() {
  return resolveCmcApiKeyValue(getCmcApiKey(), settingsKey)
}

export function isCmcPriceApiToggleOn(toggle?: boolean, hasKey = Boolean(resolveCmcApiKey())) {
  // First run (no stored value): enable CMC only when a key already exists so
  // current CMC users keep CMC; otherwise Pylon prices stay available.
  if (toggle === undefined) return hasKey
  return toggle === true
}

export function shouldUseCmcPriceFeed(toggle?: boolean) {
  const key = resolveCmcApiKey()
  return isCmcPriceApiToggleOn(toggle, Boolean(key)) && Boolean(key)
}

export function getCmcKeyStatus(): CmcKeyStatus {
  const env = getCmcApiKey()
  if (env) return statusFor('env', env)

  if (settingsKey) return statusFor('settings', settingsKey)

  return { source: 'none' }
}

export function onCmcKeyChange(listener: CmcKeyListener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getCmcKeyFilePath(userDataPath?: string) {
  if (userDataPath) return path.join(userDataPath, CMC_KEY_FILENAME)

  // Same pattern as cmc-rates.json: identity first, then Electron userData.
  require('../../identity')
  const electron = require('electron') as typeof import('electron')
  const userData = electron.app?.getPath?.('userData')
  if (!userData) {
    throw new Error('CMC API key file requires Electron userData after identity init')
  }
  return path.join(userData, CMC_KEY_FILENAME)
}

export function loadSettingsCmcApiKey() {
  const previous = settingsKey

  try {
    const { app, safeStorage } = require('electron') as typeof import('electron')
    if (!app?.isReady?.()) {
      log.warn('CMC Settings key not loaded; app is not ready')
      return getCmcKeyStatus()
    }
    if (!safeStorage?.isEncryptionAvailable?.()) {
      log.warn('CMC Settings key not loaded; OS encryption is unavailable')
      return getCmcKeyStatus()
    }

    const filePath = getCmcKeyFilePath()
    if (!fs.existsSync(filePath)) {
      settingsKey = ''
    } else {
      const decrypted = safeStorage.decryptString(fs.readFileSync(filePath)).trim()
      settingsKey = decrypted
      log.info('CMC Settings key loaded')
    }
  } catch (e) {
    settingsKey = ''
    log.warn('CMC Settings key decrypt failed', { message: e instanceof Error ? e.message : 'unknown' })
  }

  if (settingsKey !== previous) notifyCmcKeyChange()
  return getCmcKeyStatus()
}

export function setSettingsCmcApiKey(raw: unknown): CmcKeyWriteResult {
  const status = getCmcKeyStatus()
  if (getCmcApiKey()) {
    return { ok: false, error: 'Using env (CMC_API_KEY); Settings cannot replace it', status }
  }

  const key = typeof raw === 'string' ? raw.trim() : ''
  if (!key) {
    return { ok: false, error: 'Enter a CoinMarketCap API key', status }
  }

  try {
    const { app, safeStorage } = require('electron') as typeof import('electron')
    if (!app?.isReady?.()) {
      return { ok: false, error: 'Frame is not ready to save an API key yet', status }
    }
    if (!safeStorage?.isEncryptionAvailable?.()) {
      return {
        ok: false,
        error: 'OS encryption is unavailable on this machine. The API key cannot be saved in plaintext.',
        status
      }
    }

    writeKeyFile(getCmcKeyFilePath(), safeStorage.encryptString(key))
    settingsKey = key
    log.info('CMC Settings key saved')
    notifyCmcKeyChange()
    return { ok: true, status: getCmcKeyStatus() }
  } catch (e) {
    log.warn('CMC Settings key save failed', { message: e instanceof Error ? e.message : 'unknown' })
    return { ok: false, error: 'Could not encrypt and save the API key', status: getCmcKeyStatus() }
  }
}

export function clearSettingsCmcApiKey(): CmcKeyWriteResult {
  settingsKey = ''

  try {
    const filePath = getCmcKeyFilePath()
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    log.info('CMC Settings key cleared')
  } catch (e) {
    log.warn('CMC Settings key file not removed', { message: e instanceof Error ? e.message : 'unknown' })
  }

  notifyCmcKeyChange()
  return { ok: true, status: getCmcKeyStatus() }
}

export function setInMemorySettingsCmcApiKey(key: string) {
  settingsKey = (key || '').trim()
}

export function resetCmcKeyStateForTests() {
  settingsKey = ''
  listeners.clear()
}

function statusFor(source: Exclude<CmcKeySource, 'none'>, key: string): CmcKeyStatus {
  const last4 = keyLast4(key)
  return last4 ? { source, last4 } : { source }
}

function keyLast4(key: string) {
  if (key.length < 4) return undefined
  return key.slice(-4)
}

function notifyCmcKeyChange() {
  for (const listener of listeners) {
    try {
      listener()
    } catch (e) {
      log.warn('CMC key listener failed', { message: e instanceof Error ? e.message : 'unknown' })
    }
  }
}

function writeKeyFile(filePath: string, buf: Buffer) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  const tmp = `${filePath}.${process.pid}.tmp`
  // Buffer ≠ DOM ArrayBufferView in current TS/Electron typings; view the same bytes (pooled offset).
  fs.writeFileSync(tmp, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), { mode: 0o600 })
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    fs.renameSync(tmp, filePath)
  } catch (e) {
    try {
      fs.copyFileSync(tmp, filePath)
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // ignore
      }
    }
    if (!fs.existsSync(filePath)) throw e
  }
}
