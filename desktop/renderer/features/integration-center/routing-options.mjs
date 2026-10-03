// Presentation-only intent; no network, Profile lookup or persistent state.
export function createRoutingOptions(document) {
  let mode = 'rules-only';
  let current = null;
  let restore = false;
  return Object.freeze({
    append(parent, adapterId, translate, disabled = false) {
      if (adapterId !== 'clash_mihomo_yaml') return;
      restore = Boolean(current && document.activeElement === current);
      const label = document.createElement('label');
      label.className = 'integration-route-label';
      const caption = document.createElement('span');
      caption.textContent = translate('integration.routingLabel');
      const select = document.createElement('select');
      select.className = 'integration-route-selector';
      select.dataset.integrationRouting = 'clash_mihomo_yaml';
      select.disabled = disabled;
      for (const value of ['rules-only', 'gateway-default']) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = translate(`integration.routing.${value}`);
        select.append(option);
      }
      select.value = mode;
      select.addEventListener('change', () => {
        if (select === current && ['rules-only', 'gateway-default'].includes(select.value)) mode = select.value;
      });
      label.append(caption, select); parent.append(label); current = select;
    },
    request(adapterId, action) {
      return { adapterId, action, ...(adapterId === 'clash_mihomo_yaml' && mode === 'gateway-default'
        ? { routingMode: mode } : {}) };
    },
    restoreFocus() {
      if (restore) current?.focus?.({ preventScroll: true });
      restore = false;
    },
  });
}
