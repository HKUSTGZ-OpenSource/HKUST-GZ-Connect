'use strict';

const { createProfileSwitchBarrierEffects } = require('./profile-switch-main-effects');
const { createMainProfileSwitchRuntime } = require('../runtime/profile-switch-main-runtime');
const {
  relaunchAfterProfileSwitch,
  scheduleProfileSwitchRelaunch,
} = require('../runtime/profile-switch-relaunch');

function requiredFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

function createMainProfileSwitchComposition({
  enabled,
  directoryOptions,
  profileStorageEffects,
  userData,
  journalFile,
  activeAuthority,
  application,
  argv,
  isPackaged,
  developmentEntry,
  owners,
  effects,
  runtimeFactory = createMainProfileSwitchRuntime,
  barrierEffectsFactory = createProfileSwitchBarrierEffects,
  scheduleRelaunch = scheduleProfileSwitchRelaunch,
  relaunchNow = relaunchAfterProfileSwitch,
} = {}) {
  if (typeof enabled !== 'boolean' || !application || !owners || !effects ||
      !Array.isArray(argv) || typeof isPackaged !== 'boolean' ||
      typeof developmentEntry !== 'string' || typeof runtimeFactory !== 'function' ||
      typeof barrierEffectsFactory !== 'function' || typeof scheduleRelaunch !== 'function' ||
      typeof relaunchNow !== 'function') {
    throw new TypeError('Main Profile switch composition inputs are invalid');
  }
  if (!enabled) {
    return Object.freeze({
      runtime: null,
      recoverBeforeServices: async () => null,
      switchProfile: async () => ({ ok: false, code: 'PROFILE_SWITCH_NOT_READY' }),
    });
  }
  const {
    activeContextLease,
    browserManager,
    authChallenges,
    onboarding,
    networkStartup,
    connectivityRecovery,
    mutationQueue,
    engineSupervisor,
    connectionState,
  } = owners;
  for (const [name, value] of Object.entries({
    clearProxyCredential: effects.clearProxyCredential,
    clearConnectionPresentation: effects.clearConnectionPresentation,
    ensureEngineStopped: effects.ensureEngineStopped,
    cleanupOrphanedEngine: effects.cleanupOrphanedEngine,
    revokeProxyAccess: effects.revokeProxyAccess,
    clearServerState: effects.clearServerState,
    closeLog: effects.closeLog,
  })) requiredFunction(value, name);
  if (!activeContextLease || !browserManager || !authChallenges || !onboarding ||
      !networkStartup || !connectivityRecovery || !mutationQueue ||
      !engineSupervisor || !connectionState) {
    throw new TypeError('Main Profile switch owners are invalid');
  }

  const cancelConnectivity = () => {
    networkStartup.cancel();
    connectivityRecovery.cancel();
  };
  const barrier = (stopEngine) => barrierEffectsFactory({
    activeContextLease,
    browserManager,
    cancelAuth: () => authChallenges.cancelForLifecycle(),
    cancelOnboarding: () => onboarding.cancel(),
    cancelConnectivity,
    cancelMutations: () => mutationQueue.cancelAndDrain(),
    stopEngine,
    revokeProxyAccess: effects.revokeProxyAccess,
    clearServerState: effects.clearServerState,
  });
  const stopLiveEngine = async (generation) => {
    if (!engineSupervisor.isCurrent(generation)) return { ok: false, cleanExit: false };
    const intent = connectionState.beginStop(false);
    engineSupervisor.invalidate();
    effects.clearProxyCredential(generation);
    effects.clearConnectionPresentation();
    const result = await effects.ensureEngineStopped();
    connectionState.stopCompleted(intent, result);
    return result;
  };
  const runtimeOptions = {
    directoryOptions,
    userData,
    journalFile,
    activeAuthority,
    startupEffects: barrier(async () => ({
      ok: effects.cleanupOrphanedEngine(),
      cleanExit: true,
    })),
    liveEffects: barrier(stopLiveEngine),
    getEngineGeneration: () => engineSupervisor.hasActive
      ? engineSupervisor.currentGeneration : null,
  };
  if (profileStorageEffects) runtimeOptions.profileStorageEffects = profileStorageEffects;
  const runtime = runtimeFactory(runtimeOptions);
  let relaunchScheduled = false;
  const switchProfile = async (profileId) => {
    if (relaunchScheduled) {
      const error = new Error('Profile switch relaunch is already scheduled');
      error.code = 'ACTIVE_CONTEXT_SWITCH_RELAUNCH_PENDING';
      throw error;
    }
    const result = await runtime.switchTo(profileId);
    scheduleRelaunch({
      application, argv, isPackaged, developmentEntry,
      switchId: result.relaunch.switchId,
      beforeExit: effects.closeLog,
    });
    relaunchScheduled = true;
    return Object.freeze({
      ok: true,
      profileId: result.relaunch.profileId,
      activeContextEpoch: result.relaunch.activeContextEpoch,
      relaunching: true,
    });
  };
  const recoverBeforeServices = async () => {
    const result = await runtime.recoverBeforeServices();
    if (!result.relaunch) return result;
    relaunchNow({
      application, argv, isPackaged, developmentEntry,
      switchId: result.relaunch.switchId,
    });
    return Object.freeze({ ...result, relaunching: true });
  };
  return Object.freeze({ runtime, recoverBeforeServices, switchProfile });
}

module.exports = { createMainProfileSwitchComposition };
