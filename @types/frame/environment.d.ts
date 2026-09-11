import { KeyboardLayout } from '../../resources/keyboard'

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      BUNDLE_LOCATION: string
      NODE_ENV: 'test' | 'development' | 'production'
      // use this to override the log level in development
      LOG_LEVEL?: 'silly' | 'debug' | 'verbose' | 'info' | 'warn' | 'error'
      CMC_API_KEY?: string
      CMC_POLL_INTERVAL_MS?: string
      CMC_MAX_TOKENS?: string
      // Detached Chromium DevTools (never docked into the tray). --inspect stays for Node.
      // Dev: on unless 'false'. Prod: off unless 'true'. OPEN_DEVTOOLS wins if both are set.
      OPEN_DEVTOOLS?: 'true' | 'false'
      ENABLE_DEV_TOOLS?: 'true' | 'false'
    }
  }
  interface Navigator {
    keyboard: { getLayoutMap: () => Promise<KeyboardLayout> }
  }
}

export {}
