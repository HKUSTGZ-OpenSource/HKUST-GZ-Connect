'use strict';

const { CustomGatewayConfirmationOwner } = require('./custom-gateway-onboarding');
const { CustomProfileProvisioningRuntime } = require('../provisioning/custom-profile-provisioning-runtime');
const { GatewayProbeRunner } = require('./gateway-probe-runner');
const { SchoolProfileOnboardingCoordinator } = require('./school-profile-onboarding');

function createSchoolProfileOnboardingRuntime({
  userData,
  profileStorageEffects,
  executablePath,
  probeLaunch = null,
  spawnProcess,
  environment = process.env,
  platform = process.platform,
  getActiveContext,
  listProfiles,
  onDiagnostic,
} = {}) {
  const launch = probeLaunch || {
    command: executablePath,
    argsPrefix: [],
    electronRunAsNode: false,
  };
  const probeRunner = new GatewayProbeRunner({
    executablePath: launch.command,
    argsPrefix: launch.argsPrefix,
    electronRunAsNode: launch.electronRunAsNode,
    spawnProcess,
    environment,
    platform,
  });
  return new SchoolProfileOnboardingCoordinator({
    probeRunner,
    confirmationOwner: new CustomGatewayConfirmationOwner(),
    provisioningRuntime: new CustomProfileProvisioningRuntime({ userData, profileStorageEffects }),
    getActiveContext,
    listProfiles,
    onDiagnostic,
  });
}

module.exports = { createSchoolProfileOnboardingRuntime };
