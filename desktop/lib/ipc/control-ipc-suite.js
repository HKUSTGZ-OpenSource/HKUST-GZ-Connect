'use strict';

const { registerControlDataIpc } = require('./control-data-ipc');
const { registerCoreControlIpc } = require('./core-control-ipc');
const { registerSettingsCredentialIpc } = require('./settings-credential-ipc');
const { createControlStateSnapshot } = require('./control-state-snapshot');
const { registerTrustedIpcHandlers } = require('./ipc-handlers');
const { CustomProfileDeletionRuntime } = require('../profiles/deletion/custom-profile-deletion-runtime');
const {
  createSchoolProfileOnboardingRuntime,
} = require('../profiles/onboarding/school-profile-onboarding-suite');
const {
  createExternalIntegrationRuntime,
  createIntegrationTargetSelector,
} = require('./integration-center-suite');

function createTrustedControlRegistrar({ ipcMain, getWebContents, allowedFiles } = {}) {
  if (typeof ipcMain?.handle !== 'function' || typeof getWebContents !== 'function') {
    throw new TypeError('trusted Control registrar dependencies are incomplete');
  }
  return (channel, handler) => {
    registerTrustedIpcHandlers({ ipcMain, getWebContents, allowedFiles,
      handlers: { [channel]: handler } });
  };
}

module.exports = {
  createTrustedControlRegistrar,
  createCustomProfileDeletionRuntime: (options) => new CustomProfileDeletionRuntime(options),
  createControlStateSnapshot,
  createExternalIntegrationRuntime,
  createIntegrationTargetSelector,
  createSchoolProfileOnboardingRuntime,
  registerControlDataIpc,
  registerCoreControlIpc,
  registerSettingsCredentialIpc,
};
