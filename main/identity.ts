import { app } from 'electron'
import path from 'path'

export const APP_SLUG = 'frame-fork'
export const APP_DISPLAY_NAME = 'Frame Fork'
export const RPC_PORT = 1248

if (app?.setName && app?.setPath && app?.getPath) {
  app.setName(APP_SLUG)
  app.setPath('userData', path.join(app.getPath('appData'), APP_SLUG))
}
