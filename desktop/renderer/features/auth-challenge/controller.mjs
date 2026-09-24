// Display-only interactive authentication. No Engine identity or credentials are owned here.
export const MAX_RESPONSE_BYTES = 4096;
const KIND_KEYS = Object.freeze({
  otp: 'auth.kindOtp',
  captcha: 'auth.kindCaptcha',
  token: 'auth.kindToken',
  approval: 'auth.kindApproval',
  unknown: 'auth.kindUnknown',
});

export function createAuthChallengeFeature({ api, document: doc, i18n, target, now = Date.now,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (!api || !doc || !i18n) throw new TypeError('auth challenge UI dependencies are required');
  const dialog = doc.getElementById('authChallengeDialog');
  const form = doc.getElementById('authChallengeForm');
  const description = doc.getElementById('authChallengeDescription');
  const destination = doc.getElementById('authChallengeDestination');
  const attempts = doc.getElementById('authChallengeAttempts');
  const responseField = doc.getElementById('authChallengeResponseField');
  const responseInput = doc.getElementById('authChallengeResponse');
  const errorText = doc.getElementById('authChallengeError');
  const resendButton = doc.getElementById('authChallengeResend');
  const cancelButton = doc.getElementById('authChallengeCancel');
  const submitButton = doc.getElementById('authChallengeSubmit');
  if ([dialog, form, description, destination, attempts, responseField, responseInput, errorText,
    resendButton, cancelButton, submitButton].some(node => !node)) throw new TypeError('auth challenge elements are required');
  let challenge = null;
  let busy = false;
  let refreshTimer = null;
  let errorKey = '';
  let started = false, disposed = false, revision = 0, timerVersion = 0;
  const removers = [];
  const isCurrent = epoch => started && !disposed && epoch === revision;
  const unknown = () => challenge?.kind === 'unknown' || !Object.hasOwn(KIND_KEYS, challenge?.kind);
  const expired = () => challenge?.expiresAtUnixMs != null && challenge.expiresAtUnixMs <= now();
  const permitted = kind => started && !disposed && challenge && !busy && (kind === 'cancel' ||
    (!unknown() && !expired() && (kind !== 'resend' || (challenge.resendAvailable &&
      !(challenge.resendAfterUnixMs != null && challenge.resendAfterUnixMs > now())))));

  const translate = (key, vars) => {
    const locale = i18n.resolveLocale(doc.documentElement.lang);
    return i18n.createT(locale)(key, vars);
  };
  const clearResponse = () => { if (started && !disposed) responseInput.value = ''; };
  const showError = key => { errorKey = key; errorText.textContent = key ? translate(key) : ''; };
  const clearRefresh = () => {
    timerVersion++;
    if (refreshTimer !== null) clearTimeoutFn(refreshTimer);
    refreshTimer = null;
  };

  function updateActions() {
    if (!isCurrent(revision) || !challenge) return;
    const current = now();
    const expired = challenge?.expiresAtUnixMs != null && challenge.expiresAtUnixMs <= current;
    const resendCoolingDown = challenge?.resendAfterUnixMs != null &&
      challenge.resendAfterUnixMs > current;
    const unsupported = unknown();
    responseField.hidden = unsupported;
    responseInput.disabled = busy || unsupported || expired;
    submitButton.disabled = busy || unsupported || expired;
    cancelButton.disabled = busy;
    resendButton.disabled = busy || unsupported || !challenge?.resendAvailable ||
      resendCoolingDown || expired;
    if (expired) { clearResponse(); showError('auth.expired'); }
    clearRefresh();
    const nextBoundary = [challenge?.resendAfterUnixMs, challenge?.expiresAtUnixMs]
      .filter((value) => Number.isSafeInteger(value) && value > current)
      .sort((left, right) => left - right)[0];
    if (nextBoundary != null) {
      const epoch = revision, version = timerVersion;
      const handle = setTimeoutFn(() => {
        if (!disposed && epoch === revision && version === timerVersion) updateActions();
      }, Math.min(nextBoundary - current + 1, 0x7fff_ffff));
      if (isCurrent(epoch) && version === timerVersion) refreshTimer = handle;
      else clearTimeoutFn(handle);
    }
  }

  function paintDetails() {
    description.textContent = translate(KIND_KEYS[challenge.kind] || 'auth.kindUnknown');
    destination.hidden = !challenge.maskedDestination;
    destination.textContent = challenge.maskedDestination
      ? translate('auth.destination', { destination: challenge.maskedDestination }) : '';
    attempts.hidden = challenge.attemptsRemaining == null;
    attempts.textContent = challenge.attemptsRemaining == null
      ? '' : translate('auth.attempts', { count: challenge.attemptsRemaining });
  }
  function repaintLocale() {
    if (!started || disposed || !challenge) return;
    paintDetails(); showError(errorKey); updateActions();
  }
  function render(next) {
    if (!started || disposed) return;
    revision++;
    const epoch = revision;
    clearRefresh();
    if (!next) {
      challenge = null;
      errorKey = '';
      busy = false;
      clearResponse();
      for (const node of [description, destination, attempts, errorText]) node.textContent = '';
      for (const node of [responseInput, submitButton, resendButton, cancelButton]) node.disabled = true;
      if (dialog.open) dialog.close();
      return;
    }
    challenge = { ...next };
    busy = false;
    clearResponse();
    showError(unknown() ? 'auth.kindUnknown' : '');
    paintDetails();
    updateActions();
    if (!isCurrent(epoch)) return;
    if (!dialog.open) dialog.showModal();
    if (isCurrent(epoch) && !unknown()) responseInput.focus();
  }

  async function run(action, kind = 'respond') {
    if (!permitted(kind)) return;
    const epoch = revision;
    busy = true;
    showError('');
    updateActions();
    if (!isCurrent(epoch)) return;
    try {
      const result = await action();
      if (!isCurrent(epoch)) return;
      if (!result?.ok) {
        showError(result?.code === 'challenge_expired'
          ? 'auth.expired'
          : result?.code === 'resend_unavailable'
            ? 'auth.resendUnavailable'
            : 'auth.failed');
      }
    } catch {
      if (isCurrent(epoch)) showError('auth.failed');
    } finally {
      if (isCurrent(epoch)) { busy = false; if (challenge) updateActions(); }
    }
  }

  function submit(event) {
    event.preventDefault();
    if (disposed) return;
    let response = responseInput.value;
    clearResponse();
    if (!permitted('respond')) { response = ''; return; }
    const bytes = response.length > MAX_RESPONSE_BYTES ? MAX_RESPONSE_BYTES + 1
      : new TextEncoder().encode(response).byteLength;
    if (bytes === 0 || bytes > MAX_RESPONSE_BYTES) {
      showError(bytes === 0 ? 'auth.empty' : 'auth.tooLong');
      response = '';
      return;
    }
    try { return run(() => api.respondAuthChallenge(response)); }
    finally { response = ''; }
  }
  function cancel(event) {
    event?.preventDefault();
    clearResponse();
    return run(() => api.cancelAuthChallenge(), 'cancel');
  }
  function listen(node, name, callback) {
    if (disposed) throw new Error('auth view retired during startup');
    if (!node?.addEventListener || !node?.removeEventListener) throw new TypeError('auth event target is invalid');
    removers.push(() => node.removeEventListener(name, callback));
    node.addEventListener(name, callback);
    if (disposed) { node.removeEventListener(name, callback); throw new Error('auth view retired during binding'); }
  }
  function dispose() {
    if (disposed) return false;
    const owned = started;
    disposed = true; started = false; revision++; challenge = null; busy = false;
    errorKey = '';
    const errors = [];
    try { clearRefresh(); } catch (error) { errors.push(error); }
    for (const remove of removers.splice(0).reverse()) {
      try { remove(); } catch (error) { errors.push(error); }
    }
    if (owned) {
      responseInput.value = '';
      for (const node of [description, destination, attempts, errorText]) node.textContent = '';
      for (const node of [responseInput, submitButton, resendButton, cancelButton]) node.disabled = true;
      try { if (dialog.open) dialog.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'auth view cleanup failed');
    return true;
  }
  function start() {
    if (disposed) return false;
    if (started) return true;
    started = true;
    try {
      listen(form, 'submit', submit);
      listen(resendButton, 'click', () => run(() => api.resendAuthChallenge(), 'resend'));
      listen(cancelButton, 'click', cancel); listen(dialog, 'cancel', cancel);
      listen(dialog, 'close', () => { if (!dialog.open) render(null); });
      listen(doc, 'app-locale-changed', repaintLocale);
      if (target) listen(target, 'beforeunload', clearResponse);
      return !disposed;
    } catch (error) {
      try { dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'auth view startup failed'); }
      throw error;
    }
  }
  return Object.freeze({ clearResponse, render, start, dispose });
}
