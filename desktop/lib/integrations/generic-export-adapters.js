'use strict';

const path = require('node:path');
const net = require('node:net');
const { buildSshProxyCommand } = require('./external-proxy-config');
const { validateProfileNetworkRules } = require('./profile-network-rules');
const { validateIntegrationRoutingMode } = require('./integration-schema');

const GENERIC_EXPORT_ADAPTERS = Object.freeze([
  'clash_mihomo_yaml', 'vscode_remote_ssh',
]);
const MAX_GENERIC_EXPORT_BYTES = 512 * 1024;
const DEFAULT_CLASH_MIXED_PORT = 7890;
const LOCAL_PROXY_SECRET = /^[A-Za-z0-9_-]{16,128}$/u;

function port(value) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1025 || result > 65535) {
    throw new TypeError('integration proxy port is invalid');
  }
  return result;
}

function clashMixedPort(proxyPort) {
  return proxyPort === DEFAULT_CLASH_MIXED_PORT ? DEFAULT_CLASH_MIXED_PORT + 1 : DEFAULT_CLASH_MIXED_PORT;
}

function withCredential(credential, callback) {
  if (!credential || typeof credential.withStrings !== 'function' || typeof callback !== 'function') {
    throw new TypeError('integration proxy credential is unavailable');
  }
  return credential.withStrings((username, password) => {
    if (!LOCAL_PROXY_SECRET.test(username) || !LOCAL_PROXY_SECRET.test(password) ||
        username === password) {
      throw new TypeError('integration proxy credential is invalid');
    }
    return callback(username, password);
  });
}

function nodeName(profileId) {
  return `Campus Connect - ${profileId}`;
}

function clashRuleLines(rulesValue, proxyName) {
  const rules = validateProfileNetworkRules(rulesValue);
  const result = [];
  const seen = new Set();
  const add = (kind, value, target, suffix = '') => {
    const line = `${kind},${value},${target}${suffix}`;
    if (!seen.has(line)) { seen.add(line); result.push(line); }
  };
  for (const host of rules.gatewayBypass) {
    const address = host.replace(/^\[|\]$/gu, '');
    const family = net.isIP(address);
    if (family) add(family === 4 ? 'IP-CIDR' : 'IP-CIDR6',
      `${address}/${family === 4 ? 32 : 128}`, 'DIRECT', ',no-resolve');
    else add('DOMAIN', host, 'DIRECT');
  }
  for (const [source, kind] of [
    ['userExact', 'DOMAIN'],
    ['userSubdomains', 'DOMAIN-SUFFIX'],
    ['customExact', 'DOMAIN'],
    ['serverExact', 'DOMAIN'],
    ['builtinSubdomains', 'DOMAIN-SUFFIX'],
  ]) {
    for (const entry of rules.domainPolicy[source]) {
      add(kind, entry.host, entry.route === 'campus' ? proxyName : 'DIRECT');
    }
  }
  for (const cidr of rules.campusCidrs) add('IP-CIDR', cidr, proxyName, ',no-resolve');
  return Object.freeze(result);
}

function buildClashCompatibleYaml({ adapterId, port: rawPort, credential, networkRules,
  routingMode = 'rules-only' } = {}) {
  if (adapterId !== 'clash_mihomo_yaml') {
    throw new TypeError('Clash-compatible adapter is invalid');
  }
  const rules = validateProfileNetworkRules(networkRules);
  const name = nodeName(rules.profileId);
  validateIntegrationRoutingMode(adapterId, routingMode);
  return withCredential(credential, (username, password) => {
    const proxyPort = port(rawPort);
    const lines = [
      '# Campus Connect Clash / Mihomo export',
      `# Profile: ${rules.profileId}; rules: ${rules.rulesDigest}`,
      `# Routing: ${routingMode}`,
      ...(routingMode === 'gateway-default' ? [
        '# Layout: standalone-gateway',
        `mixed-port: ${clashMixedPort(proxyPort)}`,
        'allow-lan: false',
        'bind-address: "127.0.0.1"',
        'mode: "rule"',
      ] : []),
      'proxies:',
      `  - name: ${JSON.stringify(name)}`,
      '    type: "socks5"',
      '    server: "127.0.0.1"',
      `    port: ${proxyPort}`,
      `    username: ${JSON.stringify(username)}`,
      `    password: ${JSON.stringify(password)}`,
      '    udp: false',
      'rules:',
      ...clashRuleLines(rules, name).map((rule) => `  - ${JSON.stringify(rule)}`),
      ...(routingMode === 'gateway-default' ? [
        '  - "NETWORK,udp,REJECT"', `  - ${JSON.stringify(`MATCH,${name}`)}`,
      ] : []),
    ];
    return `${lines.join('\n')}\n`;
  });
}

function normalizedLocalPath(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value ||
      value === path.parse(value).root || /[\r\n\0]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function buildVscodeRemoteSshSnippet({ helperPath, credentialFile, networkRules } = {}) {
  const rules = validateProfileNetworkRules(networkRules);
  const command = buildSshProxyCommand({
    helperPath: normalizedLocalPath(helperPath, 'VS Code helper path'),
    credentialFile: normalizedLocalPath(credentialFile, 'VS Code credential path'),
    profileId: rules.profileId,
  }).split('\n').at(-1);
  return [
    '# Campus Connect VS Code Remote-SSH snippet',
    '# Replace Host, HostName and User before pasting this block into ~/.ssh/config.',
    'Host campus-connect-server',
    '    HostName replace-with-campus-host',
    '    User replace-with-campus-user',
    `    ${command}`,
    '',
  ].join('\n');
}

function validateClashCompatibleText(text) {
  const lines = text.trimEnd().split('\n');
  const routingMode = lines[2]?.startsWith('# Routing: ') ? lines.splice(2, 1)[0].slice(11) : 'rules-only';
  try { validateIntegrationRoutingMode('clash_mihomo_yaml', routingMode); } catch { return false; }
  const standalone = routingMode === 'gateway-default';
  if (standalone && (lines[2] !== '# Layout: standalone-gateway' ||
      !/^mixed-port: 789[01]$/u.test(lines[3]) ||
      lines[4] !== 'allow-lan: false' || lines[5] !== 'bind-address: "127.0.0.1"' ||
      lines[6] !== 'mode: "rule"')) return false;
  const proxyIndex = standalone ? 7 : 2;
  const rulesIndex = proxyIndex + 8;
  if (lines.length < 12 || lines[0] !== '# Campus Connect Clash / Mihomo export' ||
      !/^# Profile: [a-z0-9-]{1,64}; rules: [a-f0-9]{64}$/u.test(lines[1]) ||
      lines[proxyIndex] !== 'proxies:' || lines[proxyIndex + 2] !== '    type: "socks5"' ||
      lines[proxyIndex + 3] !== '    server: "127.0.0.1"' || lines[rulesIndex] !== 'rules:') return false;
  let name;
  let username;
  let password;
  let proxyPort;
  try {
    name = JSON.parse(lines[proxyIndex + 1].replace(/^  - name: /u, ''));
    username = JSON.parse(lines[proxyIndex + 5].replace(/^    username: /u, ''));
    password = JSON.parse(lines[proxyIndex + 6].replace(/^    password: /u, ''));
    proxyPort = port(Number(lines[proxyIndex + 4].slice('    port: '.length)));
  } catch { return false; }
  const profileId = lines[1].match(/^# Profile: ([a-z0-9-]{1,64});/u)?.[1];
  if (name !== `Campus Connect - ${profileId}` ||
      !/^    port: (?:[1-9][0-9]{3,4})$/u.test(lines[proxyIndex + 4]) || proxyPort < 1025 ||
      !LOCAL_PROXY_SECRET.test(username) || !LOCAL_PROXY_SECRET.test(password) ||
      username === password || lines[proxyIndex + 7] !== '    udp: false') return false;
  if (standalone && lines[3] !== `mixed-port: ${clashMixedPort(proxyPort)}`) return false;
  for (const line of lines.slice(rulesIndex + 1)) {
    if (!line.startsWith('  - ')) return false;
    let rule;
    try { rule = JSON.parse(line.slice(4)); } catch { return false; }
    const fields = String(rule).split(',');
    if (rule === 'NETWORK,udp,REJECT') {
      if (routingMode !== 'gateway-default' || line !== lines.at(-2) ||
          lines.slice(rulesIndex + 1).filter(value => value === line).length !== 1) return false;
      continue;
    }
    if (fields[0] === 'MATCH') {
      if (routingMode !== 'gateway-default' || line !== lines.at(-1) || fields.length !== 2 ||
          fields[1] !== name || lines.slice(rulesIndex + 1).filter(value => value === line).length !== 1) return false;
      continue;
    }
    if (!['DOMAIN', 'DOMAIN-SUFFIX', 'IP-CIDR', 'IP-CIDR6'].includes(fields[0]) || !fields[1] ||
        !['DIRECT', name].includes(fields[2]) ||
        (fields.length === 4 && (!['IP-CIDR', 'IP-CIDR6'].includes(fields[0]) || fields[3] !== 'no-resolve')) ||
        fields.length < 3 || fields.length > 4) return false;
  }
  if (routingMode === 'gateway-default' &&
      (lines.at(-1) !== `  - ${JSON.stringify(`MATCH,${name}`)}` ||
       lines.at(-2) !== '  - "NETWORK,udp,REJECT"')) return false;
  return true;
}

function validateVscodeRemoteSshText(text) {
  const lines = String(text).trimEnd().split('\n');
  return lines.length === 6 &&
    lines[0] === '# Campus Connect VS Code Remote-SSH snippet' &&
    lines[1] === '# Replace Host, HostName and User before pasting this block into ~/.ssh/config.' &&
    lines[2] === 'Host campus-connect-server' &&
    lines[3] === '    HostName replace-with-campus-host' &&
    lines[4] === '    User replace-with-campus-user' &&
    /^    ProxyCommand "[^"\r\n]+ec-proxy-command[^"\r\n]*" --profile-id "[a-z0-9-]{1,64}" --credential-file "[^"\r\n]+" -- %h %p$/u.test(lines[5]);
}

function validateGenericExportPayload(adapterId, payload) {
  if (!GENERIC_EXPORT_ADAPTERS.includes(adapterId) || !Buffer.isBuffer(payload) ||
      !payload.length || payload.length > MAX_GENERIC_EXPORT_BYTES) return false;
  const text = payload.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(payload)) return false;
  if (adapterId === 'clash_mihomo_yaml') {
    return validateClashCompatibleText(text);
  }
  return adapterId === 'vscode_remote_ssh' && validateVscodeRemoteSshText(text);
}

function buildGenericExport({
  adapterId,
  port: rawPort,
  credential = null,
  networkRules,
  helperPath = null,
  credentialFile = null,
  routingMode = 'rules-only',
} = {}) {
  if (!GENERIC_EXPORT_ADAPTERS.includes(adapterId)) {
    throw new TypeError('generic export adapter is unsupported');
  }
  validateIntegrationRoutingMode(adapterId, routingMode);
  const source = adapterId === 'clash_mihomo_yaml'
    ? buildClashCompatibleYaml({ adapterId, port: rawPort, credential, networkRules, routingMode })
    : buildVscodeRemoteSshSnippet({ helperPath, credentialFile, networkRules });
  const payload = Buffer.from(source, 'utf8');
  if (!payload.length || payload.length > MAX_GENERIC_EXPORT_BYTES) {
    payload.fill(0);
    throw new TypeError('generic export payload exceeds its bound');
  }
  return Object.freeze({
    adapterId,
    routingMode,
    payload,
    containsLocalProxyCredential: adapterId !== 'vscode_remote_ssh',
    warningCode: adapterId === 'vscode_remote_ssh'
      ? 'INTEGRATION_CREDENTIAL_SIDECAR_PRIVATE'
      : 'INTEGRATION_LOCAL_CREDENTIAL_PRIVATE',
    ruleCount: adapterId === 'vscode_remote_ssh'
      ? 0
      : clashRuleLines(networkRules, nodeName(networkRules.profileId)).length +
        (routingMode === 'gateway-default' ? 2 : 0),
  });
}

module.exports = {
  GENERIC_EXPORT_ADAPTERS,
  MAX_GENERIC_EXPORT_BYTES,
  DEFAULT_CLASH_MIXED_PORT,
  buildClashCompatibleYaml,
  buildGenericExport,
  buildVscodeRemoteSshSnippet,
  clashRuleLines,
  validateGenericExportPayload,
  withIntegrationCredential: withCredential,
};
