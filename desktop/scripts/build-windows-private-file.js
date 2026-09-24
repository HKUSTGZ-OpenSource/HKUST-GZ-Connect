'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function findCommand(name, env = process.env) {
  const result = spawnSync('where.exe', [name], { env, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/u)[0] : null;
}

function compilerEnvironment() {
  const direct = findCommand('cl.exe');
  if (direct) return { command: direct, msvc: true, env: process.env };
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (fs.existsSync(vswhere)) {
    const discovery = spawnSync(vswhere, [
      '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property', 'installationPath',
    ], { encoding: 'utf8', windowsHide: true });
    const installation = discovery.status === 0 ? discovery.stdout.trim() : '';
    if (installation && !/[\r\n"%]/u.test(installation)) {
      const setup = path.join(installation, 'Common7', 'Tools', 'VsDevCmd.bat');
      const result = spawnSync(process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `call "${setup}" -no_logo -arch=x64 >nul && set`],
        { encoding: 'utf8', windowsHide: true });
      // Never print the environment dump: a CI environment can contain secrets.
      if (result.status !== 0) throw new Error('Visual C++ environment initialization failed');
      const env = { ...process.env };
      for (const line of result.stdout.split(/\r?\n/u)) {
        const separator = line.indexOf('=');
        if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1);
      }
      const command = findCommand('cl.exe', env);
      if (command) return { command, msvc: true, env };
    }
  }
  const gcc = findCommand('gcc.exe');
  if (gcc) return { command: gcc, msvc: false, env: process.env };
  throw new Error('A Windows x64 Visual C++ or GCC compiler is required');
}

function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Build this helper on Windows x64');
  }
  const engine = path.resolve(__dirname, '..', 'engine');
  fs.mkdirSync(engine, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(engine, '.private-acl-build-'));
  const output = path.join(temporary, 'ec-private-file-windows-amd64.exe');
  const target = path.join(engine, path.basename(output));
  const source = path.resolve(__dirname, '..', 'lib', 'platform', 'storage', 'native', 'windows-private-file.c');
  try {
    const compiler = compilerEnvironment();
    const args = compiler.msvc
      ? ['/nologo', '/O2', '/W4', '/WX', '/std:c11', '/DUNICODE', '/D_UNICODE',
        source, '/Fe' + output, '/Fo' + path.join(temporary, 'helper.obj'), 'advapi32.lib']
      : ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-municode', '-s',
        '-static-libgcc', source, '-ladvapi32', '-o', output];
    const built = spawnSync(compiler.command, args, {
      env: compiler.env, cwd: temporary, stdio: 'inherit', windowsHide: true,
    });
    if (built.status !== 0) throw new Error('Windows private-file helper compilation failed');
    const version = spawnSync(output, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (version.status !== 0 || version.stdout.trim() !== 'ec-private-file 1') {
      throw new Error('Windows private-file helper verification failed');
    }
    fs.copyFileSync(output, target);
    process.stdout.write(`Windows native private-file helper: ${target}\n`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { compilerEnvironment };
