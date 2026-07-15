// Verifies physical printers are serialized independently.
//
// Run: node tests/printer-dispatch-queue.test.js

const assert = require('assert');
const PrinterDispatchQueue = require('../src/main/printer/printer-dispatch-queue');

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

(async () => {
  console.log('--- printer dispatch queue ---');

  await test('same physical printer runs jobs strictly in enqueue order', async () => {
    const queue = new PrinterDispatchQueue();
    const firstGate = deferred();
    const events = [];

    const first = queue.enqueue('  Receipt Printer  ', async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
    });
    const second = queue.enqueue('receipt printer', async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await flushMicrotasks();
    assert.deepStrictEqual(events, ['first:start']);

    firstGate.resolve();
    await Promise.all([first, second]);

    assert.deepStrictEqual(events, [
      'first:start',
      'first:end',
      'second:start',
      'second:end'
    ]);
    assert.strictEqual(queue.tails.size, 0);
  });

  await test('different printers start before either pending task resolves', async () => {
    const queue = new PrinterDispatchQueue();
    const kitchenGate = deferred();
    const counterGate = deferred();
    const started = [];

    const kitchen = queue.enqueue('Kitchen', async () => {
      started.push('Kitchen');
      await kitchenGate.promise;
    });
    const counter = queue.enqueue('Counter', async () => {
      started.push('Counter');
      await counterGate.promise;
    });

    await flushMicrotasks();
    assert.deepStrictEqual(new Set(started), new Set(['Kitchen', 'Counter']));

    kitchenGate.resolve();
    counterGate.resolve();
    await Promise.all([kitchen, counter]);
    assert.strictEqual(queue.tails.size, 0);
  });

  await test('a rejected task does not poison the next task for its printer', async () => {
    const queue = new PrinterDispatchQueue();
    const events = [];
    const expectedError = new Error('printer offline');

    const rejected = queue.enqueue('Kitchen', async () => {
      events.push('failed:start');
      throw expectedError;
    });
    const recovered = queue.enqueue(' kitchen ', async () => {
      events.push('recovered:start');
      return 'printed';
    });

    const results = await Promise.allSettled([rejected, recovered]);

    assert.strictEqual(results[0].status, 'rejected');
    assert.strictEqual(results[0].reason, expectedError);
    assert.deepStrictEqual(results[1], { status: 'fulfilled', value: 'printed' });
    assert.deepStrictEqual(events, ['failed:start', 'recovered:start']);
    assert.strictEqual(queue.tails.size, 0);
  });

  await test('missing printer ids are rejected without creating a tail', async () => {
    const queue = new PrinterDispatchQueue();

    await assert.rejects(
      () => queue.enqueue('   ', async () => {}),
      /printerId/i
    );
    assert.strictEqual(queue.tails.size, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
