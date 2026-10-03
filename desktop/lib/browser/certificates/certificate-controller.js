'use strict';

const {
  CampusCertificateTrustStore,
  certificateFingerprint,
  normalizeCertificateOrigin,
} = require('./campus-certificate-trust');

function rejectCertificate(callback) {
  if (typeof callback !== 'function') return;
  try { callback(false); } catch {}
}

// Certificate exceptions are a user decision about the page they explicitly
// navigated to, never about arbitrary resources selected by that page. An
// untrusted subresource therefore fails closed without opening a native
// dialog. Unowned WebContents retain Chromium's default handling.
function routeCertificateError({
  owned,
  isMainFrame,
  event,
  callback,
  prompt,
} = {}) {
  if (owned !== true) return { handled: false, prompted: false };
  try { event?.preventDefault?.(); } catch {}

  if (isMainFrame !== true || typeof prompt !== 'function') {
    rejectCertificate(callback);
    return { handled: true, prompted: false };
  }

  Promise.resolve()
    .then(prompt)
    .catch(() => rejectCertificate(callback));
  return { handled: true, prompted: true };
}

// Application-level Browser request dispatch; consent and proxy credential
// policy remain in their existing independent owners. No raw secret is held.
class BrowserRequestSecurityBoundary {
  constructor({ getBrowser, getEngineGeneration, proxyAccess } = {}) {
    if ([getBrowser, getEngineGeneration].some(value => typeof value !== 'function') ||
        !proxyAccess || ['matchesProxyChallenge', 'answerProxyChallenge']
          .some(name => typeof proxyAccess[name] !== 'function')) {
      throw new TypeError('Browser request security capabilities are invalid');
    }
    this.certificateError = (event, webContents, url, error, certificate, callback, isMainFrame) => {
      // Control chrome and unrelated requests keep Chromium defaults; only an
      // owned main frame may reach explicit consent, never a subresource.
      return routeCertificateError({
        owned: getBrowser().ownsWebContents(webContents), isMainFrame, event, callback,
        prompt: () => getBrowser().handleCertificateError({ url, error, certificate, callback }),
      });
    };
    this.proxyLogin = (event, webContents, _details, authInfo, callback) => {
      // Chromium needs the strict loopback HTTP CONNECT challenge answered.
      // Capture one generation and delegate exact challenge/pin checks to its
      // credential owner; unowned pages never query or borrow credentials.
      const generation = getEngineGeneration();
      if (!getBrowser().ownsWebContents(webContents) ||
          !proxyAccess.matchesProxyChallenge(authInfo, generation)) return;
      event.preventDefault();
      proxyAccess.answerProxyChallenge(authInfo, generation, callback);
    };
    Object.freeze(this);
  }
}

function certificateTime(value, locale = 'zh', t = (key) => key) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return t('cert.unknown');
  try {
    return new Date(seconds * 1000).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', {
      hour12: false,
    });
  } catch {
    return t('cert.unknown');
  }
}

class CertificateController {
  constructor({
    trustStore,
    dialog,
    windowForPrompt,
    locale,
    t,
  } = {}) {
    this.trustStore = trustStore;
    this.dialog = dialog;
    this.windowForPrompt = typeof windowForPrompt === 'function' ? windowForPrompt : () => undefined;
    this.locale = typeof locale === 'function' ? locale : () => 'zh';
    this.t = typeof t === 'function' ? t : (key) => key;
    this.decisions = new Map();
    this.activePrompt = null;
  }

  async promptAndTrust({ origin, fingerprint, error, certificate, isCurrent = () => true }) {
    if (!this.dialog?.showMessageBox || typeof this.trustStore?.trust !== 'function') return false;
    const translate = this.t;
    const locale = this.locale() === 'en' ? 'en' : 'zh';
    const detail = [
      translate('cert.site', { origin }),
      translate('cert.chromiumError', { error: String(error || translate('cert.unknown')) }),
      translate('cert.subject', {
        subject: String(certificate?.subjectName || translate('cert.unknown')),
      }),
      translate('cert.issuer', {
        issuer: String(certificate?.issuerName || translate('cert.unknown')),
      }),
      translate('cert.validity', {
        start: certificateTime(certificate?.validStart, locale, translate),
        end: certificateTime(certificate?.validExpiry, locale, translate),
      }),
      translate('cert.fingerprint', { fingerprint }),
      '',
      translate('cert.scope'),
    ].join('\n');
    const parent = this.windowForPrompt();
    const usableParent = parent && !parent.isDestroyed?.() ? parent : undefined;
    const result = await this.dialog.showMessageBox(usableParent, {
      type: 'warning',
      title: translate('cert.title'),
      message: translate('cert.message', { origin }),
      detail,
      buttons: [translate('cert.trust'), translate('common.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (result?.response !== 0 || !isCurrent()) return false;
    await this.trustStore.trust(origin, fingerprint);
    return isCurrent();
  }

  cancelAll() {
    const records = new Set(this.decisions.values());
    for (const record of records) {
      record.cancelled = true;
      record.resolveCancellation?.(false);
    }
    this.decisions.clear();
    this.activePrompt = null;
  }

  async handle({ url, error, certificate, callback } = {}) {
    let settled = false;
    const finish = (allowed) => {
      if (settled) return;
      settled = true;
      if (typeof callback === 'function') {
        try { callback(allowed === true); } catch {}
      }
    };

    try {
      const origin = normalizeCertificateOrigin(url);
      const fingerprint = certificateFingerprint(certificate?.data);
      const pending = this.decisions.get(origin);

      // An origin changing certificates while a decision is open is denied as
      // one origin-level race, even if the second fingerprint was trusted by
      // an older pin. It may be retried after the first decision settles.
      if (pending && pending.fingerprint !== fingerprint) {
        await pending.promise.catch(() => false);
        finish(false);
        return false;
      }

      if (this.trustStore?.isTrusted?.(origin, fingerprint) === true) {
        finish(true);
        return true;
      }

      let decision = pending?.promise;
      if (!decision) {
        // Native message boxes are process-modal enough to make a large set of
        // different self-signed origins an effective UI denial of service.
        // Same-origin requests still share one decision; every other untrusted
        // origin fails closed while that one bounded prompt is active.
        if (this.activePrompt) {
          finish(false);
          return false;
        }
        let resolveCancellation;
        const cancellation = new Promise((resolve) => { resolveCancellation = resolve; });
        const record = {
          origin,
          fingerprint,
          promise: null,
          cancelled: false,
          resolveCancellation,
        };
        const prompt = this.promptAndTrust({
          origin,
          fingerprint,
          error,
          certificate,
          isCurrent: () => !record.cancelled && this.activePrompt === record,
        });
        decision = Promise.race([prompt, cancellation]);
        record.promise = decision;
        this.decisions.set(origin, record);
        this.activePrompt = record;
        decision.finally(() => {
          if (this.decisions.get(origin) === record) this.decisions.delete(origin);
          if (this.activePrompt === record) this.activePrompt = null;
          record.cancelled = true;
          record.resolveCancellation = null;
        }).catch(() => {});
      }
      const allowed = await decision;
      finish(allowed === true);
      return allowed === true;
    } catch {
      finish(false);
      return false;
    }
  }
}

module.exports = {
  BrowserRequestSecurityBoundary,
  CampusCertificateTrustStore,
  CertificateController,
  certificateTime,
  routeCertificateError,
};
