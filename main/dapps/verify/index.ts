// A modified version of ipfs-only-hash, https://github.com/alanshaw/ipfs-only-hash/issues/18

import path from 'path'
import fs from 'fs/promises'
import { app } from 'electron'
import { globSource } from 'ipfs-http-client'
import { importer } from 'ipfs-unixfs-importer'

import type { UserImporterOptions } from 'ipfs-unixfs-importer/types'

const blockstore = {
  get: async (cid: string) => {
    throw new Error(`unexpected block API get for ${cid}`)
  },
  put: async () => {
    throw new Error('unexpected block API put')
  }
}

const hash = async (content: any, opts: UserImporterOptions = {}) => {
  const options = {
    ...opts,
    onlyHash: true,
    cidVersion: 0,
    hidden: true
  } as const

  let lastCID

  for await (const c of importer(content, blockstore as any, options)) {
    lastCID = c.cid
  }

  return lastCID
}

const hashFiles = async (path: string, options: UserImporterOptions) => hash(globSource(path, '**'), options)
const getCID = async (path: string, isDirectory = true) => hashFiles(path, { wrapWithDirectory: isDirectory })

export function getDappCacheDir() {
  return path.join(app.getPath('userData'), 'DappCache')
}

export function getCachedDappPath(dappId: string) {
  return path.join(getDappCacheDir(), dappId)
}

// Older persist snapshots stored content as `/ipfs/<cid>`; current records store the bare CID.
export function normalizeContentCID(contentCID: string) {
  return contentCID.replace(/^\/ipfs\//, '')
}

export async function dappPathExists(dappId: string) {
  const cachedDappPath = getCachedDappPath(dappId)

  try {
    await fs.access(cachedDappPath)
    return true
  } catch (e) {
    return false
  }
}

export async function isDappVerified(dappId: string, contentCID: string) {
  const cachedDappPath = getCachedDappPath(dappId)
  const cid = await getCID(cachedDappPath)

  return cid?.toV1().toString() === normalizeContentCID(contentCID)
}
