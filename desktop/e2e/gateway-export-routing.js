'use strict';
// Opt-in native core test. Never reads client profiles or contacts its controller.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { buildGenericExport } = require('../lib/integrations/generic-export-adapters');
const { createProfileNetworkRules } = require('../lib/integrations/profile-network-rules');
const { customProfileDocument } = require('../lib/profiles/onboarding/custom-gateway-onboarding');

const binary = process.env.HKUST_TEST_MIHOMO_BINARY;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
function proxyRequest(port, destination) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: destination });
    request.setTimeout(2000, () => request.destroy(new Error('isolated request timed out')));
    request.once('error', reject);
    request.once('connect', (response, socket) => {
      socket.on('error', reject); socket.write('synthetic request');
      setTimeout(() => { socket.destroy(); resolve(response.statusCode); }, 100);
    });
    request.end();
  });
}

test('isolated native core forwards unmatched hostnames to gateway SOCKS without local DNS', {
  skip: !binary, timeout: 15000,
}, async t => {
  assert.ok(path.isAbsolute(binary) && fs.statSync(binary).isFile(), 'explicit native test binary required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-isolated-routing-'));
  fs.chmodSync(root, 0o700);
  const sockets = new Set();
  const servers = [];
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      const closed = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([closed, delay(1000)]);
      if (child.exitCode === null) { child.kill('SIGKILL'); await closed; }
    }
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(root, { recursive: true, force: true });
  });
  function server(callback) {
    const value = net.createServer(socket => {
      sockets.add(socket); socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket)); callback(socket);
    });
    servers.push(value); return value;
  }
  let directConnections = 0;
  const directPort = await listen(server(() => { directConnections++; }));
  const forwarded = [];
  const socksPort = await listen(server(socket => {
    let state = 'greeting'; let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 1024) return socket.destroy();
      if (state === 'greeting' && buffer.length >= 2 + buffer[1]) {
        assert.equal(buffer[0], 5); buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, 2])); state = 'authentication';
      }
      if (state === 'authentication' && buffer.length >= 2) {
        const passwordOffset = 2 + buffer[1];
        if (buffer.length < passwordOffset + 1 + buffer[passwordOffset]) return;
        buffer = buffer.subarray(passwordOffset + 1 + buffer[passwordOffset]);
        socket.write(Buffer.from([1, 0])); state = 'request';
      }
      if (state === 'request' && buffer.length >= 5) {
        assert.equal(buffer[3], 3, 'domain names must reach SOCKS, not be locally resolved');
        const length = buffer[4]; if (buffer.length < 7 + length) return;
        forwarded.push(buffer.subarray(5, 5 + length).toString('ascii'));
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1])); state = 'done';
      }
    });
  }));
  const networkRules = createProfileNetworkRules({
    profileDocument: customProfileDocument({ profileId: `custom-${'c'.repeat(32)}`,
      origin: 'https://gateway.example.edu', schoolLabel: 'Example University' }),
    userRules: [{ host: 'direct.example.test', includeSubdomains: false, route: 'direct', updatedAt: 1 }],
  });
  for (const routingMode of ['rules-only', 'gateway-default']) {
    const free = net.createServer(); const inbound = await listen(free);
    await new Promise(resolve => free.close(resolve));
    const generated = buildGenericExport({ adapterId: 'clash_mihomo_yaml', port: socksPort,
      networkRules, routingMode, credential: { withStrings: fn => fn('A'.repeat(32), 'B'.repeat(32)) } });
    const document = yaml.load(generated.payload.toString()); generated.payload.fill(0);
    // Every DIRECT test address resolves to loopback. No DNS listener, TUN, controller or system proxy.
    Object.assign(document, { 'mixed-port': inbound, 'bind-address': '127.0.0.1',
      'allow-lan': false, mode: 'rule', 'log-level': 'silent',
      dns: { enable: false }, tun: { enable: false },
      hosts: { ...(routingMode === 'rules-only' ? { 'unrelated.example.test': '127.0.0.1' } : {}),
        'direct.example.test': '127.0.0.1',
        'gateway.example.edu': '127.0.0.1' } });
    const directory = path.join(root, routingMode); fs.mkdirSync(directory, { mode: 0o700 });
    const config = path.join(directory, 'synthetic.yaml');
    fs.writeFileSync(config, yaml.dump(document), { mode: 0o600 });
    const options = { cwd: directory, env: { PATH: process.env.PATH, TMPDIR: root }, stdio: 'ignore' };
    assert.equal(spawnSync(binary, ['-t', '-d', directory, '-f', config], { ...options, timeout: 3000 }).status, 0,
      'native YAML validation must pass');
    child = spawn(binary, ['-d', directory, '-f', config], options);
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      ready = await new Promise(resolve => {
        const socket = net.connect(inbound, '127.0.0.1'); socket.on('error', () => resolve(false));
        socket.on('connect', () => { socket.destroy(); resolve(true); });
      });
      if (ready) break; await delay(50);
    }
    assert.equal(ready, true, 'isolated core must start');
    const before = { direct: directConnections, forwarded: forwarded.length };
    assert.equal(await proxyRequest(inbound, `unrelated.example.test:${directPort}`), 200);
    if (routingMode === 'rules-only') {
      assert.equal(directConnections, before.direct + 1);
      assert.equal(forwarded.length, before.forwarded);
    } else {
      assert.deepEqual(forwarded.slice(before.forwarded), ['unrelated.example.test']);
      assert.equal(directConnections, before.direct);
    }
    for (const host of ['direct.example.test', 'gateway.example.edu']) {
      const count = directConnections;
      assert.equal(await proxyRequest(inbound, `${host}:${directPort}`), 200);
      assert.equal(directConnections, count + 1, 'direct exception and gateway bypass remain direct');
    }
    const closed = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
    await closed; child = null;
  }
});
