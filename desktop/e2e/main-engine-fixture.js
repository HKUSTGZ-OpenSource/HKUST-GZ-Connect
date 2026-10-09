'use strict';

// Test-only process fixture for the real Electron Main lifecycle. It implements
// only the bounded credential prefix, Event API v1 and Control API v2 shutdown
// contract needed by main-engine-lifecycle.electron.js. It opens only a
// loopback readiness listener, forwards no traffic, performs no external
// network request and never records credential values.

const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');

const userData = process.env.HKUSTGZ_USER_DATA_DIR;
if (!userData || !path.isAbsolute(userData)) process.exit(64);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const generation = Number(argument('--generation'));
const bind = argument('--socks-bind');
const configPath = argument('--config');
const port = Number(String(bind).split(':').at(-1));
if (!Number.isSafeInteger(generation) || generation <= 0 ||
    !Number.isInteger(port) || port < 1025 || port > 65535 ||
    !process.argv.includes('--profile-binding-v1-stdin') || !path.isAbsolute(configPath)) {
  process.exit(64);
}
const configBytes = fs.readFileSync(configPath);
const configSha256 = crypto.createHash('sha256').update(configBytes).digest('hex');
const configOrigin = new URL(JSON.parse(configBytes.toString('utf8')).base_url).origin;
const providerCapabilities = Object.fromEntries([
  'auth.password', 'auth.captcha', 'auth.sms', 'auth.token', 'auth.certificate',
  'auth.hid', 'auth.sso', 'auth.device', 'auth.unknown_secondary',
  'resource.catalogue', 'resource.authorization_decision', 'transport.l3',
  'transport.web_vpn',
].map((capability) => [
  capability,
  ['auth.password', 'transport.l3'].includes(capability) ? 'supported' : 'unsupported',
]));

const attemptFile = path.join(userData, 'synthetic-engine-attempt.txt');
const observationFile = path.join(userData, 'synthetic-engine-observations.jsonl');
const stableFirstAttempt = process.env.HKUSTGZ_SYNTHETIC_ENGINE_STABLE_E2E === '1';
const dropAfterConnected = process.env.HKUSTGZ_SYNTHETIC_ENGINE_DROP_AFTER_CONNECTED_E2E === '1';
const holdReadiness = process.env.HKUSTGZ_SYNTHETIC_ENGINE_READY_HOLD_E2E === '1';
const readinessReleaseFile = path.join(userData, 'synthetic-engine-readiness-release.txt');
let attempt = 1;
try { attempt = Number(fs.readFileSync(attemptFile, 'utf8')) + 1; } catch {}
fs.writeFileSync(attemptFile, String(attempt));

function observe(type, detail = {}) {
  fs.appendFileSync(observationFile, `${JSON.stringify({
    attempt,
    generation,
    type,
    ...detail,
  })}\n`);
}

function send(value, callback) {
  observe(value.type, value.type === 'state_changed' ? { state: value.state } : {});
  process.stdout.write(`${JSON.stringify(value)}\n`, callback);
}

function state(stateName, eventGeneration = generation) {
  send({ type: 'state_changed', state: stateName, generation: eventGeneration });
}

let stopping = false;
let listener = null;
function stopCleanly(requestId = null) {
  if (stopping) return;
  stopping = true;
  if (requestId !== null) {
    send({
      type: 'control_result',
      apiVersion: 2,
      requestId,
      status: 'accepted',
    });
  }
  state('stopping');
  const finish = () => send(
    { type: 'stopped', reason: 'user_requested', generation },
    () => process.exit(0),
  );
  if (listener?.listening) listener.close(finish);
  else finish();
}

process.on('SIGTERM', () => stopCleanly());
process.on('SIGINT', () => stopCleanly());

send({ type: 'hello', apiVersion: 1, capabilities: ['password', 'l3'] });

let bindingSeen = false;
let credentialLines = 0;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!bindingSeen) {
    let binding;
    try { binding = JSON.parse(line); } catch { process.exit(64); }
    const keys = Object.keys(binding || {}).sort();
    if (JSON.stringify(keys) !== JSON.stringify([
      'apiVersion', 'configSha256', 'gatewayOrigin', 'profileId', 'profileRevision', 'type',
      'protocolFamily',
    ].sort()) || binding.type !== 'engine_config_binding' || binding.apiVersion !== 1 ||
        binding.configSha256 !== configSha256 || binding.gatewayOrigin !== configOrigin ||
        binding.profileId !== 'hkustgz' || binding.profileRevision !== 1 ||
        binding.protocolFamily !== 'easyconnect-password-modern-l3-v1') {
      process.exit(64);
    }
    bindingSeen = true;
    observe('config_binding_received');
    return;
  }
  if (credentialLines < 2) {
    credentialLines += 1;
    if (credentialLines !== 2) return;
    observe('credentials_received');
    if (fs.existsSync(path.join(userData, 'synthetic-engine-network-failure.txt'))) {
      state('connecting'); state('authenticating');
      send({ type: 'fatal_error', code: 'AUTH_NETWORK_UNAVAILABLE',
        secondaryCode: 'AUTH_CLEANUP_UNCONFIRMED' });
      send({ type: 'stopped', reason: 'startup_failed', generation }, () => process.exit(23));
      return;
    }
    if (attempt === 1 && !stableFirstAttempt) {
      state('connecting');
      state('authenticating');
      state('preparing_tunnel');
      setTimeout(() => {
        send({ type: 'stopped', reason: 'startup_failed', generation }, () => process.exit(23));
      }, 150);
      return;
    }

    state('connected', generation - 1);
    observe('stale_generation_sent', { staleGeneration: generation - 1 });
    const publishReadiness = () => {
      state('connecting');
      state('authenticating');
      state('preparing_tunnel');
      send({ type: 'client_ip_assigned', family: 4, address: '10.20.30.40' });
      send({ type: 'dns_mode', mode: 'gateway' });
      listener = net.createServer((socket) => socket.destroy());
      listener.once('error', (error) => {
        observe('listener_error', { code: String(error?.code || 'unknown') });
        process.exit(70);
      });
      listener.listen(port, '127.0.0.1', () => {
        observe('listener_bound');
        send({ type: 'listener_ready', port });
        observe('listener_ready_sent');
        // Match the production Engine contract: the bound-listener metadata
        // precedes the final connected phase. Main must require both facts.
        setTimeout(() => {
          state('connected');
          observe('connected_candidate_sent');
          if (dropAfterConnected) {
            setTimeout(() => {
              send({ type: 'network_unhealthy', reason: 'data_plane_disconnected' });
              state('stopping');
              listener.close(() => send(
                { type: 'stopped', reason: 'network_unhealthy', generation },
                () => process.exit(23),
              ));
            }, 750);
          }
        }, 300);
      });
    };
    if (holdReadiness) {
      observe('readiness_held');
      const deadline = Date.now() + 10_000;
      const release = () => {
        if (stopping) return;
        if (fs.existsSync(readinessReleaseFile)) { publishReadiness(); return; }
        if (Date.now() >= deadline) { observe('readiness_hold_timeout'); process.exit(70); }
        setTimeout(release, 25);
      };
      release();
    } else setTimeout(publishReadiness, 600);
    return;
  }

  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame?.type === 'hello' && Number.isSafeInteger(frame.requestId)) {
    send({
      type: 'control_hello',
      apiVersion: 2,
      requestId: frame.requestId,
      capabilities: ['engine.shutdown', 'provider.capabilities'],
    });
  } else if (frame?.type === 'request' && frame.apiVersion === 2 &&
      frame.command?.name === 'provider_capabilities' && Number.isSafeInteger(frame.requestId)) {
    observe('provider_capabilities_requested');
    send({
      type: 'provider_capabilities',
      apiVersion: 2,
      requestId: frame.requestId,
      profileId: 'hkustgz',
      profileRevision: 1,
      engineGeneration: generation,
      compiled: providerCapabilities,
      provider: providerCapabilities,
    });
  } else if (frame?.type === 'request' && frame.apiVersion === 2 &&
      frame.command?.name === 'shutdown' && Number.isSafeInteger(frame.requestId)) {
    observe('shutdown_received');
    stopCleanly(frame.requestId);
  }
});

input.on('close', () => {
  if (!stopping) stopCleanly();
});
