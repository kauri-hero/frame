import {
  CMC_IDLE_CHECK_INTERVAL_MS,
  CMC_IDLE_THRESHOLD_SECONDS,
  createCmcPollActivity,
  isCmcPollPaused
} from '../../../../main/externalData/assets/cmcPollActivity'

describe('isCmcPollPaused', () => {
  it('pauses when the tray is hidden and no other Frame window is showing', () => {
    expect(isCmcPollPaused({ trayOpen: false })).toBe(true)
    expect(isCmcPollPaused({ trayOpen: true, idleState: 'active' })).toBe(false)
  })

  it('stays active when the dash, onboard, notify, or a frame is showing', () => {
    expect(isCmcPollPaused({ trayOpen: false, dashShowing: true, idleState: 'active' })).toBe(false)
    expect(isCmcPollPaused({ trayOpen: false, onboardShowing: true, idleState: 'active' })).toBe(false)
    expect(isCmcPollPaused({ trayOpen: false, notifyShowing: true, idleState: 'active' })).toBe(false)
    expect(isCmcPollPaused({ trayOpen: false, framesOpen: true, idleState: 'active' })).toBe(false)
  })

  it('pauses while the system is idle, locked, or asleep even if the tray is open', () => {
    expect(isCmcPollPaused({ trayOpen: true, idleState: 'idle' })).toBe(true)
    expect(isCmcPollPaused({ trayOpen: true, idleState: 'locked' })).toBe(true)
    expect(isCmcPollPaused({ trayOpen: true, idleState: 'active', locked: true })).toBe(true)
    expect(isCmcPollPaused({ trayOpen: true, idleState: 'active', asleep: true })).toBe(true)
    expect(isCmcPollPaused({ trayOpen: true, idleState: 'unknown' })).toBe(false)
  })
})

describe('createCmcPollActivity', () => {
  function createStore(state) {
    const store = (path) =>
      String(path)
        .split('.')
        .reduce((acc, key) => acc?.[key], state)

    let observerCb
    store.observer = (cb) => {
      observerCb = cb
      cb()
      return {
        remove: () => {
          observerCb = undefined
        }
      }
    }
    store.fire = () => observerCb?.()
    return store
  }

  function createPower(idleState = 'active') {
    const listeners = {}
    return {
      idleState,
      listeners,
      on: jest.fn((event, handler) => {
        listeners[event] = listeners[event] || []
        listeners[event].push(handler)
      }),
      removeListener: jest.fn((event, handler) => {
        listeners[event] = (listeners[event] || []).filter((cb) => cb !== handler)
      }),
      getSystemIdleState: jest.fn(() => idleState),
      emit(event) {
        for (const handler of listeners[event] || []) handler()
      }
    }
  }

  it('notifies when the tray hides and when the system becomes idle', () => {
    const state = {
      tray: { open: true },
      windows: { dash: { showing: false }, onboard: { showing: false }, notify: { showing: false } },
      main: { frames: {} }
    }
    const store = createStore(state)
    const power = createPower('active')
    const activity = createCmcPollActivity(store, {
      powerMonitor: power,
      idleThresholdSeconds: CMC_IDLE_THRESHOLD_SECONDS,
      idleCheckIntervalMs: CMC_IDLE_CHECK_INTERVAL_MS
    })
    const listener = jest.fn()
    const stop = activity.subscribe(listener)

    expect(listener).toHaveBeenCalledWith(false)
    expect(activity.isPaused()).toBe(false)

    state.tray.open = false
    store.fire()
    expect(listener).toHaveBeenLastCalledWith(true)
    expect(activity.isPaused()).toBe(true)

    state.tray.open = true
    store.fire()
    expect(listener).toHaveBeenLastCalledWith(false)

    power.idleState = 'idle'
    power.getSystemIdleState.mockImplementation(() => 'idle')
    jest.advanceTimersByTime(CMC_IDLE_CHECK_INTERVAL_MS)
    expect(listener).toHaveBeenLastCalledWith(true)
    expect(activity.isPaused()).toBe(true)

    stop()
  })

  it('pauses on lock-screen and suspend, and resumes on unlock and resume', () => {
    const state = {
      tray: { open: true },
      windows: { dash: { showing: false }, onboard: { showing: false }, notify: { showing: false } },
      main: { frames: {} }
    }
    const store = createStore(state)
    const power = createPower('active')
    const activity = createCmcPollActivity(store, { powerMonitor: power })
    const listener = jest.fn()
    const stop = activity.subscribe(listener)

    power.emit('lock-screen')
    expect(activity.isPaused()).toBe(true)
    expect(listener).toHaveBeenLastCalledWith(true)

    power.emit('unlock-screen')
    expect(activity.isPaused()).toBe(false)
    expect(listener).toHaveBeenLastCalledWith(false)

    power.emit('suspend')
    expect(activity.isPaused()).toBe(true)

    power.emit('resume')
    expect(activity.isPaused()).toBe(false)

    stop()
    expect(power.removeListener).toHaveBeenCalled()
  })
})
