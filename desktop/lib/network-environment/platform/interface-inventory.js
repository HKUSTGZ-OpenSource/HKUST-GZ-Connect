'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

function windowsFallbackId(alias) {
  const digest = crypto.createHash('sha256').update(alias, 'utf8').digest('hex');
  return `win:${digest.slice(0, 60)}`;
}

function kindOf(id, platform) {
  if (/^(?:lo|lo0)$/u.test(id)) return 'loopback';
  if (/^(?:utun|tun|tap|wg|tailscale|ppp|ipsec|vEthernet|Wintun)/iu.test(id)) return 'virtual';
  if (platform === 'linux' && /^(?:en|eth|wl|wlan|wwan|usb)/iu.test(id)) return 'physical';
  if (platform === 'win32' && /virtual|vpn|hyper-v|wsl|loopback/iu.test(id)) return 'virtual';
  return 'unknown';
}

function inventoryFromNode(networkInterfaces, platform, identityForAlias = windowsFallbackId) {
  const aliasesById = new Map();
  return Object.entries(networkInterfaces || {}).map(([name, values]) => {
    const id = platform === 'win32' ? identityForAlias(name) : name;
    if (platform === 'win32') {
      const previousAlias = aliasesById.get(id);
      if (previousAlias !== undefined && previousAlias !== name) {
        throw new Error('Windows network interface fallback identity collision');
      }
      aliasesById.set(id, name);
    }
    return {
      id,
      name,
      kind: kindOf(name, platform),
      active: Array.isArray(values) && values.some(({ internal, address }) => !internal && net.isIP(address)),
      default: false,
      systemDefault: false,
      addresses: (Array.isArray(values) ? values : []).map(({ address, family, internal }) => ({
        address, family: family === 'IPv6' || family === 6 ? 6 : 4, internal: internal === true,
      })),
    };
  });
}

module.exports = { inventoryFromNode, kindOf };
