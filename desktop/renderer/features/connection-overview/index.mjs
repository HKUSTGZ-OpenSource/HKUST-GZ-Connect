function buildUnderlayOptions(environment = {}, t = key => key) {
  const interfaces = Array.isArray(environment.interfaces) ? environment.interfaces : [];
  const defaultAdapter = interfaces.find(({ default: activeDefault }) => activeDefault) || null;
  const defaultAddress = environment.defaultRoute?.sourceAddress || '';
  const selectionAvailable = environment.selection?.available !== false;
  const rawSelected = environment.selection?.mode === 'selected'
    ? environment.selection.sourceAddress : '';
  const selectedValue = selectionAvailable ? (rawSelected === defaultAddress ? '' : rawSelected) : null;
  const ordered = interfaces.filter(({ active, kind }) => active && kind !== 'loopback')
    .sort((left, right) => Number(right.id === environment.selection?.interfaceId) -
      Number(left.id === environment.selection?.interfaceId) ||
      Number(right.default === true) - Number(left.default === true));
  const options = [];
  for (const item of ordered) {
    const seen = new Set();
    const sources = [];
    const candidates = (item.addresses || []).filter(({ selectable }) => selectable)
      .sort((left, right) => Number(right.address === defaultAddress) -
        Number(left.address === defaultAddress) || left.family - right.family);
    for (const candidate of candidates) {
      if (seen.has(candidate.address)) continue;
      seen.add(candidate.address);
      const value = item === defaultAdapter && candidate.address === defaultAddress
        ? '' : candidate.address;
      sources.push({
        value,
        localAddress: candidate.address,
        family: candidate.family,
        publicEgress: candidate.publicEgress || null,
        selected: selectionAvailable && selectedValue === value &&
          (value === '' || item.id === environment.selection?.interfaceId),
      });
    }
    if (!sources.length && item === defaultAdapter && defaultAddress) {
      sources.push({ value: '', localAddress: defaultAddress, family: 0,
        publicEgress: null, selected: selectionAvailable && selectedValue === '' });
    }
    if (!sources.length) continue;
    options.push({
      interfaceId: item.id,
      title: item.name === item.id ? item.name : `${item.name} · ${item.id}`,
      kind: item.kind,
      badge: t(item.kind === 'virtual' ? 'connect.treeVirtual' : 'connect.treePhysical'),
      selected: sources.some(({ selected }) => selected),
      sources,
    });
  }
  if (!options.length) {
    options.push({ interfaceId: '', title: t('connect.defaultDirect'), kind: 'unknown',
      badge: t('connect.treeDefault'), selected: selectionAvailable,
      sources: [{ value: '', localAddress: defaultAddress || '', family: 0,
        publicEgress: null, selected: selectionAvailable }] });
  }
  return options;
}

function sparkline(values) {
  if (!values.length) return 'M2 24 L118 24';
  const safe = values.map(value => Math.max(0, Math.min(1200, Number(value) || 0)));
  const min = Math.min(...safe), max = Math.max(...safe, min + 1);
  return safe.map((value, index) => {
    const x = 2 + (index * 116 / Math.max(1, safe.length - 1));
    const y = 27 - ((value - min) * 23 / (max - min));
    return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

function networkPathSummary(options, t = key => key) {
  const selectedOption = (Array.isArray(options) ? options : []).find(({ selected }) => selected)
    || (Array.isArray(options) ? options[0] : null);
  const selectedSource = selectedOption?.sources?.find(({ selected }) => selected)
    || selectedOption?.sources?.[0] || null;
  const egress = selectedSource?.publicEgress;
  const publicText = egress?.status === 'ready'
    ? t('connect.publicEgressValue', { address: egress.address })
    : t(egress?.status === 'probing' ? 'connect.publicEgressDetecting'
      : egress?.status === 'unavailable' ? 'connect.publicEgressUnavailable'
        : 'connect.publicEgressPending');
  const relation = selectedSource?.value === ''
    ? t('connect.defaultDirectShort') : t('connect.treeCurrent');
  return Object.freeze({
    title: selectedOption?.title || t('connect.defaultDirect'),
    detail: `${publicText} · ${relation}`,
  });
}

function create({ document, translate = key => key, copy, save, refresh, getEnvironment,
  subscribeEnvironment, timers } = {}) {
  if (!document || typeof document.getElementById !== 'function' ||
      typeof document.querySelector !== 'function' || typeof document.createElement !== 'function' ||
      typeof translate !== 'function' || !timers || typeof timers.setTimeout !== 'function' ||
      typeof timers.clearTimeout !== 'function') {
    throw new TypeError('connection overview dependencies are incomplete');
  }

  const latencyHistory = [];
  const unlisten = [];
  const pendingTimers = new Set();
  let started = false;
  let disposed = false;
  let savingUnderlay = false;
  let environmentRequest = null;
  let environmentGeneration = 0;
  let unsubscribeEnvironment = null;

  const byId = id => document.getElementById(id);
  const listen = (target, type, handler) => {
    if (!target?.addEventListener || !target?.removeEventListener) {
      throw new TypeError('connection overview listener target is invalid');
    }
    const guarded = event => { if (!disposed) return handler(event); };
    target.addEventListener(type, guarded);
    unlisten.push(() => target.removeEventListener(type, guarded));
  };

  function renderEnvironment(environment, t = translate) {
    if (disposed || !environment || typeof environment !== 'object') return;
    const optionContainer = byId('underlayTreeOptions');
    const options = buildUnderlayOptions(environment, t);
    const summary = networkPathSummary(options, t);
    const currentExit = byId('currentNetworkExit');
    const currentExitHint = byId('currentNetworkExitHint');
    const detailsSummary = byId('networkPathDetailsSummary');
    if (currentExit) currentExit.textContent = summary.title;
    if (currentExitHint) currentExitHint.textContent = summary.detail;
    if (detailsSummary) detailsSummary.textContent = t('connect.networkPathSummary', summary);
    const focusedAddress = document.activeElement?.dataset?.underlayAddress;
    optionContainer.setAttribute('role', 'radiogroup');
    optionContainer.setAttribute('aria-label', t('connect.treeUnderlay'));
    optionContainer.replaceChildren(...options.map(option => {
      const card = document.createElement('section');
      card.className = `network-underlay-interface${option.selected ? ' active' : ''}`;
      card.dataset.underlayInterface = option.interfaceId;
      const line = document.createElement('span'); line.className = 'network-underlay-line';
      line.setAttribute('aria-hidden', 'true');
      const heading = document.createElement('div'); heading.className = 'network-interface-heading';
      const icon = document.createElement('span'); icon.className = 'network-tree-icon';
      icon.setAttribute('aria-hidden', 'true'); icon.textContent = option.kind === 'virtual' ? '◇' : '⇄';
      const title = document.createElement('strong'); title.textContent = option.title;
      const badge = document.createElement('span'); badge.className = 'network-underlay-badge';
      badge.textContent = option.selected ? t('connect.treeCurrent') : option.badge;
      heading.append(icon, title, badge);
      const sourceList = document.createElement('div'); sourceList.className = 'network-source-list';
      for (const source of option.sources) {
        const egress = source.publicEgress;
        const publicText = egress?.status === 'ready'
          ? t('connect.publicEgressValue', { address: egress.address })
          : t(egress?.status === 'probing' ? 'connect.publicEgressDetecting'
            : egress?.status === 'unavailable' ? 'connect.publicEgressUnavailable'
              : 'connect.publicEgressPending');
        const relationKey = egress?.relation === 'baseline' ? 'connect.egressBaseline'
          : egress?.relation === 'same' ? 'connect.egressSame'
            : egress?.relation === 'different' ? 'connect.egressDifferent'
              : 'connect.egressUnknown';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `network-underlay-source${source.selected ? ' active' : ''}`;
        button.dataset.underlayAddress = source.value;
        button.disabled = savingUnderlay;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(source.selected));
        button.setAttribute('aria-label', t('connect.treeUseUnderlayObserved', {
          name: option.title,
          local: source.localAddress || t('connect.notDetected'),
          public: publicText,
          relation: t(relationKey),
        }));
        const marker = document.createElement('span'); marker.className = 'network-source-marker';
        marker.setAttribute('aria-hidden', 'true');
        const copyContent = document.createElement('span'); copyContent.className = 'network-underlay-copy';
        const publicLine = document.createElement('strong'); publicLine.textContent = publicText;
        const localLine = document.createElement('small');
        localLine.textContent = t('connect.localAddressValue', {
          address: source.localAddress || t('connect.notDetected'),
        });
        copyContent.append(publicLine, localLine);
        const relation = document.createElement('span');
        relation.className = `network-egress-relation ${egress?.relation || 'unknown'}`;
        relation.textContent = t(relationKey);
        button.append(marker, copyContent, relation);
        sourceList.append(button);
      }
      card.append(line, heading, sourceList);
      return card;
    }));
    if (focusedAddress !== undefined) {
      const target = [...optionContainer.querySelectorAll('[data-underlay-address]')]
        .find(node => node.dataset.underlayAddress === focusedAddress);
      target?.focus?.({ preventScroll: true });
    }
    optionContainer.dataset.available = String(environment.selection?.available !== false);
  }

  function renderStatus(state = {}, t = translate) {
    if (disposed) return;
    const connected = state.connected === true;
    const busy = state.connecting === true;
    const tunnelNode = document.querySelector('[data-topology-node="tunnel"]');
    tunnelNode.dataset.status = connected ? 'healthy' : busy ? 'warning' : state.lastError ? 'error' : 'inactive';
    byId('tunnelSummary').textContent = t(connected ? 'connect.tunnelReady' : busy ? 'connect.tunnelConnecting' : 'connect.tunnelInactive');
    byId('notificationAttention').hidden = !state.lastError && !state.notice;
    if (state.networkEnvironment) renderEnvironment(state.networkEnvironment, t);
  }

  function renderTelemetry(telemetry = {}) {
    if (disposed) return;
    if (Number.isFinite(telemetry.latencyMs)) {
      latencyHistory.push(telemetry.latencyMs);
      if (latencyHistory.length > 24) latencyHistory.shift();
    }
    const svg = byId('latencySparkline');
    if (svg) svg.innerHTML = `<path d="${sparkline(latencyHistory)}"/>`;
  }

  function refreshEnvironment(enabled = true) {
    if (disposed || enabled !== true || typeof getEnvironment !== 'function' ||
        environmentRequest || document.hidden) {
      return environmentRequest || Promise.resolve(null);
    }
    const generation = ++environmentGeneration;
    environmentRequest = Promise.resolve().then(() => getEnvironment()).then(environment => {
      if (disposed || generation !== environmentGeneration) return null;
      if (environment && typeof environment === 'object') renderEnvironment(environment);
      return environment;
    }).catch(() => null).finally(() => {
      if (generation === environmentGeneration) environmentRequest = null;
    });
    return environmentRequest;
  }

  async function onCopyTunnelIp() {
    const value = byId('stIp').textContent.trim();
    if (!value || value === '—' || typeof copy !== 'function') return;
    await copy(value);
    if (disposed) return;
    const button = byId('copyTunnelIp');
    const previous = button.textContent;
    button.textContent = translate('connect.copied');
    let timer;
    timer = timers.setTimeout(() => {
      pendingTimers.delete(timer);
      if (!disposed) button.textContent = previous;
    }, 1200);
    pendingTimers.add(timer);
  }

  async function onUnderlayClick(event) {
    const target = event.target?.closest?.('[data-underlay-address]');
    if (!target || target.getAttribute('aria-checked') === 'true' ||
        typeof save !== 'function' || savingUnderlay || disposed) return;
    savingUnderlay = true;
    for (const button of byId('underlayTreeOptions').querySelectorAll('button')) button.disabled = true;
    target.classList.add('pending');
    const status = byId('underlaySelectionStatus');
    status.textContent = translate('connect.applyingUnderlay');
    try {
      const result = await save({ underlaySourceAddress: target.dataset.underlayAddress });
      if (disposed) return;
      status.textContent = result?.ok ? translate('connect.underlayApplied')
        : (result?.error || translate('tower.saveFailed'));
      await refresh?.();
    } catch (error) {
      if (!disposed) status.textContent = error?.message || translate('tower.saveFailed');
    } finally {
      savingUnderlay = false;
      if (!disposed) {
        target.classList.remove('pending');
        for (const button of byId('underlayTreeOptions').querySelectorAll('button')) button.disabled = false;
      }
    }
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    started = false;
    savingUnderlay = false;
    environmentGeneration += 1;
    environmentRequest = null;
    latencyHistory.length = 0;
    const errors = [];
    const attempt = cleanup => { try { cleanup(); } catch (error) { errors.push(error); } };
    if (unsubscribeEnvironment) attempt(unsubscribeEnvironment);
    unsubscribeEnvironment = null;
    for (const remove of unlisten.splice(0).reverse()) attempt(remove);
    for (const timer of pendingTimers) attempt(() => timers.clearTimeout(timer));
    pendingTimers.clear();
    if (errors.length) throw new AggregateError(errors, 'connection overview cleanup failed');
    return true;
  }

  function start() {
    if (started || disposed) return false;
    started = true;
    try {
      if (typeof subscribeEnvironment === 'function') {
        const unsubscribe = subscribeEnvironment(environment => {
          if (!disposed) renderEnvironment(environment);
        });
        if (typeof unsubscribe === 'function') unsubscribeEnvironment = unsubscribe;
      }
      listen(byId('copyTunnelIp'), 'click', onCopyTunnelIp);
      listen(byId('underlayTreeOptions'), 'click', onUnderlayClick);
      return true;
    } catch (primary) {
      try { dispose(); }
      catch (cleanup) { throw new AggregateError([primary, cleanup], 'connection overview startup failed'); }
      throw primary;
    }
  }

  return Object.freeze({
    dispose,
    refreshEnvironment,
    renderEnvironment,
    renderStatus,
    renderTelemetry,
    start,
  });
}

export { buildUnderlayOptions, create, networkPathSummary, sparkline };
