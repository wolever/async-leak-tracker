``async-leak-tracker`` tracks leaks of async events
===================================================

*VERY ALPHA WARNING*: this software is *very alpha* and probably doesn't work
very well yet.

``async-leak-tracker`` tracks leaks of async events in Node applications.

For example::

    $ cat leaky.js
    import { trackLeakedEvents } from 'async-leak-tracker'

    function leakSetTimeout() {
      setTimeout(() => { console.log('this leaked!') }, 100)
      return 'done!'
    }

    async function run() {
      const result = await trackLeakedEvents(leakSetTimeout)
      console.log('Result:', JSON.stringify(result, null, 2))
    }
    $ node leaky.js
    Result: {
      "leakedEventCount": 1,
      "leakedEvents": [
        {
          "timestamp": "2019-03-18T02:45:58.136Z",
          "asyncID": 8,
          "stack": [
            "    at Timer.emitInitNative (internal/async_hooks.js:131:43)",
            "    at new TimersList (timers.js:212:31)",
            "    at insert (timers.js:186:27)",
            "    at exports.active (timers.js:159:3)",
            "    at new Timeout (timers.js:571:3)",
            "    at setTimeout (timers.js:449:10)",
            "    at leakSetTimeout (.../leaky.js:4:3)",
            "    at LeakedEventTracker.<anonymous> (.../async-leak-tracker/src/index.js:85:18)",
            "    at Generator.next (<anonymous>)"
          ]
        }
      ],
      "result": "done!"
    }
    this leaked!

Current Status
--------------

Currently tracks:

- Timer events (ie, ``setTimeout``)
    - See `Timeout Handle Re-Use`_

- TCP socket client + server
    - Because `socket.end()`__ only half-closes the socket, the socket will
      not be considered entirely closed until the ``close`` event is emitted.

      This may lead to some confusion, as the following apparently correct
      code will leak an event::

        function openAndCloseSocketLeaking() {
          return new Promise(res => {
            const client = net.createConnect({ ... }, () => {
              client.end(() => res)
            })
          })
        }

      To be completely correct, the socket can only be considered closed once
      the ``close`` event is emitted::

        function openAndCloseSocketCorrect() {
          return new Promise(res => {
            const client = net.createConnect({ ... }, () => {
              client.end()
            })

            client.on('close', res)
          })
        }


__ https://nodejs.org/api/net.html#net_socket_end_data_encoding_callback


Using with Tests
----------------

The ``LeakedEventTracker.start()`` and ``LeakedEventTracker.stop()`` methods
can be used in ``before()`` and ``after()`` to assert that tests don't leak.

(note: see `Caveats`_)

For example::

  import { LeakedEventTracker } from 'async-leak-tracker'

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
    setTimeout(() => {}, 10)
  })

Testing
-------

Run tests with ``npm run test`` or ``npm run test:watch`` (note: one is
expected to fail, and some are currently failing; see `Timeout Handle
Re-Use`_; also, tests get progressively slower in watch mode).

Debug with ``DEBUG=1 npm run test``

Caveats
=======

Testing Frameworks
------------------

Testing frameworks may start timers during the regular course of a test run
(for example, when mocha detects that a test is async, it starts a timeout
timer).

These timeouts can be ignored using the ``eventsToIgnore`` option (see
``LeakedEventTrackerOptions``), but currently only Mocha is included.


Timeout Handle Re-Use
---------------------

Node appears to re-use libuv timer handles, so under certain conditions timeout
leaks will not be detected.

This is purely speculation, but it appears to happen when:

1. Multiple timeouts are created with the same timeout at the same time::

    function leaky() {
      setTimeout(() => {}, 100)
      setTimeout(() => {}, 100)
    }
    trackLeakedEvents(leaky) => { leakedEventCount: 1 }

2. There is a completed timeout handle which hasn't been destroyed::

    function leaky() {
      setTimeout(() => {}, 100)
    }
    await new Promise(res => setTimeout(res, 1) // this handle will be reused
    trackLeakedEvents(leaky) => { leakedEventCount: 0 }

And these leaks are not detected because, currently, ``async-leak-tracker``
uses the ``init`` async hook to detect when a timeout is created. It should be
possible to resolve this by creating a single instance of the leak tracker
before any timeouts are created, then tracking leaks using the ``before`` async
hook instead of the ``init`` hook.

Changing to a single instance of the leak tracker would likely significantly
improve performance too, as async hooks can be very slow (notice that, in
watch mode, each run gets progressively slower until they start to time out;
see also: comments in ``LeakedEventTracker.start()``)
