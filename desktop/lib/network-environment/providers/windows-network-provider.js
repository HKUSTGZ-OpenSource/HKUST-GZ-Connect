'use strict';

const { mihomoOwner, windowsProcessTable } = require('./proxy/mihomo-controller-provider');

function parsePowershellSnapshot(output) {
  try {
    const value = JSON.parse(String(output || ''));
    const adapters = Array.isArray(value.adapters) ? value.adapters : value.adapters ? [value.adapters] : [];
    const routes = (Array.isArray(value.routes) ? value.routes : value.routes ? [value.routes] : [])
      .map((route) => ({ interfaceIndex: Number(route.InterfaceIndex),
        metric: (Number(route.RouteMetric) || 0) + (Number(route.InterfaceMetric) || 0) }))
      .filter(({ interfaceIndex }) => interfaceIndex > 0)
      .sort((left, right) => left.metric - right.metric);
    const byName = new Map(adapters.map((adapter) => [String(adapter.InterfaceAlias || ''), adapter]));
    return { routes, byName, proxy: value.proxy || null,
      processes: Array.isArray(value.processes) ? value.processes : value.processes ? [value.processes] : [] };
  } catch { return { routes: [], byName: new Map(), proxy: null, processes: [] }; }
}

function windowsProxy(output) {
  try {
    const value = typeof output === 'string' ? JSON.parse(String(output || '')) : output || {};
    if (!value.enabled && typeof value.autoConfigUrl === 'string' && value.autoConfigUrl) {
      return { state: 'detected', type: 'pac', endpoint: null, owner: {} };
    }
    if (!value.enabled || typeof value.server !== 'string') {
      return { state: value.enabled === false ? 'disabled' : 'unknown', type: 'unknown', endpoint: null, owner: {} };
    }
    const entry = value.server.split(';').map((item) => item.split('=').pop()).find(Boolean) || '';
    const match = entry.match(/^([^:]+):(\d+)$/u);
    return match ? { state: 'detected', type: 'mixed', endpoint: { host: match[1], port: Number(match[2]) }, owner: {} }
      : { state: 'unknown', type: 'unknown', endpoint: null, owner: {} };
  } catch { return { state: 'unknown', type: 'unknown', endpoint: null, owner: {} }; }
}

async function detectWindows({ interfaces, run }) {
  const script = "$a=Get-NetAdapter|Select InterfaceAlias,InterfaceIndex,Status,HardwareInterface;" +
    "$m=@{};Get-NetIPInterface -AddressFamily IPv4|ForEach-Object{$m[$_.InterfaceIndex]=$_.InterfaceMetric};" +
    "$r=Get-NetRoute -DestinationPrefix '0.0.0.0/0'|Select InterfaceIndex,RouteMetric,@{n='InterfaceMetric';e={$m[$_.InterfaceIndex]}};" +
    "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';" +
    "$x=Get-CimInstance Win32_Process|Where-Object{$_.Name -match 'mihomo|clash' -or $_.CommandLine -match 'mihomo|clash'}|Select ProcessId,Name,CommandLine;" +
    "@{adapters=$a;routes=$r;proxy=@{enabled=[bool]$p.ProxyEnable;server=$p.ProxyServer;autoConfigUrl=$p.AutoConfigURL};processes=$x}|ConvertTo-Json -Depth 5 -Compress";
  const parsed = parsePowershellSnapshot(await run('powershell.exe', ['-NoProfile', '-NonInteractive',
    '-Command', script], { timeout: 2500 }));
  const byIndex = new Map([...parsed.byName.values()].map((adapter) => [Number(adapter.InterfaceIndex), adapter]));
  const systemRoute = parsed.routes[0] || null;
  const physicalRoute = parsed.routes.find((route) => (
    byIndex.get(route.interfaceIndex)?.HardwareInterface === true
  )) || null;
  const proxy = windowsProxy(parsed.proxy);
  const processes = windowsProcessTable(JSON.stringify(parsed.processes));
  const owner = await mihomoOwner({ processes, endpoint: proxy.endpoint, run, platform: 'win32' });
  const projected = interfaces.map((item) => {
    const adapter = parsed.byName.get(item.name);
    return { ...item, id: adapter ? `if:${Number(adapter.InterfaceIndex)}` : item.id,
      active: adapter ? adapter.Status === 'Up' : item.active,
      default: Number(adapter?.InterfaceIndex) === physicalRoute?.interfaceIndex,
      systemDefault: Number(adapter?.InterfaceIndex) === systemRoute?.interfaceIndex,
      kind: adapter?.HardwareInterface === true ? 'physical' : adapter ? 'virtual' : item.kind,
      name: adapter?.InterfaceAlias || item.name };
  });
  return { platform: 'win32', status: physicalRoute ? 'ready' : 'partial',
    interfaces: projected, systemProxy: { ...proxy, owner: owner || proxy.owner } };
}

module.exports = { detectWindows, parsePowershellSnapshot, windowsProxy };
