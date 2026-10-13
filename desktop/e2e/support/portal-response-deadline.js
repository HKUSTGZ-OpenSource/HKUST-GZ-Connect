'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { hkustMyPortalSources } = require('../../lib/browser/session/browser-session-manager');

async function assertPortalResponseDeadline(electronSession) {
  const sockets = new Set();
  let stall = true;
  let finishBodyStart;
  const bodyStart = new Promise(resolve => { finishBodyStart = resolve; });
  let finishBodyClose;
  const bodyClose = new Promise(resolve => { finishBodyClose = resolve; });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (stall) {
      response.once('close', finishBodyClose);
      response.flushHeaders();
      response.write('[');
      finishBodyStart();
    } else response.end('[]');
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const targetSession = electronSession.fromPartition('portal-response-deadline-fixture');
  const context = {
    session: targetSession,
    portalUrl: `http://127.0.0.1:${server.address().port}/`,
    checkedAt: 1_800_000_000_000,
    timeoutMs: 500,
  };
  let cleanupTimer;
  try {
    const pending = hkustMyPortalSources.news.read(context);
    const rejected = assert.rejects(pending, { code: 'PORTAL_SOURCE_TIMEOUT' });
    await bodyStart;
    await rejected;
    await Promise.race([
      bodyClose,
      new Promise((_resolve, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error('synthetic portal body did not close')), 2000);
      }),
    ]);
    clearTimeout(cleanupTimer);
    stall = false;
    const value = await hkustMyPortalSources.news.read(context);
    assert.equal(value.state, 'empty', 'same Session must recover after a body deadline');
    assert.deepEqual(value.items, []);
    process.stdout.write('portal response body deadline: PASS (actual Session abort and subsequent read)\n');
  } finally {
    clearTimeout(cleanupTimer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await targetSession.closeAllConnections();
  }
}

module.exports = { assertPortalResponseDeadline };
