// Pause CMC quotes/latest while Frame is hidden or the machine is idle,
// locked, or asleep. tray.open is the same visibility flag the balance
// scanner already uses; dash/onboard/notify/frames count as in-use.
// selected.minimized is the account panel, not OS minimize — do not treat
// it as "app hidden".

export type CmcPollActivity = {
  isPaused: () => boolean
  subscribe: (listener: (paused: boolean) => void) => () => void
}

export const CMC_IDLE_THRESHOLD_SECONDS = 60
export const CMC_IDLE_CHECK_INTERVAL_MS = 5_000

const POWER_EVENTS = [
  'suspend',
  'resume',
  'lock-screen',
  'unlock-screen',
  'user-did-become-active',
  'user-did-resign-active'
] as const

type PowerMonitorLike = {
  on?: (event: string, listener: () => void) => void
  removeListener?: (event: string, listener: () => void) => void
  getSystemIdleState?: (idleThresholdSeconds: number) => string
}

export function isCmcPollPaused(input: {
  trayOpen?: boolean
  dashShowing?: boolean
  onboardShowing?: boolean
  notifyShowing?: boolean
  framesOpen?: boolean
  idleState?: string
  asleep?: boolean
  locked?: boolean
}) {
  const visible = Boolean(
    input.trayOpen || input.dashShowing || input.onboardShowing || input.notifyShowing || input.framesOpen
  )
  if (!visible) return true
  if (input.asleep || input.locked) return true
  return input.idleState === 'idle' || input.idleState === 'locked'
}

function loadPowerMonitor(): PowerMonitorLike | undefined {
  try {
    // Lazy require so unit tests can inject a fake powerMonitor.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as typeof import('electron')
    return electron.powerMonitor as PowerMonitorLike
  } catch {
    return undefined
  }
}

function framesAreOpen(frames: unknown) {
  return Boolean(frames && typeof frames === 'object' && Object.keys(frames as object).length > 0)
}

export function createCmcPollActivity(
  store: Store,
  opts?: {
    powerMonitor?: PowerMonitorLike
    idleThresholdSeconds?: number
    idleCheckIntervalMs?: number
  }
): CmcPollActivity {
  const idleThreshold = opts?.idleThresholdSeconds ?? CMC_IDLE_THRESHOLD_SECONDS
  const idleCheckIntervalMs = opts?.idleCheckIntervalMs ?? CMC_IDLE_CHECK_INTERVAL_MS
  const power = opts?.powerMonitor ?? loadPowerMonitor()

  let asleep = false
  let locked = false

  function readPaused() {
    let idleState: string | undefined
    try {
      idleState = power?.getSystemIdleState?.(idleThreshold)
    } catch {
      idleState = undefined
    }

    return isCmcPollPaused({
      trayOpen: Boolean(store('tray.open')),
      dashShowing: Boolean(store('windows.dash.showing')),
      onboardShowing: Boolean(store('windows.onboard.showing')),
      notifyShowing: Boolean(store('windows.notify.showing')),
      framesOpen: framesAreOpen(store('main.frames')),
      idleState,
      asleep,
      locked
    })
  }

  return {
    isPaused: readPaused,
    subscribe(listener) {
      let previous = readPaused()
      listener(previous)

      const emit = () => {
        const next = readPaused()
        if (next === previous) return
        previous = next
        listener(next)
      }

      const handlers: Array<[string, () => void]> = []
      if (power?.on) {
        for (const event of POWER_EVENTS) {
          const handler = () => {
            if (event === 'suspend') asleep = true
            if (event === 'resume') asleep = false
            if (event === 'lock-screen') locked = true
            if (event === 'unlock-screen') locked = false
            emit()
          }
          power.on(event, handler)
          handlers.push([event, handler])
        }
      }

      const observer =
        typeof store.observer === 'function'
          ? store.observer(() => {
              store('tray.open')
              store('windows.dash.showing')
              store('windows.onboard.showing')
              store('windows.notify.showing')
              store('main.frames')
              emit()
            }, 'cmc:pollActivity')
          : undefined

      const interval = setInterval(emit, idleCheckIntervalMs) as NodeJS.Timeout
      if (typeof interval.unref === 'function') interval.unref()

      return () => {
        observer?.remove()
        clearInterval(interval)
        if (power?.removeListener) {
          for (const [event, handler] of handlers) {
            power.removeListener(event, handler)
          }
        }
      }
    }
  }
}
