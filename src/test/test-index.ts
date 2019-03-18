import * as net from 'net'
import { trackLeakedEvents } from '../index'
import { assert } from '../testing'
import { writeSync } from 'fs'
import { LeakedEventTracker } from '..'

function debug(msg: string) {
  writeSync(2, `DEBUG: ${msg}\n`)
}

async function assertLeaks(func: () => any, leakCount: number, res?: any) {
  const result = await trackLeakedEvents(func)
  if (result.result && result.result.cleanupFunc)
    await result.result.cleanupFunc()
  assert.containSubset(result, {
    leakedEventCount: leakCount,
    result: res
  })
  return result.result
}

const toTrack = [
  {
    name: 'timeout',
    leaky: () => {
      const cleanupPromise = new Promise(res => {
        setTimeout(() => {
          res()
        }, 10)
      })
      return {
        testResult: 'func result',
        cleanupFunc: () => cleanupPromise,
      }
    },
    notLeaky: () => {
      return new Promise(res => {
        setTimeout(() => res('not leaking'), 10)
      })
    },
  },

  {
    name: 'socket server listen',
    setup: () => {
      const server = net.createServer(socket => {})
      server.on('error', err => { throw err })

      return { server }
    },

    cleanupFunc: ({ server }) => {
      return new Promise(res => {
        server.close(() => res())
      })
    },

    leaky: ({ server }) => {
      server.listen(() => {})
      return {
        testResult: 'func result',
      }
    },

    notLeaky: ({ server }) => {
      return new Promise(res => {
        server.close(() => res('not leaking'))
      })
    },
  },

  {
    name: 'socket client',
    setup: () => {
      const server = net.createServer(socket => {})
      server.on('error', err => { throw err })

      return new Promise(res => {
        server.listen(() => {
          res({ server })
        })
      })
    },

    cleanupFunc: ({ server }) => {
      return new Promise(res => server.close(res))
    },

    leaky: ({ server }) => {
      return new Promise((res, rej) => {
        const client = net.createConnection({ port: server.address().port }, () => {
          res({
            testResult: 'func result',
            cleanupFunc: () => client.end(res),
          })
        })
        client.on('error', rej)
      })
    },

    notLeaky: ({ server }) => {
      return new Promise((res, rej) => {
        const client = net.createConnection({ port: server.address().port }, () => {
          client.end()
        })
        client.on('close', () => res('not leaking'))
      })
    },
  }
]

describe('tracked events', () => {
  toTrack.forEach(t => {
    describe(t.name, () => {
      async function runTrackedEventTest(func: (setupRes?: any) => any, leaks: number, expectedRes?: any) {
        const setupRes: any = await (t.setup? t.setup() : {})
        try {
          const res = await assertLeaks(() => func(setupRes), leaks, expectedRes)
        } finally {
          if (t.cleanupFunc)
            await t.cleanupFunc(setupRes)
        }
      }

      it('detects leak', () => runTrackedEventTest(t.leaky, 1, { testResult: 'func result' }))
      it('detects no leak', () => runTrackedEventTest(t.notLeaky, 0, 'not leaking'))
    })
  })
})

describe('setTimeout edge cases', () => {
  it('loop with incrementing timeout', async () => {
    for (let i = 0; i < 10; i += 1) {
      async function leaksSetTimeoutIncrementing() {
        setTimeout(() => {}, 50 + i)
        return `iteration: ${i}`
      }
      await assertLeaks(leaksSetTimeoutIncrementing, 1, `iteration: ${i}`)
    }
  })

  it('loop with consistent timeout', async () => {
    for (let i = 0; i < 10; i += 1) {
      async function leaksSetTimeoutConsistent() {
        setTimeout(() => {}, 60)
        return `iteration: ${i}`
      }
      await assertLeaks(leaksSetTimeoutConsistent, 1, `iteration: ${i}`)
    }
  })

  it('loop with consistent timeout and timeout before check', async () => {
    for (let i = 0; i < 10; i += 1) {
      async function leaksSetTimeoutConsistent() {
        setTimeout(() => {}, 70)
        return `iteration: ${i}`
      }
      await new Promise(res => setTimeout(res, 1))
      await assertLeaks(leaksSetTimeoutConsistent, 1, `iteration: ${i}`)
    }
  })

  it('nested leaks', async () => {
    async function leakNestedEvent() {
      await new Promise(res => {
        setTimeout(() => {
          setTimeout(() => {
            setTimeout(() => {}, 100)
            setTimeout(() => {}, 101)
            res()
          }, 1)
        }, 1)
      })
    }

    await assertLeaks(leakNestedEvent, 2)
  })
})

describe('with before/after', () => {
  const leakTracker = new LeakedEventTracker()

  before(() => leakTracker.start())
  after(() => {
    const res = leakTracker.stop()
    assert.equal(
      res.leakedEventCount, 0,
      `Leaked events: ${JSON.stringify(res, null, 2)}`,
    )
  })

  it('is a sync test', () => {})

  it('does not leak', async () => {
    await new Promise(res => setTimeout(res, 1))
  })

  it('leaks (this is expected to fail)', () => {
    setTimeout(() => {}, 74)
  })

})
