'use strict';

// Node owns fixture files; Electron must close before their retirement (Windows file locks).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const PREFIX = 'campus renderer asar ';
const PASS = 'renderer native modules in ASAR: PASS';
const MAX_OUTPUT = 1024 * 1024;

function accepted(result) {
  return result.closed && result.code === 0 && !result.signal && !result.timedOut &&
    !result.launchError && !result.outputLimit && !result.interrupted && result.output.includes(PASS);
}

function retire(root, identity, fileSystem = fs) {
  const stat = fileSystem.lstatSync(root, {bigint:true});
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
    throw new Error('ASAR fixture root identity changed; cleanup refused');
  }
  fileSystem.rmSync(root, { recursive:true, force:true, maxRetries:3, retryDelay:50 });
  if (fileSystem.existsSync(root)) throw new Error('ASAR fixture cleanup incomplete');
}

function runChild(electron, root, { stage = path.join(__dirname, 'renderer-module-asar.electron.js'), timeoutMs = 20000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000) throw new Error('invalid fixture deadline');
  return new Promise(resolve => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('HKUSTGZ_') && !['ELECTRON_RUN_AS_NODE','NODE_OPTIONS'].includes(key)));
    const child = spawn(electron, [stage, root], {
      env, stdio:['ignore','pipe','pipe'], detached:process.platform !== 'win32', windowsHide:true,
    });
    const result = { pid:child.pid || null, code:null, signal:null, closed:false, timedOut:false,
      launchError:false, outputLimit:false, interrupted:false, output:'' };
    let settled = false, grace = null, outputBytes = 0, printedBytes = 0;
    const finish = () => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(grace);
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      if (!result.closed) { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
      resolve(result);
    };
    const stop = () => {
      if (grace) return;
      if (child.pid && child.exitCode === null) {
        if (process.platform === 'win32') {
          spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide:true, timeout:2000, stdio:'ignore' });
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      }
      grace = setTimeout(finish, 2000);
    };
    const deadline = setTimeout(() => { result.timedOut = true; stop(); }, timeoutMs);
    const interrupt = () => { result.interrupted = true; stop(); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    child.on('error', () => { result.launchError = true; });
    child.once('close', (code, signal) => {
      result.closed = true; result.code = code; result.signal = signal; finish();
    });
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      stream.on('error', () => { result.launchError = true; stop(); });
      stream.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT) { result.outputLimit = true; stop(); return; }
        const text = decoder.write(chunk);
        printedBytes += Buffer.byteLength(text);
        if (printedBytes > MAX_OUTPUT) { result.outputLimit = true; stop(); return; }
        result.output += text;
      });
    }
  });
}

async function main() {
  const electron = require('electron');
  if (typeof electron !== 'string') throw new Error('Run the ASAR parent fixture with Node, not Electron');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)));
  const identity = fs.lstatSync(root, {bigint:true});
  const result = await runChild(electron, root);
  process.stdout.write(result.output);
  if (!result.closed) throw new Error(`Electron close unconfirmed (PID ${result.pid}); retained fixture ${root}`);
  retire(root, identity);
  if (!accepted(result)) throw new Error('ASAR fixture did not complete successfully');
  process.stdout.write('renderer ASAR lifecycle: PASS (child closed, fixture removed)\n');
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
});
module.exports = { accepted, retire, runChild };
