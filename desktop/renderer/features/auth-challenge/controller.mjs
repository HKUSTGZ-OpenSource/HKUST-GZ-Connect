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
  let challenge = null;
  let busy = false;
  let refreshTimer = null;

  const translate = (key, vars) => {
    const locale = i18n.resolveLocale(doc.documentElement.lang);
    return i18n.createT(locale)(key, vars);
  };
  const clearResponse = () => { responseInput.value = ''; };
  const clearRefresh = () => {
    if (refreshTimer) clearTimeoutFn(refreshTimer);
    refreshTimer = null;
  };

  function updateActions() {
    const current = now();
    const expired = challenge?.expiresAtUnixMs != null && challenge.expiresAtUnixMs <= current;
    const resendCoolingDown = challenge?.resendAfterUnixMs != null &&
      challenge.resendAfterUnixMs > current;
    const unknown = challenge?.kind === 'unknown';
    responseField.hidden = unknown;
    responseInput.disabled = busy || unknown || expired;
    submitButton.disabled = busy || unknown || expired;
    cancelButton.disabled = busy;
    resendButton.disabled = busy || unknown || !challenge?.resendAvailable ||
      resendCoolingDown || expired;
    if (expired) errorText.textContent = translate('auth.expired');
    clearRefresh();
    const nextBoundary = [challenge?.resendAfterUnixMs, challenge?.expiresAtUnixMs]
      .filter((value) => Number.isSafeInteger(value) && value > current)
      .sort((left, right) => left - right)[0];
    if (nextBoundary != null) {
      refreshTimer = setTimeoutFn(updateActions, Math.min(nextBoundary - current + 1, 0x7fff_ffff));
    }
  }

  function render(next) {
    clearRefresh();
    if (!next) {
      challenge = null;
      busy = false;
      clearResponse();
      errorText.textContent = '';
      if (dialog.open) dialog.close();
      return;
    }
    challenge = { ...next };
    busy = false;
    clearResponse();
    errorText.textContent = challenge.kind === 'unknown'
      ? translate('auth.kindUnknown')
      : '';
    description.textContent = translate(KIND_KEYS[challenge.kind] || 'auth.kindUnknown');
    destination.hidden = !challenge.maskedDestination;
    destination.textContent = challenge.maskedDestination
      ? translate('auth.destination', { destination: challenge.maskedDestination })
      : '';
    attempts.hidden = challenge.attemptsRemaining == null;
    attempts.textContent = challenge.attemptsRemaining == null
      ? ''
      : translate('auth.attempts', { count: challenge.attemptsRemaining });
    updateActions();
    if (!dialog.open) dialog.showModal();
    if (challenge.kind !== 'unknown') responseInput.focus();
  }

  async function run(action) {
    if (!challenge || busy) return;
    busy = true;
    errorText.textContent = '';
    updateActions();
    try {
      const result = await action();
      if (!result?.ok) {
        errorText.textContent = result?.code === 'challenge_expired'
          ? translate('auth.expired')
          : result?.code === 'resend_unavailable'
            ? translate('auth.resendUnavailable')
            : translate('auth.failed');
      }
    } catch {
      errorText.textContent = translate('auth.failed');
    } finally {
      busy = false;
      if (challenge) updateActions();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!challenge || challenge.kind === 'unknown') return;
    let response = responseInput.value;
    clearResponse();
    const bytes = new TextEncoder().encode(response).byteLength;
    if (bytes === 0 || bytes > MAX_RESPONSE_BYTES) {
      errorText.textContent = translate(bytes === 0 ? 'auth.empty' : 'auth.tooLong');
      response = '';
      return;
    }
    const operation = run(() => api.respondAuthChallenge(response));
    response = '';
    return operation;
  });
  resendButton.addEventListener('click', () => run(() => api.resendAuthChallenge()));
  cancelButton.addEventListener('click', () => {
    clearResponse();
    return run(() => api.cancelAuthChallenge());
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    clearResponse();
    run(() => api.cancelAuthChallenge());
  });
  target?.addEventListener?.('beforeunload', clearResponse);
  return { clearResponse, render };
}

export function start({ target, document: doc, api, i18n } = {}) {
  if (!doc || !api || !i18n) return null;
  const feature = createAuthChallengeFeature({
    api, document: doc, i18n, target,
  });
  let eventVersion = 0;
  api.onAuthChallenge((challenge) => {
    eventVersion += 1;
    feature.render(challenge);
  });
  const initialVersion = eventVersion;
  api.getState().then((state) => {
    if (eventVersion === initialVersion) feature.render(state?.authChallenge || null);
  }).catch(() => {});
  return feature;
}
