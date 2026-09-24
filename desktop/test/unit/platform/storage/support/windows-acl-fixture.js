'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const {
  PRIVATE_FILE_ENV,
  POWERSHELL_ACL_TIMEOUT_MS,
  protectWindowsFileOwnerOnly,
  verifyWindowsFileOwnerOnly,
} = require('../../../../../lib/platform/storage/windows-private-file');

function runFixtureScript(file, script) {
  return execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'\n` +
      `$privatePath = [Environment]::GetEnvironmentVariable('${PRIVATE_FILE_ENV}')\n` + script,
  ], {
    env: { ...process.env, [PRIVATE_FILE_ENV]: file },
    encoding: 'utf8', maxBuffer: 4096,
    timeout: POWERSHELL_ACL_TIMEOUT_MS, windowsHide: true,
  }).trim();
}

// Only for newly created synthetic fixtures, never for an existing user file.
// Elevated Windows sessions may create files owned by Administrators by default.
function prepareBroadCurrentUserFile(file) {
  assert.equal(protectWindowsFileOwnerOnly(file), true);
  assert.equal(runFixtureScript(file, String.raw`
$acl = [System.IO.File]::GetAccessControl($privatePath)
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value) { throw 'fixture owner mismatch' }
$usersSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
  $usersSid, [Security.AccessControl.FileSystemRights]::Read,
  [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.File]::SetAccessControl($privatePath, $acl)
Write-Output 'broad_current_user'
`), 'broad_current_user');
  assert.equal(verifyWindowsFileOwnerOnly(file), false, 'fixture must have a broad DACL');
}

function prepareAdministratorsOwnedFile(file) {
  return runFixtureScript(file, String.raw`
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Output 'requires_elevation'
  exit 0
}
$acl = [System.IO.File]::GetAccessControl($privatePath)
$owner = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$acl.SetOwner($owner)
[System.IO.File]::SetAccessControl($privatePath, $acl)
$actual = [System.IO.File]::GetAccessControl($privatePath).GetOwner([Security.Principal.SecurityIdentifier])
if ($actual.Value -ne $owner.Value -or $actual.Value -eq $identity.User.Value) { throw 'fixture owner mismatch' }
Write-Output 'foreign_owner'
`);
}

function securityDescriptor(file) {
  return runFixtureScript(file, String.raw`
$acl = [System.IO.File]::GetAccessControl($privatePath)
Write-Output $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
`);
}

module.exports = { prepareBroadCurrentUserFile, prepareAdministratorsOwnedFile, securityDescriptor };
