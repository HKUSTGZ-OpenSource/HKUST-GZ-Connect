'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  auditSnapshot,
  captureLiveSnapshot,
  parseArguments,
  readContract,
  requiredReviewers,
} = require('../../../.github/scripts/audit-live-github-governance');

const contract = readContract();

function snapshot() {
  return {
    schemaVersion: 1,
    capturedAt: '2026-09-04T13:55:39.245Z',
    repository: {
      id: 1279507615,
      name: 'HKUST-GZ-Connect',
      owner: 'heeh02',
      ownerType: 'User',
      visibility: 'public',
      defaultBranch: 'main',
    },
    merge: {
      allowSquash: true,
      allowMergeCommit: false,
      allowRebase: false,
      deleteBranchOnMerge: true,
      linearHistory: true,
      conversationResolution: true,
      forcePush: false,
      branchDeletion: false,
    },
    actions: {
      enabled: true,
      defaultWorkflowPermissions: 'read',
      canApproveReviews: false,
      shaPinningRequired: true,
      allowedActions: 'all',
    },
    mainProtection: {
      strict: true,
      checks: [...contract.requiredChecks],
      approvals: 1,
      dismissStaleReviews: true,
      enforceAdmins: false,
      codeOwnerReviews: false,
      lastPushApproval: false,
    },
    releaseTagRuleset: {
      id: 22269087,
      name: 'release-tag-immutability',
      enforcement: 'active',
      include: ['refs/tags/v*'],
      rules: ['deletion', 'non_fast_forward', 'update'],
      bypassActors: [],
    },
    releaseTeam: null,
    releaseEnvironment: { name: 'release', reviewerCount: 0 },
    security: {
      privateVulnerabilityReporting: true,
      dependabotSecurityUpdates: 'enabled',
      secretScanning: 'enabled',
      pushProtection: 'enabled',
      nonProviderPatterns: 'disabled',
      validityChecks: 'disabled',
    },
  };
}

test('pre-transfer audit accepts current controls and reports explicit deferrals', () => {
  const result = auditSnapshot(contract, snapshot(), {
    phase: 'pre-transfer', expectedOwner: 'heeh02',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.deferred, [
    'Actions allowlist remains broad; full-SHA pinning is required',
    'secret scanning non-provider patterns unavailable',
    'secret scanning validity checks unavailable',
  ]);
});

test('post-transfer audit requires Organization teams and hardened review owners', () => {
  const value = snapshot();
  value.repository.owner = 'hkust-connect';
  value.repository.ownerType = 'Organization';
  value.mainProtection.enforceAdmins = true;
  value.mainProtection.codeOwnerReviews = true;
  value.mainProtection.lastPushApproval = true;
  value.releaseEnvironment.reviewerCount = 2;
  value.releaseTagRuleset.rules.push('creation');
  value.releaseTagRuleset.rules.sort();
  value.releaseTeam = { id: 42, slug: 'release' };
  value.releaseTagRuleset.bypassActors = [{
    actorId: 42, actorType: 'Team', bypassMode: 'always',
  }];
  assert.equal(auditSnapshot(contract, value, {
    phase: 'post-transfer', expectedOwner: 'hkust-connect', expectedReleaseTeam: 'release',
  }).ok, true);

  value.releaseTagRuleset.bypassActors = [];
  value.mainProtection.enforceAdmins = false;
  const failed = auditSnapshot(contract, value, {
    phase: 'post-transfer', expectedOwner: 'hkust-connect', expectedReleaseTeam: 'release',
  });
  assert.equal(failed.ok, false);
  assert.ok(failed.errors.includes('mainProtection.enforceAdmins: expected true, received false'));
  assert.ok(failed.errors.includes('releaseTagRuleset has no Release-team bypass'));
});

test('identity, required-check, merge and security drift fail independently', () => {
  const cases = [
    ['repository identity', (value) => { value.repository.id += 1; }, 'repository.id'],
    ['required check', (value) => { value.mainProtection.checks.pop(); }, 'mainProtection.checks'],
    ['merge policy', (value) => { value.merge.allowMergeCommit = true; }, 'merge.allowMergeCommit'],
    ['security setting', (value) => { value.security.pushProtection = 'disabled'; }, 'security.pushProtection'],
  ];
  for (const [name, mutate, expected] of cases) {
    const value = snapshot();
    mutate(value);
    const result = auditSnapshot(contract, value, {
      phase: 'pre-transfer', expectedOwner: 'heeh02',
    });
    assert.equal(result.ok, false, name);
    assert.equal(result.errors.some((error) => error.includes(expected)), true, name);
  }
});

test('live capture uses only fixed read endpoints and emits a secret-free projection', () => {
  const responses = {
    'repos/heeh02/HKUST-GZ-Connect': {
      id: 1279507615, name: 'HKUST-GZ-Connect', owner: { login: 'heeh02', type: 'User' },
      visibility: 'public', default_branch: 'main', allow_squash_merge: true,
      allow_merge_commit: false, allow_rebase_merge: false, delete_branch_on_merge: true,
      security_and_analysis: {
        dependabot_security_updates: { status: 'enabled' },
        secret_scanning: { status: 'enabled' },
        secret_scanning_push_protection: { status: 'enabled' },
        secret_scanning_non_provider_patterns: { status: 'disabled' },
        secret_scanning_validity_checks: { status: 'disabled' },
      },
    },
    'repos/heeh02/HKUST-GZ-Connect/actions/permissions/workflow': {
      default_workflow_permissions: 'read', can_approve_pull_request_reviews: false,
    },
    'repos/heeh02/HKUST-GZ-Connect/actions/permissions': {
      enabled: true, sha_pinning_required: true, allowed_actions: 'all',
    },
    'repos/heeh02/HKUST-GZ-Connect/branches/main/protection': {
      required_status_checks: {
        strict: true, checks: contract.requiredChecks.map((context) => ({ context })),
      },
      required_pull_request_reviews: {
        required_approving_review_count: 1,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        require_last_push_approval: false,
      },
      required_linear_history: { enabled: true },
      required_conversation_resolution: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      enforce_admins: { enabled: false },
    },
    'repos/heeh02/HKUST-GZ-Connect/rulesets': [
      { id: 22269087, name: 'release-tag-immutability' },
    ],
    'repos/heeh02/HKUST-GZ-Connect/rulesets/22269087': {
      id: 22269087, name: 'release-tag-immutability', enforcement: 'active',
      conditions: { ref_name: { include: ['refs/tags/v*'] } },
      rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'update' }],
      bypass_actors: [],
    },
    'repos/heeh02/HKUST-GZ-Connect/environments/release': {
      name: 'release', protection_rules: [],
    },
    'repos/heeh02/HKUST-GZ-Connect/private-vulnerability-reporting': { enabled: true },
  };
  const calls = [];
  const captured = captureLiveSnapshot('heeh02/HKUST-GZ-Connect', {
    execute,
  });
  assert.equal(calls.length, 8);
  assert.equal(calls.every((call) => call.command === 'gh' && call.args[0] === 'api'), true);
  assert.equal(JSON.stringify(calls).includes('secrets'), false);
  assert.equal(JSON.stringify(captured).includes('token'), false);
  assert.equal(auditSnapshot(contract, captured, {
    phase: 'pre-transfer', expectedOwner: 'heeh02',
  }).ok, true);

  // Missing API fields are unavailable, never evidence that protection is enabled.
  // Keep these mandatory failures separate from optional non-provider/validity deferrals.
  const analysis = responses['repos/heeh02/HKUST-GZ-Connect'].security_and_analysis;
  for (const [field, projected] of [
    ['secret_scanning', 'secretScanning'],
    ['secret_scanning_push_protection', 'pushProtection'],
  ]) {
    const original = analysis[field];
    for (const state of ['disabled', 'missing']) {
      if (state === 'missing') delete analysis[field];
      else analysis[field] = { status: state };
      const degraded = captureLiveSnapshot('heeh02/HKUST-GZ-Connect', { execute });
      assert.equal(degraded.security[projected], state === 'missing' ? 'unavailable' : 'disabled');
      const result = auditSnapshot(contract, degraded, {
        phase: 'pre-transfer', expectedOwner: 'heeh02',
      });
      assert.equal(result.ok, false);
      assert.equal(result.errors.length, 1);
      assert.ok(result.errors[0].startsWith(`security.${projected}: expected enabled`));
      assert.ok(!result.deferred.some(message => message.includes(`security.${projected}`)));
    }
    analysis[field] = original;
  }

  responses['orgs/hkust-connect/teams/release'] = {
    id: 42, slug: 'release', name: 'Release', permission: 'push',
  };
  calls.length = 0;
  const withTeam = captureLiveSnapshot('heeh02/HKUST-GZ-Connect', {
    execute,
    releaseTeamOwner: 'hkust-connect',
    releaseTeamSlug: 'release',
  });
  assert.deepEqual(withTeam.releaseTeam, { id: 42, slug: 'release' });
  assert.equal(calls.length, 9);

  function execute(command, args, options) {
    calls.push({ command, args, options });
    const value = responses[args[1]];
    if (value === undefined) throw new Error(`unexpected endpoint: ${args[1]}`);
    return JSON.stringify(value);
  }
});

test('snapshot and CLI schemas fail closed on ambiguity', () => {
  const value = snapshot();
  value.unknown = true;
  assert.throws(() => auditSnapshot(contract, value, {
    phase: 'pre-transfer', expectedOwner: 'heeh02',
  }), /invalid schema/u);
  assert.throws(() => captureLiveSnapshot('bad slug'), /exact owner\/name/u);
  assert.throws(() => parseArguments(['--live', 'owner/repo']), /usage/u);
  assert.deepEqual(parseArguments([
    '--live', 'heeh02/HKUST-GZ-Connect', '--phase', 'pre-transfer',
    '--expected-owner', 'heeh02',
  ]), {
    repository: 'heeh02/HKUST-GZ-Connect',
    phase: 'pre-transfer',
    expectedOwner: 'heeh02',
  });
  assert.deepEqual(parseArguments([
    '--live', 'hkust-connect/HKUST-GZ-Connect', '--phase', 'post-transfer',
    '--expected-owner', 'hkust-connect', '--expected-release-team', 'release',
  ]), {
    repository: 'hkust-connect/HKUST-GZ-Connect',
    phase: 'post-transfer',
    expectedOwner: 'hkust-connect',
    expectedReleaseTeam: 'release',
  });
  assert.throws(() => parseArguments([
    '--live', 'hkust-connect/HKUST-GZ-Connect', '--phase', 'post-transfer',
    '--expected-owner', 'hkust-connect',
  ]), /Release-team/u);
  assert.equal(requiredReviewers({ protection_rules: [{
    type: 'required_reviewers', reviewers: [{ type: 'User' }, { type: 'Team' }],
  }] }), 2);
});
