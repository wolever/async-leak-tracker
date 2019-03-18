import { trackLeakedEvents } from '../index'
import { assert } from '../testing'
import { writeSync } from 'fs'
import { LeakedEventTracker } from '..'

function debug(msg: string) {
  writeSync(2, `DEBUG: ${msg}\n`)
}

async function assertLeaks(func: () => any, leakCount: number, res?: any) {
  const result = await trackLeakedEvents(func)
  assert.containSubset(result, {
    leakedEventCount: leakCount,
    result: res
  })
  return result
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
        cleanupPromise,
      }
    },
    notLeaky: () => {
      return new Promise(res => {
        setTimeout(() => res('not leaking'), 10)
      })
    },
  },
]

describe('tracked events', () => {
  toTrack.forEach(t => {
    describe(t.name, () => {
      it('detects leak', async () => {
        await assertLeaks(t.leaky, 1, {
          testResult: 'func result',
        })
      })

      it('detects no leak', async () => {
        await assertLeaks(t.notLeaky, 0, 'not leaking')
      })
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
