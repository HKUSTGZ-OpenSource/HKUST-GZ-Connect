'use strict';

const { ActiveContextActivationStore } = require('../active-context/active-context-activation-store');
const { ActiveContextSwitchBarrier } = require('../effects/active-context-switch-barrier');
const { ActiveContextSwitchJournalStore } = require('../active-context/active-context-switch-store');
const { ProfileCandidateDirectory } = require('../../profiles/registry/profile-candidate-directory');
const { ProfileSwitchRuntime } = require('./profile-switch-runtime');

function persistentContextFromAuthority(authority) {
  const profile = authority?.profile;
  const identity = authority?.layout?.identity;
  const account = authority?.account;
  const workspace = authority?.workspaceState;
  if (!profile || !identity || !account || !workspace) {
    throw new TypeError('active Profile switch authority is incomplete');
  }
  return Object.freeze({
    profileId: profile.profileId,
    profileKey: identity.profileKey,
    profileRevision: profile.profileRevision,
    profileCredentialBindingRevision: profile.profileCredentialBindingRevision,
    accountKey: account.accountKey,
    accountRevision: account.accountRevision,
    accountCredentialRevision: account.accountCredentialRevision,
    workspaceKey: account.workspaceKey,
    activeContextEpoch: workspace.activeContextEpoch,
  });
}

function relaunchDirective(record, journal) {
  if (!record?.profile || record.profile.profileId !== journal?.to?.profileId ||
      typeof journal.switchId !== 'string' ||
      !Number.isSafeInteger(journal.nextActiveContextEpoch)) {
    throw new Error('Profile switch runtime activation is invalid');
  }
  return Object.freeze({
    switchId: journal.switchId,
    profileId: record.profile.profileId,
    activeContextEpoch: journal.nextActiveContextEpoch,
  });
}

class MainProfileSwitchRuntime {
  constructor({
    directory,
    journalStore,
    activationStore,
    startupBarrier,
    liveBarrier,
    getActivePersistentContext,
    getEngineGeneration,
    SwitchRuntimeClass = ProfileSwitchRuntime,
  } = {}) {
    if (!directory || typeof directory.withCandidate !== 'function' ||
        !journalStore || typeof journalStore.read !== 'function' ||
        !activationStore || typeof activationStore.plan !== 'function' ||
        !startupBarrier || !liveBarrier || typeof SwitchRuntimeClass !== 'function' ||
        typeof getActivePersistentContext !== 'function' ||
        typeof getEngineGeneration !== 'function') {
      throw new TypeError('Main Profile switch runtime dependencies are invalid');
    }
    this.journalStore = journalStore;
    this.startupActivation = null;
    this.liveActivation = null;
    const common = {
      directory,
      journalStore,
      activationStore,
      getActivePersistentContext,
      getEngineGeneration,
    };
    this.startup = new SwitchRuntimeClass({
      ...common,
      barrier: startupBarrier,
      activateRuntime: (record, journal) => {
        this.startupActivation = relaunchDirective(record, journal);
        return true;
      },
    });
    this.live = new SwitchRuntimeClass({
      ...common,
      barrier: liveBarrier,
      activateRuntime: (record, journal) => {
        this.liveActivation = relaunchDirective(record, journal);
        return true;
      },
    });
  }

  async recoverBeforeServices() {
    const pending = this.journalStore.read();
    if (pending === null) {
      return Object.freeze({ ok: true, status: 'none', relaunch: null });
    }
    this.startupActivation = null;
    const result = await this.startup.recover();
    return this.#result(result, this.startupActivation);
  }

  async switchTo(profileId) {
    this.liveActivation = null;
    const result = await this.live.switchTo(profileId);
    return this.#result(result, this.liveActivation);
  }

  #result(result, activation) {
    if (!result?.ok || result.status !== 'activated' || !activation ||
        result.switchId !== activation.switchId ||
        result.activeContextEpoch !== activation.activeContextEpoch) {
      throw new Error('Profile switch activation did not produce one relaunch directive');
    }
    return Object.freeze({ ...result, relaunch: activation });
  }
}

function createMainProfileSwitchRuntime({
  directory,
  directoryOptions,
  profileStorageEffects,
  userData,
  journalFile,
  activeAuthority,
  startupEffects,
  liveEffects,
  getEngineGeneration,
  JournalStoreClass = ActiveContextSwitchJournalStore,
  ActivationStoreClass = ActiveContextActivationStore,
  BarrierClass = ActiveContextSwitchBarrier,
  DirectoryClass = ProfileCandidateDirectory,
  SwitchRuntimeClass = ProfileSwitchRuntime,
} = {}) {
  const storageOptions = profileStorageEffects ? { profileStorageEffects } : {};
  const candidates = directory || new DirectoryClass({
    ...directoryOptions,
    ...storageOptions,
  });
  const journalStore = new JournalStoreClass({ filePath: journalFile, ...storageOptions });
  return new MainProfileSwitchRuntime({
    directory: candidates,
    journalStore,
    activationStore: new ActivationStoreClass({ userData, ...storageOptions }),
    startupBarrier: new BarrierClass(startupEffects),
    liveBarrier: new BarrierClass(liveEffects),
    getActivePersistentContext: () => persistentContextFromAuthority(activeAuthority),
    getEngineGeneration,
    SwitchRuntimeClass,
  });
}

module.exports = {
  MainProfileSwitchRuntime,
  createMainProfileSwitchRuntime,
  persistentContextFromAuthority,
  relaunchDirective,
};
