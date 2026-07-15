const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  WindowsSpoolWorker,
  SpoolWorkerUnavailableError,
  SpoolWorkerUncertainError,
  resolveWindowsSpoolScriptPath
} = require('../src/main/printer/windows-spool-worker');

class FakeStdin extends EventEmitter {
  constructor(onWrite) {
    super();
    this.onWrite = onWrite;
    this.writes = [];
    this.ended = false;
  }

  write(line, callback) {
    this.writes.push(line);
    if (this.onWrite) {
      return this.onWrite(line, callback);
    }
    setImmediate(() => callback(null));
    return true;
  }

  end() {
    this.ended = true;
  }
}

class FakeChild extends EventEmitter {
  constructor({ onWrite } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new FakeStdin(onWrite);
    this.killed = false;
  }

  kill() {
    this.killed = true;
    return true;
  }
}

function createHarness(childOptions = {}) {
  const children = [];
  const spawnCalls = [];
  const spawnFn = (...args) => {
    spawnCalls.push(args);
    const child = new FakeChild(childOptions);
    children.push(child);
    return child;
  };

  return { children, spawnCalls, spawnFn };
}

function emitLine(child, line, ending = '\n') {
  child.stdout.emit('data', Buffer.from(line + ending, 'utf8'));
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function parseJobLine(line) {
  return line.replace(/\r?\n$/, '').split('\t');
}

async function testConcurrentJobsReuseOneProcessAndPreserveProtocol() {
  const harness = createHarness();
  const worker = new WindowsSpoolWorker({ spawnFn: harness.spawnFn, timeoutMs: 1000 });
  const rawBytes = Buffer.from([0x00, 0x1b, 0xff, 0x0a]);
  const text = 'Pedido acao';

  const rawPromise = worker.printRaw('Cozinha Acao', rawBytes);
  const textPromise = worker.printText('Caixa', text);

  assert.equal(harness.spawnCalls.length, 1, 'concurrent starts must share one process');
  assert.equal(harness.spawnCalls[0][0], 'powershell');
  assert.deepEqual(harness.spawnCalls[0][1].slice(0, 6), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(__dirname, '../src/main/printer/windows-spool-worker.ps1')
  ]);
  assert.deepEqual(harness.spawnCalls[0][2], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  assert.equal(harness.children[0].stdin.writes.length, 0, 'jobs must wait for READY');

  harness.children[0].stdout.emit('data', Buffer.from('RE'));
  await nextTurn();
  assert.equal(harness.children[0].stdin.writes.length, 0, 'partial READY must not release jobs');

  harness.children[0].stdout.emit('data', Buffer.from('ADY\r\n'));
  await nextTurn();
  assert.equal(harness.children[0].stdin.writes.length, 2);

  const rawFields = parseJobLine(harness.children[0].stdin.writes[0]);
  const textFields = parseJobLine(harness.children[0].stdin.writes[1]);
  assert.equal(rawFields.length, 4);
  assert.equal(textFields.length, 4);
  assert.equal(rawFields[1], 'RAW');
  assert.equal(textFields[1], 'TEXT');
  assert.equal(Buffer.from(rawFields[2], 'base64').toString('utf8'), 'Cozinha Acao');
  assert.deepEqual(Buffer.from(rawFields[3], 'base64'), rawBytes);
  assert.equal(Buffer.from(textFields[2], 'base64').toString('utf8'), 'Caixa');
  assert.equal(Buffer.from(textFields[3], 'base64').toString('utf8'), text);
  assert.notEqual(rawFields[0], textFields[0], 'job IDs must be unique');

  emitLine(harness.children[0], `OK\t${textFields[0]}`);
  emitLine(harness.children[0], `OK\t${rawFields[0]}`);
  assert.equal(await rawPromise, true);
  assert.equal(await textPromise, true);
  assert.equal(worker.pending.size, 0, 'pending jobs must be removed after completion');

  await worker.stop();
}

async function testResponsesCorrelateOutOfOrderIncludingErrors() {
  const harness = createHarness();
  const worker = new WindowsSpoolWorker({ spawnFn: harness.spawnFn, timeoutMs: 1000 });
  const first = worker.printRaw('Printer A', Buffer.from('one'));
  const second = worker.printRaw('Printer B', Buffer.from('two'));

  emitLine(harness.children[0], 'READY');
  await nextTurn();
  const firstId = parseJobLine(harness.children[0].stdin.writes[0])[0];
  const secondId = parseJobLine(harness.children[0].stdin.writes[1])[0];
  const firstRejection = assert.rejects(first, (error) => {
    assert.equal(error.message, 'driver rejected bytes');
    assert.equal(error.printOutcomeUncertain, true);
    assert.equal(error instanceof SpoolWorkerUnavailableError, false);
    return true;
  });

  emitLine(harness.children[0], `OK\t${secondId}`);
  emitLine(
    harness.children[0],
    `ERR\t${firstId}\t${Buffer.from('driver rejected bytes', 'utf8').toString('base64')}`,
    '\r\n'
  );

  assert.equal(await second, true);
  await firstRejection;
  assert.equal(worker.pending.size, 0);
  await worker.stop();
}

async function testProcessFailureBeforeReadyIsUnavailable() {
  for (const eventName of ['error', 'exit']) {
    const harness = createHarness();
    const worker = new WindowsSpoolWorker({ spawnFn: harness.spawnFn, startupTimeoutMs: 1000 });
    const startPromise = worker.start();

    if (eventName === 'error') {
      harness.children[0].emit('error', new Error('spawn failed'));
    } else {
      harness.children[0].emit('exit', 1, null);
    }

    await assert.rejects(startPromise, SpoolWorkerUnavailableError);
    assert.equal(worker.child, null);
  }
}

async function testStartupReadyTimeoutIsUnavailable() {
  const harness = createHarness();
  const worker = new WindowsSpoolWorker({ spawnFn: harness.spawnFn, startupTimeoutMs: 10 });

  await assert.rejects(worker.start(), SpoolWorkerUnavailableError);
  assert.equal(harness.children[0].killed, true);
  assert.equal(worker.child, null);
}

async function testSynchronousWriteFailureBeforeAcceptanceIsUnavailable() {
  const harness = createHarness({
    onWrite() {
      throw new Error('synchronous broken stdin');
    }
  });
  const worker = new WindowsSpoolWorker({ spawnFn: harness.spawnFn, timeoutMs: 1000 });
  const printPromise = worker.printRaw('Printer', Buffer.from('payload'));

  emitLine(harness.children[0], 'READY');
  await assert.rejects(printPromise, SpoolWorkerUnavailableError);
  assert.equal(worker.pending.size, 0);
  await worker.stop();
}

async function testWriteReturnImmediatelyMarksJobAccepted() {
  let writeCallback;
  const harness = createHarness({
    onWrite(line, callback) {
      writeCallback = callback;
      return true;
    }
  });
  const worker = new WindowsSpoolWorker({ spawnFn: harness.spawnFn, timeoutMs: 1000 });
  const printPromise = worker.printRaw('Printer', Buffer.from('payload'));

  emitLine(harness.children[0], 'READY');
  await nextTurn();
  const jobId = parseJobLine(harness.children[0].stdin.writes[0])[0];
  assert.equal(worker.pending.get(jobId).accepted, true, 'successful stdin.write return is the acceptance boundary');
  writeCallback(null);
  emitLine(harness.children[0], `OK\t${jobId}`);
  assert.equal(await printPromise, true);
  await worker.stop();
}

async function testWriteCallbackFailureAfterReturnIsUncertain() {
  const harness = createHarness({
    onWrite(line, callback) {
      setImmediate(() => callback(new Error('broken stdin')));
      return true;
    }
  });
  const worker = new WindowsSpoolWorker({ spawnFn: harness.spawnFn, timeoutMs: 1000 });
  const printPromise = worker.printRaw('Printer', Buffer.from('payload'));

  emitLine(harness.children[0], 'READY');
  await assert.rejects(printPromise, (error) => {
    assert.equal(error instanceof SpoolWorkerUncertainError, true);
    assert.equal(error instanceof SpoolWorkerUnavailableError, false);
    assert.equal(error.printOutcomeUncertain, true);
    return true;
  });
  assert.equal(worker.pending.size, 0);
  await worker.stop();
}

async function testTimeoutOnlyRejectsAffectedJobAndIgnoresLateResponse() {
  const harness = createHarness();
  const worker = new WindowsSpoolWorker({ spawnFn: harness.spawnFn, timeoutMs: 10 });
  const firstPromise = worker.printRaw('Printer A', Buffer.from('first'));

  emitLine(harness.children[0], 'READY');
  await nextTurn();
  const firstId = parseJobLine(harness.children[0].stdin.writes[0])[0];
  worker.timeoutMs = 1000;
  const secondPromise = worker.printRaw('Printer B', Buffer.from('second'));
  await nextTurn();
  const secondId = parseJobLine(harness.children[0].stdin.writes[1])[0];

  await assert.rejects(firstPromise, (error) => {
    assert.equal(error instanceof SpoolWorkerUncertainError, true);
    assert.equal(error instanceof SpoolWorkerUnavailableError, false);
    assert.equal(error.printOutcomeUncertain, true);
    return true;
  });

  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.children[0].killed, false, 'one timed-out job must not terminate the shared worker');
  assert.equal(worker.pending.has(secondId), true, 'unrelated printer job must remain pending');
  emitLine(harness.children[0], `OK\t${firstId}`);
  emitLine(
    harness.children[0],
    `ERR\t${firstId}\t${Buffer.from('late error', 'utf8').toString('base64')}`
  );
  assert.equal(worker.pending.has(secondId), true, 'late responses for timed-out jobs must be ignored');
  emitLine(harness.children[0], `OK\t${secondId}`);
  assert.equal(await secondPromise, true);
  assert.equal(worker.pending.size, 0);
  await worker.stop();
}

async function testOneShotDispatchClassification() {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => os.tmpdir() } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let winSpool;
  try {
    winSpool = require('../src/main/printer/win-spool');
  } finally {
    Module._load = originalLoad;
  }

  const cases = [
    {
      name: 'RAW',
      run: (execFn) => winSpool.__private.printRawOneShot('Printer', Buffer.from([0x00, 0xff]), { execFn })
    },
    {
      name: 'TEXT',
      run: (execFn) => winSpool.__private.printTextOneShot('Printer', 'payload', { execFn })
    }
  ];

  for (const oneShotCase of cases) {
    const preDispatchError = new Error(`${oneShotCase.name} failed before dispatch`);
    await assert.rejects(
      oneShotCase.run(async () => {
        throw preDispatchError;
      }),
      (error) => {
        assert.equal(error, preDispatchError);
        assert.notEqual(error.printOutcomeUncertain, true);
        return true;
      }
    );

    const postDispatchError = new Error(`${oneShotCase.name} process exited after dispatch`);
    await assert.rejects(
      oneShotCase.run(async (command, timeoutMs, { dispatchMarkerPath }) => {
        assert.equal(typeof command, 'string');
        assert.equal(timeoutMs >= 60000, true);
        fs.writeFileSync(dispatchMarkerPath, 'DISPATCHING', 'ascii');
        throw postDispatchError;
      }),
      (error) => {
        assert.equal(error instanceof SpoolWorkerUncertainError, true);
        assert.equal(error.printOutcomeUncertain, true);
        assert.equal(error.cause, postDispatchError);
        return true;
      }
    );

    await assert.rejects(
      oneShotCase.run(async (command, timeoutMs, { dispatchMarkerPath }) => {
        fs.writeFileSync(dispatchMarkerPath, 'DISPATCHING', 'ascii');
        return { stdout: '', stderr: 'no success marker' };
      }),
      (error) => {
        assert.equal(error instanceof SpoolWorkerUncertainError, true);
        assert.equal(error.printOutcomeUncertain, true);
        return true;
      }
    );
  }
}

function testPackagedScriptPathAndAsarConfig() {
  const defaultWorker = new WindowsSpoolWorker();
  assert.equal(defaultWorker.timeoutMs, 60000);
  assert.equal(
    resolveWindowsSpoolScriptPath('/opt/Hub/resources/app.asar/src/main/printer/windows-spool-worker.ps1'),
    '/opt/Hub/resources/app.asar.unpacked/src/main/printer/windows-spool-worker.ps1'
  );
  assert.equal(
    resolveWindowsSpoolScriptPath('C:\\Program Files\\Hub\\resources\\app.asar\\src\\main\\printer\\windows-spool-worker.ps1'),
    'C:\\Program Files\\Hub\\resources\\app.asar.unpacked\\src\\main\\printer\\windows-spool-worker.ps1'
  );
  assert.equal(
    resolveWindowsSpoolScriptPath('/workspace/src/main/printer/windows-spool-worker.ps1'),
    '/workspace/src/main/printer/windows-spool-worker.ps1'
  );
  const packagedWorker = new WindowsSpoolWorker({
    scriptPath: 'C:\\Hub\\resources\\app.asar\\src\\main\\printer\\windows-spool-worker.ps1'
  });
  assert.equal(
    packagedWorker.scriptPath,
    'C:\\Hub\\resources\\app.asar.unpacked\\src\\main\\printer\\windows-spool-worker.ps1'
  );

  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.equal(
    packageJson.build.asarUnpack.includes('src/main/printer/windows-spool-worker.ps1'),
    true,
    'Electron Builder must unpack the PowerShell worker beside app.asar'
  );
}

async function testExitAfterAcceptanceIsUncertain() {
  const harness = createHarness();
  const worker = new WindowsSpoolWorker({ spawnFn: harness.spawnFn, timeoutMs: 1000 });
  const printPromise = worker.printRaw('Printer', Buffer.from('payload'));

  emitLine(harness.children[0], 'READY');
  await nextTurn();
  await nextTurn();
  const jobId = parseJobLine(harness.children[0].stdin.writes[0])[0];
  assert.equal(worker.pending.get(jobId).accepted, true);
  harness.children[0].emit('exit', 1, null);

  await assert.rejects(printPromise, (error) => {
    assert.equal(error instanceof SpoolWorkerUncertainError, true);
    assert.equal(error instanceof SpoolWorkerUnavailableError, false);
    assert.equal(error.printOutcomeUncertain, true);
    return true;
  });
  assert.equal(worker.pending.size, 0);
  assert.equal(worker.child, null);
}

async function testProcessErrorAfterAcceptanceIsUncertain() {
  const harness = createHarness();
  const worker = new WindowsSpoolWorker({ spawnFn: harness.spawnFn, timeoutMs: 1000 });
  const printPromise = worker.printRaw('Printer', Buffer.from('payload'));

  emitLine(harness.children[0], 'READY');
  await nextTurn();
  await nextTurn();
  const jobId = parseJobLine(harness.children[0].stdin.writes[0])[0];
  assert.equal(worker.pending.get(jobId).accepted, true);
  harness.children[0].emit('error', new Error('worker failed'));

  await assert.rejects(printPromise, (error) => {
    assert.equal(error instanceof SpoolWorkerUncertainError, true);
    assert.equal(error instanceof SpoolWorkerUnavailableError, false);
    assert.equal(error.printOutcomeUncertain, true);
    return true;
  });
  assert.equal(worker.pending.size, 0);
  assert.equal(worker.child, null);
  assert.equal(harness.children[0].killed, true);
}

async function testStopRejectsPendingAndTerminatesChild() {
  const harness = createHarness();
  const worker = new WindowsSpoolWorker({ spawnFn: harness.spawnFn, timeoutMs: 1000 });
  const printPromise = worker.printRaw('Printer', Buffer.from('payload'));

  emitLine(harness.children[0], 'READY');
  await nextTurn();
  await nextTurn();
  const jobId = parseJobLine(harness.children[0].stdin.writes[0])[0];
  assert.equal(worker.pending.get(jobId).accepted, true);
  const rejection = assert.rejects(printPromise, (error) => {
    assert.equal(error.printOutcomeUncertain, true);
    return true;
  });

  await worker.stop();
  await worker.stop();
  await rejection;
  assert.equal(worker.pending.size, 0);
  assert.equal(harness.children[0].stdin.ended, true);
  assert.equal(harness.children[0].killed, true);
  assert.equal(worker.child, null);
}

function testPowerShell2SourceContract() {
  const script = fs.readFileSync(
    path.join(__dirname, '../src/main/printer/windows-spool-worker.ps1'),
    'utf8'
  );

  assert.doesNotMatch(script, /ConvertFrom-Json/);
  assert.doesNotMatch(script, /\?\?/);
  assert.doesNotMatch(script, /ForEach-Object\s+-Parallel/);
  assert.doesNotMatch(script, /^\s*class\s+[A-Za-z_]/m);
  for (const required of [
    'OpenPrinter',
    'StartDocPrinter',
    'StartPagePrinter',
    'WritePrinter',
    'EndPagePrinter',
    'EndDocPrinter',
    'ClosePrinter',
    'ThreadPool.QueueUserWorkItem',
    'new StandardPrintController()',
    'new Font("Consolas", 9)',
    'eventArgs.MarginBounds',
    '[Console]::Out.WriteLine("READY")'
  ]) {
    assert.equal(script.includes(required), true, `PowerShell worker must contain ${required}`);
  }
}

async function testManagerNeverFallsBackAfterUncertainOutcome() {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => os.tmpdir() } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const winSpool = require('../src/main/printer/win-spool');
  const WindowsPrinterManager = require('../src/main/printer/windows-manager');
  const originals = {
    printRaw: winSpool.printRaw,
    printText: winSpool.printText,
    printFile: winSpool.printFile,
    stopPersistentWorker: winSpool.stopPersistentWorker,
    legacyMode: process.env.HUB_FORCE_LEGACY_TEXT_PRINT
  };

  try {
    const manager = new WindowsPrinterManager();
    const uncertain = new SpoolWorkerUncertainError('accepted job failed');
    let rawCalls = 0;
    let textCalls = 0;
    let fileCalls = 0;
    winSpool.printFile = async () => {
      fileCalls += 1;
      return true;
    };

    process.env.HUB_FORCE_LEGACY_TEXT_PRINT = '1';
    winSpool.printText = async () => {
      textCalls += 1;
      throw uncertain;
    };
    winSpool.printRaw = async () => {
      rawCalls += 1;
      return true;
    };
    await assert.rejects(manager._printBuffer('Printer', Buffer.from('payload')), (error) => error === uncertain);
    assert.equal(textCalls, 1);
    assert.equal(rawCalls, 0, 'legacy TEXT uncertainty must not fall back to RAW');

    delete process.env.HUB_FORCE_LEGACY_TEXT_PRINT;
    textCalls = 0;
    winSpool.printRaw = async () => {
      rawCalls += 1;
      throw uncertain;
    };
    await assert.rejects(manager._printBuffer('Printer', Buffer.from('payload')), (error) => error === uncertain);
    assert.equal(textCalls, 0, 'RAW uncertainty must not fall back to TEXT');
    assert.equal(fileCalls, 0, 'RAW uncertainty must not fall back to printFile');

    winSpool.printRaw = async () => {
      throw new Error('known RAW failure');
    };
    winSpool.printText = async () => {
      textCalls += 1;
      throw uncertain;
    };
    await assert.rejects(manager._printBuffer('Printer', Buffer.from('payload')), (error) => error === uncertain);
    assert.equal(fileCalls, 0, 'TEXT fallback uncertainty must not continue to printFile');

    let stopCalls = 0;
    winSpool.stopPersistentWorker = async () => {
      stopCalls += 1;
    };
    manager.stopAutoDiscovery();
    assert.equal(stopCalls, 1);
  } finally {
    winSpool.printRaw = originals.printRaw;
    winSpool.printText = originals.printText;
    winSpool.printFile = originals.printFile;
    winSpool.stopPersistentWorker = originals.stopPersistentWorker;
    if (originals.legacyMode === undefined) {
      delete process.env.HUB_FORCE_LEGACY_TEXT_PRINT;
    } else {
      process.env.HUB_FORCE_LEGACY_TEXT_PRINT = originals.legacyMode;
    }
    Module._load = originalLoad;
  }
}

async function testOfficialRawBypassesLegacyTextConversion() {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => os.tmpdir() } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const winSpool = require('../src/main/printer/win-spool');
  const WindowsPrinterManager = require('../src/main/printer/windows-manager');
  const originals = {
    printRaw: winSpool.printRaw,
    printText: winSpool.printText,
    legacyMode: process.env.HUB_FORCE_LEGACY_TEXT_PRINT
  };

  try {
    const manager = new WindowsPrinterManager();
    const officialBytes = Buffer.from([0x1B, 0x40, 0x1B, 0x61, 0x01, 0x41, 0x0A]);
    const rawPayloads = [];
    let textCalls = 0;

    manager.ensurePrinterAvailable = async () => 'Printer';
    process.env.HUB_FORCE_LEGACY_TEXT_PRINT = '1';
    winSpool.printRaw = async (_printer, payload) => {
      rawPayloads.push(Buffer.from(payload));
    };
    winSpool.printText = async () => {
      textCalls += 1;
    };

    const result = await manager.print({
      printer: 'Printer',
      rawContent: officialBytes.toString('base64'),
      printType: 'counter'
    });

    assert.equal(result.mode, 'raw');
    assert.equal(textCalls, 0, 'official RAW must never use the GDI text path');
    assert.equal(rawPayloads.length, 1);
    assert.deepEqual(rawPayloads[0], officialBytes);
  } finally {
    winSpool.printRaw = originals.printRaw;
    winSpool.printText = originals.printText;
    if (originals.legacyMode === undefined) {
      delete process.env.HUB_FORCE_LEGACY_TEXT_PRINT;
    } else {
      process.env.HUB_FORCE_LEGACY_TEXT_PRINT = originals.legacyMode;
    }
    Module._load = originalLoad;
  }
}

async function run() {
  await testConcurrentJobsReuseOneProcessAndPreserveProtocol();
  await testResponsesCorrelateOutOfOrderIncludingErrors();
  await testProcessFailureBeforeReadyIsUnavailable();
  await testStartupReadyTimeoutIsUnavailable();
  await testSynchronousWriteFailureBeforeAcceptanceIsUnavailable();
  await testWriteReturnImmediatelyMarksJobAccepted();
  await testWriteCallbackFailureAfterReturnIsUncertain();
  await testTimeoutOnlyRejectsAffectedJobAndIgnoresLateResponse();
  await testExitAfterAcceptanceIsUncertain();
  await testProcessErrorAfterAcceptanceIsUncertain();
  await testStopRejectsPendingAndTerminatesChild();
  await testOneShotDispatchClassification();
  testPackagedScriptPathAndAsarConfig();
  testPowerShell2SourceContract();
  await testManagerNeverFallsBackAfterUncertainOutcome();
  await testOfficialRawBypassesLegacyTextConversion();
  console.log('windows-spool-worker.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
