import { writeSync } from 'fs'
import * as async_hooks from 'async_hooks'

export interface LeakedEvent {
  timestamp: Date
  asyncID: number
  stack: string[]
}

function containsAny(needle: string, haystacks: string[]) {
  for (const h of haystacks) {
    if (needle.indexOf(h) >= 0)
      return true
  }

  return false
}

export class LeakedEventTrackerOptions {
  debug = !!process.env.DEBUG

  // Only track async events triggered by these methods.
  eventsToTrack = [
    'Timer.emitInitNative',
    'FSReqWrap.emitInitNative',
    'TCP.emitInitNative',
  ]

  // Ignore any events triggered by these methods
  eventsToIgnore = [
    // Mocha's timeout timer for async tests
    'Test.Runnable.resetTimeout',
    'Hook.Runnable.resetTimeout',
  ]
}

export interface LeakedEventsResult {
  leakedEventCount: number
  leakedEvents: LeakedEvent[]
}

export class LeakedEventTracker {
  public opts: LeakedEventTrackerOptions

  constructor(opts?: Partial<LeakedEventTrackerOptions>) {
    this.opts = {
      ...(new LeakedEventTrackerOptions()),
      ...(opts || {})
    }
  }

  debug(msg: string) {
    if (!this.opts.debug)
      return
    writeSync(2, `DEBUG: ${msg}\n`)
  }

  debugShowStack() {
    if (!this.opts.debug)
      return
    const stack = (new Error()).stack!
    this.debug('Stack:\n' + stack.split('\n').slice(2).join('\n'))
  }

  shouldTrackEventStack(stack: string[]) {
    // Only consider stack frames below the call to ``run`` by looking for
    // the magical name $$LeakedEventTrackerFunctionCaller$$
    let foundSentinal = false
    const stackStr = stack
      .filter(line => {
        if (foundSentinal)
          return false
        
        foundSentinal = line.indexOf(this.$$LeakedEventTrackerFunctionCaller$$.name) >= 0
        return true
      })
      .join('\n')

    if (containsAny(stackStr, this.opts.eventsToIgnore))
      return false

    return containsAny(stackStr, this.opts.eventsToTrack)
  }

  async $$LeakedEventTrackerFunctionCaller$$(f) {
    return await f()
  }

  // See note about currentRun mutability in start()
  currentRun!: {
    done: boolean,
    seen: Set<number>,
    leakedEventsById: { [key: string]: LeakedEvent },
  }

  async start() {
    if (this.currentRun && !this.currentRun.done)
      throw new Error('Already running!')

    this.currentRun = {
      done: false,
      seen: new Set(),
      leakedEventsById: {},
    }

    // Note: to aid debugging, the asyncHook is only removed once all the
    // events seen during the run have been destroyed. A copy of ``currentRun``
    // is made here and the local references are used for mutations so that
    // subsequent runs can be started while events from a previous run are
    // still waiting to be cleaned up.
    // This incurs a fairly significant overhead, though, it it should probably
    // be changed at some point.
    let { done, seen, leakedEventsById } = this.currentRun

    const asyncHook = async_hooks.createHook({
      init: (asyncID) => {
        if (done)
          return
        seen.add(asyncID)

        const stack = (new Error()).stack!.split('\n').slice(2)
        if (this.shouldTrackEventStack(stack)) {
          leakedEventsById[asyncID] = {
            timestamp: new Date(),
            asyncID,
            stack,
          }
        }
        this.debug(`init: ${asyncID} (tracked: ${asyncID in leakedEventsById})`)
        this.debugShowStack()
      },

      before: (asyncID) => {
        if (!seen.has(asyncID))
          return

        this.debug(`before: ${asyncID} (tracked: ${asyncID in leakedEventsById})`)
        this.debugShowStack()
      },
      after: (asyncID) => {
        if (!seen.has(asyncID))
          return

        this.debug(`after: ${asyncID} (tracked: ${asyncID in leakedEventsById})`)
        this.debugShowStack()
        delete leakedEventsById[asyncID]
      },
      destroy: (asyncID) => {
        if (!seen.has(asyncID))
          return

        seen.delete(asyncID)
        if (done && seen.size == 0)
          asyncHook.disable()

        this.debug(`destroy: ${asyncID} (tracked: ${asyncID in leakedEventsById})`)
        this.debugShowStack()
      },
    })

    asyncHook.enable()
  }

  stop() {
    if (!this.currentRun)
      throw new Error('Not running!')
    this.currentRun.done = true
    const leakedEvents = Object.values(this.currentRun.leakedEventsById)
    return {
      leakedEventCount: leakedEvents.length,
      leakedEvents,
    }
  }

  async run<T>(func: () => T): Promise<LeakedEventsResult & { result: T }> {
    this.start()
    let result
    let leaks
    try {
      this.debug(`+++ calling: ${func.name || '(anonymous function)'}`)
      result = await this.$$LeakedEventTrackerFunctionCaller$$(func)
    } catch (e) {
      result = Promise.reject(e)
    } finally {
      leaks = this.stop()
    }
    
    return {
      ...leaks,
      result,
    }
  }
}

export function trackLeakedEvents<T>(f: () => T) {
  return new LeakedEventTracker().run(f)
}
