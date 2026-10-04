'use strict';

const { normalizeCertificateOrigin } = require('../certificates/campus-certificate-trust');

const CREDENTIAL_CANDIDATE_TTL_MS = 90 * 1000;
const MAX_USERNAME_LENGTH = 320;
const MAX_PASSWORD_LENGTH = 4096;

function canonicalHttpsOrigin(value) {
  const origin = normalizeCertificateOrigin(value);
  return value === origin ? origin : '';
}

function tabCredentialOrigin(tab) {
  if (!tab || tab.view.webContents.isDestroyed()) return '';
  try {
    const parsed = new URL(tab.view.webContents.getURL());
    return parsed.protocol === 'https:' ? parsed.origin : '';
  } catch { return ''; }
}

// User-initiated vault commands and approved shared-login delivery have their
// own window/document lifetime. They do not own login evidence or persistence.
class BrowserCredentialCommandOwner {
  constructor({ getVault, getDialog, getWindow, originForTab, captureAdmission,
    admissionCurrent, getSharedPortalCredential, translate, reportError } = {}) {
    const ports = { getVault, getDialog, getWindow, originForTab, captureAdmission,
      admissionCurrent, getSharedPortalCredential, translate, reportError };
    if (Object.values(ports).some(port => typeof port !== 'function')) {
      throw new TypeError('Browser credential command dependencies are incomplete');
    }
    Object.assign(this, ports);
    this.manages = new Map();
    this.fills = new Map();
    this.generation = 0;
  }

  capture(tab) {
    const admission = this.captureAdmission(tab);
    const window = this.getWindow();
    if (!admission || !window || window.isDestroyed()) return null;
    let origin = '';
    try { origin = canonicalHttpsOrigin(this.originForTab(tab)); } catch {}
    return { tab, admission, window, origin, active: true,
      vault: this.getVault(), dialog: this.getDialog(), generation: this.generation,
      credential: null, owner: null };
  }

  current(flight, map) {
    return flight.active && this.generation === flight.generation && map.get(flight.tab) === flight &&
      this.admissionCurrent(flight.admission) && this.getWindow() === flight.window &&
      !flight.window.isDestroyed() && this.originForTab(flight.tab) === flight.origin &&
      this.getVault() === flight.vault && this.getDialog() === flight.dialog;
  }

  release(flight) {
    const credential = flight.credential;
    flight.credential = null;
    if (credential && typeof credential === 'object') {
      try { credential.password = ''; credential.username = ''; } catch {}
    }
    const owner = flight.owner;
    if (typeof owner?.destroy === 'function') owner.destroy();
    flight.owner = null;
  }

  clearTab(tab) {
    const failures = [];
    for (const map of [this.manages, this.fills]) {
      const flight = map.get(tab);
      if (!flight) continue;
      flight.active = false;
      try { this.release(flight); if (map.get(tab) === flight) map.delete(tab); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Browser credential cleanup is unconfirmed');
  }

  reset() {
    this.generation++;
    const failures = [];
    for (const tab of new Set([...this.manages.keys(), ...this.fills.keys()])) {
      try { this.clearTab(tab); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Browser credential cleanup is unconfirmed');
  }

  manage(tab) {
    const previous = this.manages.get(tab);
    if (previous && this.current(previous, this.manages)) return previous.promise;
    const flight = this.capture(tab);
    if (!flight || !flight.vault || !flight.dialog) return Promise.resolve();
    if (!flight.origin) { this.reportError(this.translate('cred.httpsOnly')); return Promise.resolve(); }
    if (previous) {
      previous.active = false;
      this.release(previous);
      if (this.manages.get(tab) === previous) this.manages.delete(tab);
    }
    this.manages.set(tab, flight);
    flight.promise = Promise.resolve().then(() => this.runManage(flight));
    return flight.promise;
  }

  async runManage(flight) {
    try {
      if (!this.current(flight, this.manages)) return;
      const credential = flight.credential = await flight.vault.get(flight.origin);
      if (!this.current(flight, this.manages)) return;
      const t = (...args) => this.translate(...args);
      const result = await flight.dialog.showMessageBox(flight.window, {
        type: credential ? 'question' : 'info', title: t('cred.title'),
        message: t(credential ? 'cred.hasMessage' : 'cred.noneMessage', { host: new URL(flight.origin).hostname }),
        detail: t(credential ? 'cred.hasDetail' : 'cred.noneDetail'),
        buttons: credential ? [t('cred.fill'), t('cred.delete'), t('common.cancel')] : [t('cred.ok')],
        ...(credential ? { defaultId: 0, cancelId: 2 } : {}), noLink: true,
      });
      if (!credential || !this.current(flight, this.manages)) return;
      if (result.response === 0) flight.tab.view.webContents.send('campus-credential-fill', { ...credential });
      else if (result.response === 1) {
        this.release(flight);
        await flight.vault.remove(flight.origin);
      }
    } catch {
      if (this.current(flight, this.manages)) this.reportError(this.translate('cred.readFailed'));
    } finally {
      flight.active = false;
      this.release(flight);
      if (this.manages.get(flight.tab) === flight) this.manages.delete(flight.tab);
    }
  }

  fillShared(tab) {
    const previous = this.fills.get(tab);
    if (previous && this.current(previous, this.fills)) return previous.promise;
    const flight = this.capture(tab);
    if (!flight || !flight.origin || tab.sharedCredentialAttemptedOrigin === flight.origin) {
      return Promise.resolve(false);
    }
    if (previous) {
      previous.active = false;
      this.release(previous);
      if (this.fills.get(tab) === previous) this.fills.delete(tab);
    }
    this.fills.set(tab, flight);
    flight.promise = Promise.resolve().then(() => this.runFill(flight));
    return flight.promise;
  }

  async runFill(flight) {
    try {
      if (!this.current(flight, this.fills)) return false;
      const owner = flight.owner = await this.getSharedPortalCredential(flight.origin);
      if (!this.current(flight, this.fills) || typeof owner?.withStrings !== 'function' ||
          typeof owner?.destroy !== 'function') return false;
      flight.tab.sharedCredentialAttemptedOrigin = flight.origin;
      return owner.withStrings((username, password) => {
        if (!this.current(flight, this.fills)) return false;
        flight.tab.view.webContents.send('campus-credential-fill', {
          origin: flight.origin, username, password, source: 'connection-credential', autoSubmit: true,
        });
        return true;
      }) === true;
    } catch { return false; }
    finally {
      flight.active = false;
      this.release(flight);
      if (this.fills.get(flight.tab) === flight) this.fills.delete(flight.tab);
    }
  }
}

class CredentialController {
  constructor({
    vault,
    dialog,
    originForTab,
    windowForPrompt,
    t,
    onError,
    candidateTtlMs = CREDENTIAL_CANDIDATE_TTL_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    isContextCurrent = () => true,
    isTabCurrent = () => true,
  } = {}) {
    this.vault = vault;
    this.dialog = dialog;
    this.originForTab = typeof originForTab === 'function' ? originForTab : () => '';
    this.windowForPrompt = typeof windowForPrompt === 'function' ? windowForPrompt : () => null;
    this.t = typeof t === 'function' ? t : (key) => key;
    this.onError = typeof onError === 'function' ? onError : null;
    this.candidateTtlMs = Number.isFinite(candidateTtlMs) && candidateTtlMs > 0
      ? candidateTtlMs
      : CREDENTIAL_CANDIDATE_TTL_MS;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    if (typeof isContextCurrent !== 'function' || typeof isTabCurrent !== 'function') {
      throw new TypeError('credential lifecycle dependencies are invalid');
    }
    this.isContextCurrent = isContextCurrent;
    this.isTabCurrent = isTabCurrent;
    this.prompts = new Set();
    this.offers = new Map();
    this.stagedTabs = new Set();
    this.generation = 0;
    // Popup tabs borrow only an opaque owner relationship. The staged password
    // remains on exactly one owner tab and is never copied into popup state.
    this.popupOwners = new WeakMap();
    this.popupFlows = new WeakMap();
    this.popupNavigation = new WeakMap();
    this.navigationSequence = 0;
  }

  ownerTab(tab) {
    return this.popupOwners.get(tab) || tab;
  }

  flowFor(owner, create = false) {
    let flow = owner ? this.popupFlows.get(owner) : null;
    if (!flow && create && owner) {
      flow = {
        reservations: 0,
        popups: new Set(),
        challengeObserved: false,
        challengeRevision: 0,
        challengeTab: null,
      };
      this.popupFlows.set(owner, flow);
    }
    return flow;
  }

  detachFlow(owner) {
    const flow = this.flowFor(owner);
    if (!flow) return;
    for (const popup of flow.popups) {
      this.popupOwners.delete(popup);
      this.popupNavigation.delete(popup);
    }
    flow.popups.clear();
    flow.reservations = 0;
    flow.challengeTab = null;
    this.popupFlows.delete(owner);
  }

  reservePopup(tab) {
    const owner = this.ownerTab(tab);
    if (!owner?.pendingCredential) return null;
    const flow = this.flowFor(owner, true);
    flow.reservations += 1;
    return { owner, active: true };
  }

  releasePopup(reservation) {
    if (!reservation?.active) return false;
    reservation.active = false;
    const flow = this.flowFor(reservation.owner);
    if (flow) flow.reservations = Math.max(0, flow.reservations - 1);
    return true;
  }

  linkPopup(reservation, popup) {
    if (!reservation?.active || !popup || !reservation.owner?.pendingCredential) {
      this.releasePopup(reservation);
      return false;
    }
    const owner = reservation.owner;
    const flow = this.flowFor(owner, true);
    this.releasePopup(reservation);
    this.popupOwners.set(popup, owner);
    this.popupNavigation.set(popup, {
      navigationCommitted: false,
      navigationSuccessful: false,
      destinationOrigin: '',
      revision: 0,
    });
    flow.popups.add(popup);
    return true;
  }

  closeTab(tab) {
    const owner = this.popupOwners.get(tab);
    if (!owner) {
      this.clear(tab);
      return;
    }
    const flow = this.flowFor(owner);
    flow?.popups.delete(tab);
    if (flow?.challengeTab === tab) flow.challengeTab = null;
    this.popupOwners.delete(tab);
    this.popupNavigation.delete(tab);
  }

  clear(tab) {
    if (!tab) return;
    const owner = this.ownerTab(tab);
    for (const offer of this.offers.values()) if (offer.tab === owner) this.retireOffer(offer);
    try {
      if (owner.pendingCredentialTimer) {
        this.clearTimer(owner.pendingCredentialTimer);
        owner.pendingCredentialTimer = null;
      }
    } finally {
      if (owner.pendingCredential) owner.pendingCredential.password = '';
      owner.pendingCredential = null;
      this.detachFlow(owner);
      if (!owner.pendingCredentialTimer) this.stagedTabs.delete(owner);
    }
  }

  take(tab) {
    const owner = this.ownerTab(tab);
    if (!owner?.pendingCredential) return null;
    if (owner.pendingCredentialTimer) {
      this.clearTimer(owner.pendingCredentialTimer);
      owner.pendingCredentialTimer = null;
    }
    const candidate = owner.pendingCredential;
    this.stagedTabs.delete(owner);
    owner.pendingCredential = null;
    this.detachFlow(owner);
    return candidate;
  }

  stage(tab, candidate) {
    if (!candidate || typeof candidate !== 'object') return false;
    const username = String(candidate.username || '');
    const password = String(candidate.password || '');
    // IPC gave the main process its own object copy. Retain the secret only in
    // the bounded controller record, not in both the event payload and record.
    try { candidate.password = ''; } catch {}
    if (!this.vault || !tab || !this.isContextCurrent() || !this.isTabCurrent(tab)) return false;
    const currentOrigin = this.originForTab(tab);
    let origin;
    try {
      origin = canonicalHttpsOrigin(candidate.origin);
    } catch {
      return false;
    }
    if (!origin || !currentOrigin || origin !== currentOrigin || !password ||
        username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return false;
    }

    // A login submitted inside an existing popup starts a new independent
    // candidate; first retire the inherited flow without copying its secret.
    this.clear(tab);
    tab.pendingCredential = {
      origin,
      username,
      password,
      navigationCommitted: false,
      navigationSuccessful: false,
      destinationOrigin: '',
      challengeObserved: false,
    };
    this.flowFor(tab, true);
    this.stagedTabs.add(tab);
    const staged = tab.pendingCredential;
    tab.pendingCredentialTimer = this.setTimer(() => {
      if (tab.pendingCredential === staged) this.clear(tab);
    }, this.candidateTtlMs);
    tab.pendingCredentialTimer?.unref?.();
    return true;
  }

  markNavigation(tab, rawUrl, httpResponseCode = 0) {
    const owner = this.ownerTab(tab);
    const pending = owner?.pendingCredential;
    if (!pending) return false;
    try {
      const parsed = new URL(String(rawUrl || ''));
      const status = Number(httpResponseCode);
      const successful = status === 0 || (status >= 200 && status < 400);
      // A password submitted on HTTPS must never survive an insecure
      // destination or an HTTP rejection such as 401/403.
      if (parsed.protocol !== 'https:' || !successful) {
        this.clear(owner);
        return false;
      }
      const evidence = tab === owner ? pending : this.popupNavigation.get(tab);
      if (!evidence) return false;
      evidence.navigationCommitted = true;
      evidence.navigationSuccessful = true;
      evidence.destinationOrigin = parsed.origin;
      evidence.revision = ++this.navigationSequence;
      return true;
    } catch {
      this.clear(owner);
      return false;
    }
  }

  async confirmPageState(tab, pageState) {
    const owner = this.ownerTab(tab);
    const pending = owner?.pendingCredential;
    if (!pending || !pageState || typeof pageState !== 'object' ||
        typeof pageState.hasLoginForm !== 'boolean' ||
        typeof pageState.hasChallengeForm !== 'boolean') return false;
    let pageOrigin;
    try {
      pageOrigin = canonicalHttpsOrigin(pageState.origin);
    } catch {
      return false;
    }
    const currentOrigin = this.originForTab(tab);
    const flow = this.flowFor(owner, true);
    const isPopup = tab !== owner;
    const evidence = isPopup ? this.popupNavigation.get(tab) : pending;
    if (!evidence) return false;
    const sameDocument = pageState.transition === 'same-document';
    if (pageState.transition != null && !sameDocument) return false;
    // A stale document can report state after a newer navigation. Ignore it;
    // the bounded candidate timer will clean up if no matching page arrives.
    if (!pageOrigin || pageOrigin !== currentOrigin) return false;
    if (sameDocument) {
      // An SPA transition is valid either on the original password document,
      // or after a matching committed challenge document was explicitly
      // observed. A random post-navigation DOM change cannot confirm login.
      const originalPasswordDocument = !isPopup && !evidence.navigationCommitted &&
        !evidence.navigationSuccessful && pending.origin === pageOrigin;
      const committedChallengeDocument = evidence.navigationCommitted &&
        evidence.navigationSuccessful && evidence.destinationOrigin === pageOrigin &&
        flow.challengeObserved;
      if (!originalPasswordDocument && !committedChallengeDocument) return false;
    } else if (!evidence.navigationCommitted || !evidence.navigationSuccessful ||
        evidence.destinationOrigin !== pageOrigin) return false;
    if (pageState.hasLoginForm) {
      this.clear(owner);
      return false;
    }
    // A challenge is progress, not authentication completion. Keep the staged
    // password only for its existing bounded TTL so it can be offered after a
    // later explicit post-challenge page, but never prompt on the challenge.
    if (pageState.hasChallengeForm) {
      pending.challengeObserved = true;
      flow.challengeObserved = true;
      flow.challengeRevision = evidence.revision || this.navigationSequence;
      flow.challengeTab = tab;
      return false;
    }

    // Opening a popup is itself unresolved authentication progress. The
    // originating tab cannot conclude success while that popup (or its
    // deferred creation) is outstanding. A linked popup must first prove it
    // actually displayed a challenge, rather than being an unrelated ad/help
    // window. After a cross-tab challenge, the owner needs a fresh navigation;
    // an old blank/waiting document is not post-authentication evidence.
    if (!isPopup && (flow.reservations > 0 || flow.popups.size > 0)) return false;
    if (isPopup && !flow.challengeObserved) return false;
    if (flow.challengeObserved && flow.challengeTab !== tab && !sameDocument &&
        (evidence.revision || 0) <= flow.challengeRevision) return false;

    const candidate = this.take(tab);
    if (!candidate) return false;
    await this.offer(candidate, owner);
    return true;
  }

  retireOffer(offer) {
    offer.active = false;
    offer.password = '';
    if (offer.existing && typeof offer.existing === 'object') {
      try { offer.existing.password = ''; } catch {}
    }
    offer.existing = null;
    if (this.offers.get(offer.origin) === offer) {
      this.offers.delete(offer.origin);
      this.prompts.delete(offer.origin);
    }
  }

  offerCurrent(offer) {
    return offer.active && this.offers.get(offer.origin) === offer &&
      this.generation === offer.generation && this.isContextCurrent() &&
      (!offer.tab || this.isTabCurrent(offer.tab)) && this.vault === offer.vault &&
      this.dialog === offer.dialog && this.windowForPrompt() === offer.parent &&
      !!offer.parent && !offer.parent.isDestroyed?.();
  }

  reset() {
    this.generation++;
    for (const offer of [...this.offers.values()]) this.retireOffer(offer);
    const failures = [];
    for (const tab of [...this.stagedTabs]) {
      try { this.clear(tab); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'credential timer cleanup is unconfirmed');
  }

  async offer(candidate, tab = null) {
    if (!candidate || typeof candidate !== 'object') return false;
    let password = String(candidate.password || '');
    try { candidate.password = ''; } catch {}
    let offer = null;
    try {
      if (!this.vault || !this.dialog?.showMessageBox) return false;
      let origin = '';
      try {
        origin = canonicalHttpsOrigin(candidate.origin);
      } catch {
        return false;
      }
      const username = String(candidate.username || '');
      if (!origin || !password || username.length > MAX_USERNAME_LENGTH ||
          password.length > MAX_PASSWORD_LENGTH || this.prompts.has(origin)) return false;
      offer = { origin, username, password, tab, parent: this.windowForPrompt(),
        vault: this.vault, dialog: this.dialog, generation: this.generation,
        active: true, existing: null };
      password = '';
      this.offers.set(origin, offer);
      this.prompts.add(origin);
      if (!this.offerCurrent(offer)) return false;
      const existing = offer.existing = await offer.vault.get(origin);
      if (!this.offerCurrent(offer)) return false;
      if (existing?.username === username && existing.password === offer.password) return true;
      const result = await offer.dialog.showMessageBox(offer.parent, {
        type: 'question',
        title: this.t('cred.saveTitle'),
        message: this.t('cred.saveMessage', { host: new URL(origin).hostname }),
        detail: this.t('cred.saveDetail'),
        buttons: [this.t('cred.save'), this.t('cred.later')],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (!this.offerCurrent(offer)) return false;
      if (result?.response === 0) {
        const saving = offer.vault.save(origin, username, offer.password);
        offer.password = '';
        await saving;
      }
      return this.offerCurrent(offer);
    } catch {
      if (this.onError && offer && this.offerCurrent(offer)) this.onError(this.t('cred.writeFailed'));
      return false;
    } finally {
      password = '';
      if (offer) this.retireOffer(offer);
    }
  }
}

// Native child windows preserve opener/postMessage/self-close semantics used by
// campus IdPs. Only flow ownership is shared with CredentialController; no
// password or challenge value is copied into the popup record.
class ManagedCredentialPopupOwner {
  constructor({
    BrowserWindow, getParentWindow, getCampusSession, campusPreload,
    credentialController, safePopupUrl, openOrdinaryPopup,
    scheduleOrdinary = setImmediate, isContextCurrent = () => true, reportCreateFailure,
    markNavigation, recordPortalSessionUrl,
  } = {}) {
    const ports = { getParentWindow, getCampusSession, safePopupUrl,
      openOrdinaryPopup, scheduleOrdinary, isContextCurrent, reportCreateFailure,
      markNavigation, recordPortalSessionUrl };
    if ((BrowserWindow != null && typeof BrowserWindow !== 'function') ||
        (campusPreload != null && (typeof campusPreload !== 'string' || !campusPreload)) ||
        !credentialController ||
        ['reservePopup', 'releasePopup', 'linkPopup', 'closeTab', 'stage',
          'confirmPageState', 'clear'].some((name) => typeof credentialController[name] !== 'function') ||
        Object.values(ports).some((port) => typeof port !== 'function')) {
      throw new TypeError('managed credential popup dependencies are incomplete');
    }
    Object.assign(this, { BrowserWindow, campusPreload, credentialController, ...ports });
    this.popups = new Set();
  }

  windowOpenResponse(tab, url) {
    if (!this.isContextCurrent() || !this.safePopupUrl(url)) return { action: 'deny' };
    const reservation = this.credentialController.reservePopup(tab);
    if (reservation) {
      return {
        action: 'allow',
        outlivesOpener: false,
        createWindow: (options) => this.createManagedCredentialPopup(options, reservation),
      };
    }
    const parent = this.getParentWindow();
    this.scheduleOrdinary(() => {
      try {
        if (!parent || parent.isDestroyed() || !this.isContextCurrent() ||
            this.getParentWindow() !== parent) return;
        this.openOrdinaryPopup(url);
      }
      catch { this.reportCreateFailure(); }
    });
    return { action: 'deny' };
  }

  createManagedCredentialPopup(options, reservation) {
    let parent;
    let routeSession;
    try {
      if (!this.isContextCurrent()) {
        throw new Error('campus browser unavailable during authentication popup creation');
      }
      parent = this.getParentWindow();
      routeSession = this.getCampusSession();
    } catch (error) {
      this.credentialController.releasePopup(reservation);
      throw error;
    }
    if (typeof this.BrowserWindow !== 'function' || !this.campusPreload ||
        !parent || parent.isDestroyed() || !routeSession) {
      this.credentialController.releasePopup(reservation);
      throw new Error('campus browser unavailable during authentication popup creation');
    }
    let popupWindow = null;
    let popup = null;
    try {
      popupWindow = new this.BrowserWindow({
        ...(options && typeof options === 'object' ? options : {}),
        parent,
        show: true,
        minWidth: 420,
        minHeight: 360,
        backgroundColor: '#f7f9fc',
        autoHideMenuBar: true,
        webPreferences: {
          ...(options?.webPreferences || {}),
          session: routeSession,
          preload: this.campusPreload,
          devTools: false,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          safeDialogs: true,
          backgroundThrottling: true,
        },
      });
      popup = { window: popupWindow, view: { webContents: popupWindow.webContents },
        pendingCredential: null, pendingCredentialTimer: null };
      if (!this.credentialController.linkPopup(reservation, popup)) {
        this.credentialController.releasePopup(reservation);
        throw new Error('authentication popup lost its credential flow');
      }
      this.popups.add(popup);
      this.attachManagedCredentialPopupEvents(popup);
      popupWindow.setMenuBarVisibility?.(false);
      return popupWindow.webContents;
    } catch (error) {
      if (popup) {
        if (popup.cleanup) popup.cleanup();
        else {
          this.popups.delete(popup);
          this.credentialController.closeTab(popup);
        }
      } else this.credentialController.releasePopup(reservation);
      try { if (popupWindow && !popupWindow.isDestroyed()) popupWindow.close(); } catch {}
      this.reportCreateFailure();
      throw error;
    }
  }

  attachManagedCredentialPopupEvents(popup) {
    const popupWindow = popup.window;
    const contents = popup.view.webContents;
    let cleaned = false;
    popup.cleanup = () => {
      if (cleaned) return;
      this.credentialController.closeTab(popup);
      popup.cleanupFailure = null;
      cleaned = true;
      this.popups.delete(popup);
    };
    const rejectNonWebNavigation = (event, url) => {
      if (!this.safePopupUrl(url)) event?.preventDefault?.();
    };
    contents.setWindowOpenHandler(({ url }) => this.windowOpenResponse(popup, url));
    contents.on('will-navigate', rejectNonWebNavigation);
    contents.on('will-redirect', rejectNonWebNavigation);
    contents.on('did-navigate', (_event, url, httpResponseCode = 0) => {
      this.markNavigation(popup, url, httpResponseCode);
      this.recordPortalSessionUrl(url);
    });
    contents.on('did-navigate-in-page', (_event, url) => this.recordPortalSessionUrl(url));
    contents.on('ipc-message', (_event, channel, candidate) => {
      if (channel === 'campus-credential-candidate') {
        this.credentialController.stage(popup, candidate);
      } else if (channel === 'campus-credential-page-state') {
        this.credentialController.confirmPageState(popup, candidate).catch(() => {});
      }
    });
    contents.on('render-process-gone', (_event, details = {}) => {
      if (details.reason !== 'clean-exit') this.credentialController.clear(popup);
      try { if (!popupWindow.isDestroyed()) popupWindow.close(); } catch {}
    });
    const cleanupObserved = () => {
      try { popup.cleanup(); } catch (error) { popup.cleanupFailure = error; }
    };
    contents.once('destroyed', cleanupObserved);
    popupWindow.once('closed', cleanupObserved);
  }

  closeAll() {
    const failures = [];
    for (const popup of [...this.popups]) {
      try {
        if (!popup.window.isDestroyed()) popup.window.close();
        if (!popup.window.isDestroyed()) throw new Error('Browser popup close is unconfirmed');
        popup.cleanup?.();
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Browser popup cleanup is unconfirmed');
  }
}

module.exports = {
  BrowserCredentialCommandOwner,
  CREDENTIAL_CANDIDATE_TTL_MS,
  CredentialController,
  ManagedCredentialPopupOwner,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  canonicalHttpsOrigin,
  tabCredentialOrigin,
};
