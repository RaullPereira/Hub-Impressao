const path = require('path');
const { spawn } = require('child_process');

class SpoolWorkerUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'SpoolWorkerUnavailableError';
    if (cause) this.cause = cause;
  }
}

class SpoolWorkerUncertainError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'SpoolWorkerUncertainError';
    this.printOutcomeUncertain = true;
    if (cause) this.cause = cause;
  }
}

class WindowsSpoolWorker {
  constructor({
    spawnFn = spawn,
    scriptPath = path.join(__dirname, 'windows-spool-worker.ps1'),
    timeoutMs = 15000,
    startupTimeoutMs = 15000
  } = {}) {
    this.spawnFn = spawnFn;
    this.scriptPath = scriptPath;
    this.timeoutMs = timeoutMs;
    this.startupTimeoutMs = startupTimeoutMs;
    this.child = null;
    this.startPromise = null;
    this.pending = new Map();
    this._state = null;
    this._nextJobId = 1;
  }

  start() {
    if (this.startPromise) return this.startPromise;

    let resolveStart;
    let rejectStart;
    const startPromise = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    this.startPromise = startPromise;

    let child;
    try {
      child = this.spawnFn(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.scriptPath
        ],
        {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      );
    } catch (error) {
      this.startPromise = null;
      rejectStart(new SpoolWorkerUnavailableError('Windows spool worker could not start', error));
      return startPromise;
    }

    const state = {
      child,
      startPromise,
      resolveStart,
      rejectStart,
      startSettled: false,
      ready: false,
      terminated: false,
      stdoutBuffer: '',
      stderrBuffer: '',
      startupTimer: null
    };
    this.child = child;
    this._state = state;

    if (!child || !child.stdout || !child.stderr || !child.stdin) {
      this._terminateState(state, 'Windows spool worker did not expose stdio pipes');
      this._killChild(child);
      return startPromise;
    }

    child.stdout.on('data', (chunk) => this._consumeStdout(state, chunk));
    child.stdout.on('error', (error) => {
      this._terminateState(state, 'Windows spool worker stdout failed', error);
      this._killChild(child);
    });
    child.stderr.on('data', (chunk) => {
      state.stderrBuffer = (state.stderrBuffer + String(chunk)).slice(-8192);
    });
    child.stderr.on('error', (error) => {
      this._terminateState(state, 'Windows spool worker stderr failed', error);
      this._killChild(child);
    });
    child.on('error', (error) => {
      this._terminateState(state, 'Windows spool worker process error', error);
      this._killChild(child);
    });
    child.on('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      this._terminateState(state, `Windows spool worker exited with ${detail}`);
    });
    if (typeof child.stdin.on === 'function') {
      child.stdin.on('error', (error) => {
        this._terminateState(state, 'Windows spool worker stdin failed', error);
        this._killChild(child);
      });
    }

    state.startupTimer = setTimeout(() => {
      this._terminateState(state, 'Windows spool worker READY timeout');
      this._killChild(child);
    }, this.startupTimeoutMs);

    return startPromise;
  }

  async printRaw(printerName, buffer) {
    const payload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    return this._print('RAW', printerName, payload);
  }

  async printText(printerName, text) {
    return this._print('TEXT', printerName, Buffer.from(String(text), 'utf8'));
  }

  async stop() {
    const state = this._state;
    if (!state) return;

    const child = state.child;
    this._terminateState(state, 'Windows spool worker stopped');

    try {
      if (child.stdin && typeof child.stdin.end === 'function') {
        child.stdin.end();
      }
    } catch (_) { }

    this._killChild(child);
  }

  async _print(mode, printerName, payload) {
    await this.start();
    const state = this._state;
    if (!state || state.terminated || !state.ready || state.child !== this.child) {
      throw new SpoolWorkerUnavailableError('Windows spool worker is not ready');
    }

    const jobId = String(this._nextJobId++);
    const printerBase64 = Buffer.from(String(printerName), 'utf8').toString('base64');
    const payloadBase64 = payload.toString('base64');
    const protocolLine = `${jobId}\t${mode}\t${printerBase64}\t${payloadBase64}\n`;

    return new Promise((resolve, reject) => {
      const entry = {
        jobId,
        state,
        accepted: false,
        settled: false,
        timer: null,
        resolve,
        reject
      };
      this.pending.set(jobId, entry);

      entry.timer = setTimeout(() => {
        const current = this.pending.get(jobId);
        if (!current || current.settled) return;
        this._terminateState(
          state,
          current.accepted
            ? `Windows spool worker timed out after accepting job ${jobId}`
            : `Windows spool worker write timed out before accepting job ${jobId}`
        );
        this._killChild(state.child);
      }, this.timeoutMs);

      try {
        state.child.stdin.write(protocolLine, (error) => {
          const current = this.pending.get(jobId);
          if (!current || current.settled) return;

          if (error) {
            this._terminateState(state, `Windows spool worker could not accept job ${jobId}`, error);
            this._killChild(state.child);
            return;
          }

          current.accepted = true;
        });
      } catch (error) {
        this._terminateState(state, `Windows spool worker could not accept job ${jobId}`, error);
        this._killChild(state.child);
      }
    });
  }

  _consumeStdout(state, chunk) {
    if (state.terminated) return;
    state.stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);

    let lineEnd = state.stdoutBuffer.indexOf('\n');
    while (lineEnd !== -1) {
      let line = state.stdoutBuffer.slice(0, lineEnd);
      state.stdoutBuffer = state.stdoutBuffer.slice(lineEnd + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this._handleProtocolLine(state, line);
      lineEnd = state.stdoutBuffer.indexOf('\n');
    }
  }

  _handleProtocolLine(state, line) {
    if (line === 'READY' && !state.ready) {
      state.ready = true;
      if (state.startupTimer) {
        clearTimeout(state.startupTimer);
        state.startupTimer = null;
      }
      if (!state.startSettled) {
        state.startSettled = true;
        state.resolveStart(true);
      }
      return;
    }

    const fields = line.split('\t');
    if (fields[0] === 'OK' && fields.length === 2) {
      this._settlePending(fields[1], null, true);
      return;
    }

    if (fields[0] === 'ERR' && fields.length === 3) {
      let message = 'Windows spool worker rejected the print job';
      try {
        message = Buffer.from(fields[2], 'base64').toString('utf8') || message;
      } catch (_) { }
      const error = new Error(message);
      error.name = 'WindowsSpoolWorkerJobError';
      error.printOutcomeUncertain = true;
      this._settlePending(fields[1], error);
    }
  }

  _settlePending(jobId, error, value) {
    const entry = this.pending.get(jobId);
    if (!entry || entry.settled) return;

    entry.settled = true;
    this.pending.delete(jobId);
    if (entry.timer) clearTimeout(entry.timer);

    if (error) {
      entry.reject(error);
    } else {
      entry.resolve(value);
    }
  }

  _terminateState(state, message, cause) {
    if (!state || state.terminated) return;
    state.terminated = true;

    if (state.startupTimer) {
      clearTimeout(state.startupTimer);
      state.startupTimer = null;
    }

    const stderr = state.stderrBuffer.trim();
    const detail = stderr ? `${message}: ${stderr}` : message;
    if (!state.startSettled) {
      state.startSettled = true;
      state.rejectStart(new SpoolWorkerUnavailableError(detail, cause));
    }

    for (const [jobId, entry] of this.pending) {
      if (entry.state !== state) continue;
      const error = entry.accepted
        ? new SpoolWorkerUncertainError(`${detail}; outcome for job ${jobId} is uncertain`, cause)
        : new SpoolWorkerUnavailableError(`${detail}; job ${jobId} was not accepted`, cause);
      this._settlePending(jobId, error);
    }

    if (this._state === state) {
      this._state = null;
      this.child = null;
      this.startPromise = null;
    }
  }

  _killChild(child) {
    if (!child || typeof child.kill !== 'function') return;
    try {
      child.kill();
    } catch (_) { }
  }
}

module.exports = {
  WindowsSpoolWorker,
  SpoolWorkerUnavailableError,
  SpoolWorkerUncertainError
};
