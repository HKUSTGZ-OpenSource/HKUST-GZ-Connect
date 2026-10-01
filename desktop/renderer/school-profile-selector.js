(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.schoolProfileSelector = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const OTHER_PROFILE = '__other_school__';
  const MAX_CONFIRMATION_DELAY_MS = 300_000;

  function text(value, maxLength) {
    return typeof value === 'string' && value.length >= 1 && value.length <= maxLength &&
      !/[\u0000-\u001f\u007f<>]/u.test(value);
  }

  function profileView(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !text(value.profileId, 80) || !text(value.schoolName, 160) ||
        !text(value.shortName, 80) || !text(value.normalizedGatewayOrigin, 2048) ||
        typeof value.unverified !== 'boolean' || typeof value.active !== 'boolean') return null;
    try {
      const origin = new URL(value.normalizedGatewayOrigin);
      if (origin.protocol !== 'https:' || origin.username || origin.password ||
          origin.pathname !== '/' || origin.search || origin.hash) return null;
    } catch { return null; }
    return Object.freeze({
      profileId: value.profileId,
      schoolName: value.schoolName,
      shortName: value.shortName,
      bundledAssetKey: value.bundledAssetKey === 'hkustgz-logo' ? 'hkustgz-logo' : null,
      normalizedGatewayOrigin: value.normalizedGatewayOrigin,
      unverified: value.unverified,
      active: value.active,
    });
  }

  function confirmationView(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !text(value.confirmationHandle, 64) || !text(value.normalizedOrigin, 2048) ||
        !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 ||
        (value.reportedVersion !== null && !text(value.reportedVersion, 32)) ||
        value.unverified !== true) return null;
    if (value.leafSha256 != null && (typeof value.leafSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.leafSha256))) return null;
    try {
      const origin = new URL(value.normalizedOrigin);
      if (origin.protocol !== 'https:' || origin.username || origin.password ||
          origin.pathname !== '/' || origin.search || origin.hash) return null;
    } catch { return null; }
    return Object.freeze({
      confirmationHandle: value.confirmationHandle,
      normalizedOrigin: value.normalizedOrigin,
      reportedVersion: value.reportedVersion,
      expiresAt: value.expiresAt,
      unverified: true,
      leafSha256: value.leafSha256 ?? null,
    });
  }

  function createSchoolProfileSelector({
    api,
    document,
    translate,
    now = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    for (const method of [
      'listSchoolProfiles', 'probeCustomGateway', 'confirmCustomGateway',
      'cancelCustomGateway', 'switchSchoolProfile', 'deleteSchoolProfile',
    ]) {
      if (typeof api?.[method] !== 'function') {
        throw new TypeError('school selector API is incomplete');
      }
    }
    if (!document || typeof document.getElementById !== 'function' ||
        typeof document.createElement !== 'function' || typeof translate !== 'function' ||
        typeof now !== 'function' || typeof setTimeoutFn !== 'function' ||
        typeof clearTimeoutFn !== 'function') {
      throw new TypeError('school selector environment is incomplete');
    }
    const ids = [
      'schoolProfileSelect', 'switchSchoolProfile', 'schoolProfileStatus',
      'customSchoolPanel', 'customSchoolName', 'customGatewayOrigin',
      'probeCustomGateway', 'cancelCustomGateway', 'customGatewayConfirmation',
      'customGatewaySummary', 'confirmCustomGateway', 'backCustomGateway',
      'schoolProfileError', 'brandLogo', 'brandFallback', 'brandTitle', 'brandSub',
      'titlebarText', 'connectSchoolName', 'gatewaySchoolName', 'gwName', 'settingsGateway',
      'schoolPicker', 'lgUser', 'lgPass', 'lgBtn', 'profileTrustBadge', 'settingsTrustBadge',
      'deleteSchoolProfile',
    ];
    const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    if (Object.values(elements).some((element) => !element)) {
      throw new TypeError('school selector markup is incomplete');
    }
    const leafInput = document.getElementById('customGatewayLeafSha256');
    let t = translate;
    let profiles = [];
    let active = null;
    let confirmation = null;
    let expiryTimer = null;
    let busy = false;
    let bound = false;
    let customGatewayEnabled = false;
    let deleteArmedProfileId = null;

    function setError(message = '') { elements.schoolProfileError.textContent = message; }
    function codeMessage(code) {
      const known = new Set([
        'GATEWAY_PROBE_ALREADY_RUNNING', 'GATEWAY_PROBE_CANCELLED', 'GATEWAY_PROBE_FAILED',
        'GATEWAY_PROBE_OUTPUT_INVALID', 'GATEWAY_PROBE_START_FAILED', 'GATEWAY_PROBE_TIMEOUT',
        'GATEWAY_PROBE_UNSUPPORTED', 'PROFILE_CONFIRMATION_STALE',
        'PROFILE_ONBOARDING_NOT_READY', 'PROFILE_ONBOARDING_DISABLED',
        'PROFILE_PROVISIONING_FAILED', 'PROFILE_LIST_FAILED',
        'PROFILE_ALREADY_ACTIVE', 'PROFILE_UNAVAILABLE', 'PROFILE_SWITCH_NOT_READY',
        'PROFILE_SWITCH_FAILED', 'PROFILE_DELETE_NOT_ALLOWED', 'PROFILE_DELETE_INCOMPLETE',
      ]);
      if (/^ACTIVE_CONTEXT_SWITCH_[A-Z_]{1,64}$/u.test(String(code || ''))) {
        return t('school.error.PROFILE_SWITCH_FAILED');
      }
      return t(`school.error.${known.has(code) ? code : 'generic'}`);
    }
    function clearExpiry() {
      if (expiryTimer !== null) clearTimeoutFn(expiryTimer);
      expiryTimer = null;
    }
    function clearConfirmation() {
      clearExpiry();
      confirmation = null;
      elements.customGatewayConfirmation.hidden = true;
      elements.customGatewaySummary.textContent = '';
    }
    function setBusy(value, status = '') {
      busy = value === true;
      if (leafInput) leafInput.disabled = busy;
      for (const element of [
        elements.schoolProfileSelect, elements.switchSchoolProfile,
        elements.deleteSchoolProfile,
        elements.customSchoolName, elements.customGatewayOrigin,
        elements.probeCustomGateway, elements.cancelCustomGateway,
        elements.confirmCustomGateway, elements.backCustomGateway,
      ]) element.disabled = busy;
      elements.schoolProfileStatus.textContent = status;
      if (!busy) updateSelection();
    }
    function applyActiveProfile(raw) {
      const view = profileView({ ...raw, active: true });
      if (!view) return false;
      active = view;
      const product = 'HKUST(GZ) Connect';
      document.title = product;
      elements.titlebarText.textContent = product;
      const base = document.createElement('span'); base.textContent = 'HKUST';
      const accent = document.createElement('span'); accent.className = 'paren'; accent.textContent = '(GZ)';
      const suffix = document.createElement('span'); suffix.textContent = ' Connect';
      elements.brandTitle.replaceChildren(base, accent, suffix);
      elements.brandSub.textContent = `${view.schoolName} · ${t('school.campusVpn')}` +
        `${view.unverified ? ` · ${t('school.unverified')}` : ''}`;
      elements.connectSchoolName.textContent = view.schoolName;
      elements.gatewaySchoolName.textContent = view.schoolName;
      elements.gwName.textContent = new URL(view.normalizedGatewayOrigin).host;
      elements.settingsGateway.textContent = view.normalizedGatewayOrigin;
      const reviewedLogo = view.bundledAssetKey === 'hkustgz-logo';
      elements.brandLogo.hidden = !reviewedLogo;
      elements.brandFallback.hidden = reviewedLogo;
      elements.brandFallback.textContent = view.shortName.slice(0, 1).toUpperCase();
      for (const badge of [elements.profileTrustBadge, elements.settingsTrustBadge]) {
        badge.hidden = !view.unverified;
        badge.textContent = t('school.unverified');
      }
      return true;
    }
    function option(value, label) {
      const item = document.createElement('option');
      item.value = value;
      item.textContent = label;
      return item;
    }
    function renderProfiles(preferred = null) {
      const items = profiles.map((profile) => option(
        profile.profileId,
        `${profile.schoolName}${profile.active ? ` · ${t('school.current')}` : ''}` +
          `${profile.unverified ? ` · ${t('school.unverified')}` : ''}`,
      ));
      if (customGatewayEnabled) items.push(option(OTHER_PROFILE, t('school.other')));
      elements.schoolProfileSelect.replaceChildren(...items);
      elements.schoolPicker.hidden = profiles.length === 1 && !customGatewayEnabled;
      const available = profiles.some((profile) => profile.profileId === preferred);
      elements.schoolProfileSelect.value = available
        ? preferred
        : profiles.find((profile) => profile.active)?.profileId ||
          (customGatewayEnabled ? OTHER_PROFILE : '');
      updateSelection();
    }
    function credentialProfileId() {
      if (busy || confirmation) return null;
      const selected = profiles.find((candidate) => (
        candidate.profileId === elements.schoolProfileSelect.value
      ));
      return selected?.active ? selected.profileId : null;
    }
    function updateCredentialGate() {
      const enabled = credentialProfileId() !== null;
      elements.lgUser.disabled = !enabled;
      elements.lgPass.disabled = !enabled;
      elements.lgBtn.disabled = !enabled;
    }
    function updateSelection() {
      const selected = elements.schoolProfileSelect.value;
      const other = customGatewayEnabled && selected === OTHER_PROFILE;
      const profile = profiles.find((candidate) => candidate.profileId === selected) || null;
      elements.customSchoolPanel.hidden = !other || confirmation !== null;
      elements.switchSchoolProfile.hidden = other;
      elements.switchSchoolProfile.disabled = busy || !profile || profile.active;
      elements.switchSchoolProfile.textContent = profile?.active
        ? t('school.current') : t('school.switch');
      const deletable = profile?.unverified === true && profile.active !== true;
      elements.deleteSchoolProfile.hidden = !deletable;
      elements.deleteSchoolProfile.disabled = busy || !deletable;
      elements.deleteSchoolProfile.textContent = deleteArmedProfileId === profile?.profileId
        ? t('school.confirmDelete') : t('school.delete');
      if (profile?.active) applyActiveProfile(profile);
      updateCredentialGate();
    }
    async function refresh(preferred = null) {
      const result = await api.listSchoolProfiles();
      if (!result?.ok || !Array.isArray(result.profiles)) {
        profiles = [];
        customGatewayEnabled = false;
        setError(codeMessage(result?.code || 'PROFILE_LIST_FAILED'));
        renderProfiles(OTHER_PROFILE);
        return false;
      }
      customGatewayEnabled = result.customGatewayEnabled === true;
      profiles = result.profiles.map(profileView).filter(Boolean);
      if (profiles.length !== result.profiles.length || profiles.length > 64) {
        profiles = [];
        setError(codeMessage('PROFILE_LIST_FAILED'));
        renderProfiles(OTHER_PROFILE);
        return false;
      }
      const current = profiles.find((profile) => profile.active);
      if (current) applyActiveProfile(current);
      elements.schoolProfileStatus.textContent = '';
      setError();
      renderProfiles(preferred);
      return true;
    }
    async function cancel({ closePanel = true } = {}) {
      clearConfirmation();
      try { await api.cancelCustomGateway(); } catch {}
      if (closePanel) {
        elements.schoolProfileSelect.value = profiles.find((profile) => profile.active)?.profileId ||
          (customGatewayEnabled ? OTHER_PROFILE : '');
        updateSelection();
      } else if (customGatewayEnabled) {
        elements.customSchoolPanel.hidden = false;
      }
      setBusy(false);
    }
    async function probe() {
      if (busy || !customGatewayEnabled) return;
      const origin = elements.customGatewayOrigin.value.trim();
      if (!origin) { setError(t('school.error.gatewayRequired')); return; }
      const leafSha256 = (leafInput?.value || '').replace(/[:\s]/gu, '').toLowerCase();
      if (leafSha256 && !/^[a-f0-9]{64}$/u.test(leafSha256)) {
        setError(t('school.error.fingerprintInvalid')); return;
      }
      clearConfirmation();
      setError();
      setBusy(true, t('school.checking'));
      let result;
      try {
        result = await api.probeCustomGateway({
          origin,
          schoolLabel: elements.customSchoolName.value.trim(),
          ...(leafSha256 ? { leafSha256 } : {}),
        });
      } catch { result = { ok: false, code: 'generic' }; }
      if (!result?.ok) {
        setBusy(false);
        setError(codeMessage(result?.code));
        return;
      }
      confirmation = confirmationView(result.confirmation);
      if (!confirmation) {
        setBusy(false);
        setError(codeMessage('generic'));
        return;
      }
      elements.customSchoolPanel.hidden = true;
      elements.customGatewayConfirmation.hidden = false;
      elements.customGatewaySummary.textContent = t('school.confirmSummary', {
        origin: confirmation.normalizedOrigin,
        version: confirmation.reportedVersion || t('school.versionUnknown'),
      }) + (confirmation.leafSha256 ? `\n${t('school.tlsConfirmed', { fingerprint: confirmation.leafSha256 })}` : '');
      const remaining = Math.min(MAX_CONFIRMATION_DELAY_MS,
        Math.max(0, confirmation.expiresAt - now()));
      expiryTimer = setTimeoutFn(() => {
        clearConfirmation();
        api.cancelCustomGateway().catch(() => {});
        elements.customSchoolPanel.hidden = false;
        setBusy(false);
        setError(codeMessage('PROFILE_CONFIRMATION_STALE'));
      }, remaining);
      expiryTimer?.unref?.();
      setBusy(false);
    }
    async function confirm() {
      if (busy || !confirmation) return;
      const handle = confirmation.confirmationHandle;
      setError();
      setBusy(true, t('school.creating'));
      let created;
      try { created = await api.confirmCustomGateway({ confirmationHandle: handle }); }
      catch { created = { ok: false, code: 'generic' }; }
      clearConfirmation();
      if (!created?.ok || !text(created.profileId, 80)) {
        elements.customSchoolPanel.hidden = false;
        setBusy(false);
        setError(codeMessage(created?.code));
        return;
      }
      elements.schoolProfileStatus.textContent = t('school.switching');
      let switched;
      try { switched = await api.switchSchoolProfile({ profileId: created.profileId }); }
      catch { switched = { ok: false, code: 'generic' }; }
      if (!switched?.ok) {
        await refresh(created.profileId);
        setBusy(false);
        setError(codeMessage(switched?.code));
      }
    }
    async function switchExisting() {
      if (busy) return;
      const profile = profiles.find((candidate) => (
        candidate.profileId === elements.schoolProfileSelect.value
      ));
      if (!profile || profile.active) return;
      setError();
      setBusy(true, t('school.switching'));
      let result;
      try { result = await api.switchSchoolProfile({ profileId: profile.profileId }); }
      catch { result = { ok: false, code: 'generic' }; }
      if (!result?.ok) {
        setBusy(false);
        setError(codeMessage(result?.code));
      }
    }
    async function deleteExisting() {
      if (busy) return;
      const profile = profiles.find((candidate) => (
        candidate.profileId === elements.schoolProfileSelect.value
      ));
      if (!profile?.unverified || profile.active) return;
      if (deleteArmedProfileId !== profile.profileId) {
        deleteArmedProfileId = profile.profileId;
        updateSelection();
        return;
      }
      deleteArmedProfileId = null;
      setBusy(true, t('school.deleting'));
      let result;
      try { result = await api.deleteSchoolProfile({ profileId: profile.profileId }); }
      catch { result = { ok: false, code: 'PROFILE_DELETE_INCOMPLETE' }; }
      if (!result?.ok) {
        setBusy(false);
        setError(codeMessage(result?.code));
        return;
      }
      await refresh(active?.profileId || null);
      setBusy(false);
    }
    function bind() {
      if (bound) return;
      bound = true;
      elements.schoolProfileSelect.addEventListener('change', () => {
        deleteArmedProfileId = null;
        clearConfirmation();
        api.cancelCustomGateway().catch(() => {});
        setError();
        updateSelection();
      });
      elements.switchSchoolProfile.addEventListener('click', switchExisting);
      elements.deleteSchoolProfile.addEventListener('click', deleteExisting);
      elements.probeCustomGateway.addEventListener('click', probe);
      elements.confirmCustomGateway.addEventListener('click', confirm);
      elements.cancelCustomGateway.addEventListener('click', () => cancel());
      elements.backCustomGateway.addEventListener('click', () => cancel({ closePanel: false }));
      elements.customGatewayOrigin.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); probe(); }
      });
    }
    function setTranslator(next) {
      if (typeof next !== 'function') return;
      t = next;
      if (confirmation) {
        elements.customGatewaySummary.textContent = t('school.confirmSummary', {
          origin: confirmation.normalizedOrigin,
          version: confirmation.reportedVersion || t('school.versionUnknown'),
        }) + (confirmation.leafSha256 ? `\n${t('school.tlsConfirmed', { fingerprint: confirmation.leafSha256 })}` : '');
      }
      renderProfiles(elements.schoolProfileSelect.value);
      if (active) applyActiveProfile(active);
    }
    function setActiveProfile(value) {
      if (!applyActiveProfile(value)) return false;
      profiles = profiles.map((profile) => Object.freeze({
        ...profile,
        active: profile.profileId === active.profileId,
      }));
      renderProfiles(active.profileId);
      return true;
    }
    function start() {
      bind();
      elements.schoolProfileStatus.textContent = t('school.loading');
      refresh().catch(() => {
        setError(codeMessage('PROFILE_LIST_FAILED'));
        setBusy(false);
      });
    }
    return Object.freeze({
      cancel,
      confirm,
      credentialProfileId,
      deleteExisting,
      probe,
      refresh,
      setActiveProfile,
      setTranslator,
      start,
      switchExisting,
    });
  }

  return { OTHER_PROFILE, confirmationView, createSchoolProfileSelector, profileView };
});

if (typeof window !== 'undefined' && window.document && window.api && window.I18N) {
  const locale = () => window.document.documentElement.lang?.startsWith('zh') ? 'zh' : 'en';
  const feature = window.schoolProfileSelector.createSchoolProfileSelector({
    api: window.api,
    document: window.document,
    translate: window.I18N.createT(locale()),
  });
  window.document.addEventListener('app-locale-changed', () => {
    feature.setTranslator(window.I18N.createT(locale()));
  });
  window.document.addEventListener('app-state-refreshed', (event) => {
    feature.setActiveProfile(event.detail?.schoolProfile);
  });
  feature.start();
  window.schoolProfileSelectorFeature = feature;
}
