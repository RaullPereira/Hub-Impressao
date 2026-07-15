// Validates batched official render payload fetching without generating layouts locally.
//
// Run: node tests/batched-render-payload.test.js

const assert = require('assert');
const os = require('os');
const Module = require('module');

const originalLoad = Module._load;
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

function response(status, raw) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => raw
  };
}

function makeListener(PairedPrintListener, fetchImpl, options = {}) {
  const listener = new PairedPrintListener(null, {
    adminClientId: 'store-1',
    fetchImpl,
    renderTimeoutMs: options.renderTimeoutMs,
    pairingStore: {
      getPairing: () => ({ adminClientId: 'store-1', enabled: true }),
      savePairing: () => {},
      updatePairing: () => {},
      clearPairing: () => {}
    }
  });

  listener.currentPairing = {
    adminClientId: 'store-1',
    appBaseUrl: 'https://app.pedidoshub.com/',
    session: {
      access_token: 'token-1',
      refresh_token: 'refresh-token'
    }
  };

  return listener;
}

async function expectRejects(fn, expectedText) {
  await assert.rejects(fn, (error) => {
    const message = String(error && error.message ? error.message : error);
    assert.ok(
      message.toLowerCase().includes(expectedText.toLowerCase()),
      `expected ${JSON.stringify(message)} to include ${JSON.stringify(expectedText)}`
    );
    return true;
  });
}

(async () => {
  console.log('--- batched render payload ---');

  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') {
        return { app: { getPath: () => os.tmpdir() } };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const PairedPrintListener = require('../src/main/supabase/paired-print-listener');

    await test('new batch response uses one request and normalizes both variants', async () => {
      const calls = [];
      const listener = makeListener(PairedPrintListener, async (url, options) => {
        calls.push({ url, options });
        return response(200, {
          payload: {
            rawContent: 'legacy-top-level',
            encoding: 'base64',
            printType: 'counter',
            variants: {
              counter: { rawContent: '  Y291bnRlcg==  ' },
              kitchen: { rawContent: 'a2l0Y2hlbg==', encoding: 'base64' }
            }
          }
        });
      });

      const payloads = await listener.fetchRenderedPayloads('order-1', ['counter', 'kitchen']);

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].url, 'https://app.pedidoshub.com/api/print/render');
      assert.deepStrictEqual(JSON.parse(calls[0].options.body), {
        adminClientId: 'store-1',
        orderId: 'order-1',
        printTypes: ['counter', 'kitchen']
      });
      assert.deepStrictEqual(payloads, {
        counter: { rawContent: 'Y291bnRlcg==', encoding: 'base64', printType: 'counter' },
        kitchen: { rawContent: 'a2l0Y2hlbg==', encoding: 'base64', printType: 'kitchen' }
      });
    });

    await test('deduplication preserves request order and supports bar', async () => {
      let requestBody = null;
      const listener = makeListener(PairedPrintListener, async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return response(200, {
          payload: {
            variants: {
              kitchen: { rawContent: ' kitchen ' },
              counter: { rawContent: ' counter ' },
              bar: { rawContent: ' bar ', encoding: 'base64' }
            }
          }
        });
      });

      const payloads = await listener.fetchRenderedPayloads(
        'order-2',
        ['kitchen', 'counter', 'kitchen', 'bar', 'counter']
      );

      assert.deepStrictEqual(requestBody.printTypes, ['kitchen', 'counter', 'bar']);
      assert.deepStrictEqual(Object.keys(payloads), ['kitchen', 'counter', 'bar']);
      assert.strictEqual(payloads.bar.printType, 'bar');
    });

    await test('old server response probes once then fetches every legacy type', async () => {
      const requestBodies = [];
      const listener = makeListener(PairedPrintListener, async (_url, options) => {
        const body = JSON.parse(options.body);
        requestBodies.push(body);

        if (Array.isArray(body.printTypes)) {
          return response(200, {
            payload: {
              rawContent: 'legacy-probe',
              encoding: 'base64',
              printType: body.printTypes[0]
            }
          });
        }

        return response(200, {
          payload: {
            rawContent: ` legacy-${body.printType} `,
            encoding: 'base64',
            printType: body.printType
          }
        });
      });

      const payloads = await listener.fetchRenderedPayloads('order-3', ['counter', 'kitchen']);

      assert.strictEqual(requestBodies.length, 3);
      assert.deepStrictEqual(requestBodies[0].printTypes, ['counter', 'kitchen']);
      assert.deepStrictEqual(
        requestBodies.slice(1).map((body) => body.printType),
        ['counter', 'kitchen']
      );
      assert.deepStrictEqual(payloads, {
        counter: { rawContent: 'legacy-counter', encoding: 'base64', printType: 'counter' },
        kitchen: { rawContent: 'legacy-kitchen', encoding: 'base64', printType: 'kitchen' }
      });
    });

    await test('one 401 forces one refresh and retries with renewed bearer token', async () => {
      const authorizations = [];
      let fetchCalls = 0;
      const listener = makeListener(PairedPrintListener, async (_url, options) => {
        fetchCalls += 1;
        authorizations.push(options.headers.Authorization);

        if (fetchCalls === 1) {
          return response(401, { error: 'Token expirado' });
        }

        return response(200, {
          payload: {
            variants: {
              counter: { rawContent: 'cmVuZXdlZA==' }
            }
          }
        });
      });
      const refreshCalls = [];
      listener.ensureSessionFresh = async (force = false) => {
        refreshCalls.push(force);
        if (force) {
          listener.currentPairing.session.access_token = 'token-2';
        }
      };

      const payloads = await listener.fetchRenderedPayloads('order-4', ['counter']);

      assert.strictEqual(payloads.counter.rawContent, 'cmVuZXdlZA==');
      assert.strictEqual(fetchCalls, 2);
      assert.deepStrictEqual(refreshCalls, [false, true]);
      assert.deepStrictEqual(authorizations, ['Bearer token-1', 'Bearer token-2']);
    });

    await test('timeout aborts and reports an explicit timeout error', async () => {
      let aborted = false;
      const listener = makeListener(PairedPrintListener, async (_url, options) => {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            aborted = true;
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }, { renderTimeoutMs: 1000 });

      await expectRejects(
        () => listener.fetchRenderedPayloads('order-5', ['counter']),
        'timeout'
      );
      assert.strictEqual(aborted, true);
    });

    await test('empty type list and invalid payload reject clearly', async () => {
      let fetchCalls = 0;
      const listener = makeListener(PairedPrintListener, async () => {
        fetchCalls += 1;
        return response(200, { payload: { rawContent: '   ' } });
      });

      await expectRejects(
        () => listener.fetchRenderedPayloads('order-6', []),
        'tipo de impressão'
      );
      assert.strictEqual(fetchCalls, 0);

      await expectRejects(
        () => listener.fetchRenderedPayload('order-6', 'counter'),
        'payload de impressão inválido'
      );
      assert.strictEqual(fetchCalls, 1);
    });
  } catch (error) {
    failed += 1;
    console.error('FAIL  test setup');
    console.error(error && error.stack ? error.stack : error);
  } finally {
    Module._load = originalLoad;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
