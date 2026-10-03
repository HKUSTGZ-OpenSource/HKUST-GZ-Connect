'use strict';

const { allowedKeys, boundedArray, boundedString } = require('./ipc-guard');
const { applySettingsPatch } = require('../persistence/settings/settings-update');
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

function profileId(value) {
  if (typeof value !== 'string' || !PROFILE_ID.test(value)) {
    throw new TypeError('学校登录上下文无效');
  }
  return value;
}

function settingsPatchFromIpc(value) {
  const source = allowedKeys(value, [
    'username', 'password', 'port', 'autoReconnect', 'maxAttempts', 'startAtLogin',
    'autoConnect', 'strictProxyAuth', 'proxyAuthMigrationAcknowledged',
    'closeAction', 'language', 'browserNewTabUrl', 'routeDomains', 'expectedProfileId',
    'underlaySourceAddress',
  ]);
  const result = { ...source };
  if (source.username != null) {
    result.username = boundedString(source.username, { maxLength: 256 });
  }
  if (source.password != null) {
    result.password = boundedString(source.password, { maxLength: 4096 });
  }
  if (source.browserNewTabUrl != null) {
    result.browserNewTabUrl = boundedString(source.browserNewTabUrl, { maxLength: 2048 });
  }
  if (source.underlaySourceAddress != null) {
    result.underlaySourceAddress = boundedString(source.underlaySourceAddress, { maxLength: 64 });
  }
  if (source.expectedProfileId != null) {
    result.expectedProfileId = profileId(boundedString(source.expectedProfileId, {
      minLength: 1,
      maxLength: 80,
      trim: true,
      message: '学校登录上下文无效',
    }));
  }
  if (source.proxyAuthMigrationAcknowledged != null &&
      source.proxyAuthMigrationAcknowledged !== true) {
    throw new TypeError('proxyAuthMigrationAcknowledged must be true');
  }
  if (Array.isArray(source.routeDomains)) {
    result.routeDomains = boundedArray(
      source.routeDomains,
      (item) => boundedString(item, { minLength: 1, maxLength: 253, trim: true }),
      { maxLength: 64 },
    );
  } else if (source.routeDomains != null) {
    result.routeDomains = boundedString(source.routeDomains, { maxLength: 4096 });
  }
  return result;
}

function clearPasswordReference(value) {
  if (!value || typeof value !== 'object' || typeof value.password !== 'string') return;
  try { value.password = ''; } catch {}
}

function reconnectFailureMessage(result, translate) {
  const fallback = translate('error.reconnectFailed');
  const value = typeof result?.error === 'string' ? result.error.trim() : '';
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) return fallback;
  return value;
}

function registerSettingsCredentialIpc(dependencies = {}) {
  const {
    register,
    loadSettings,
    saveSettings,
    savePassword,
    removePassword,
    credentialTransactions,
    runPolicyTransaction,
    runSerialTransaction,
    assertPersistence,
    translate,
    onLanguageChanged,
    setStartAtLogin,
    hasActiveEngine,
    reconnect,
    disconnect,
    getActiveProfileId,
    credentialStorageAvailable,
    stageOneShotCredential,
    clearOneShotCredential,
  } = dependencies;
  for (const dependency of [
    register, loadSettings, saveSettings, savePassword, removePassword,
    runPolicyTransaction, runSerialTransaction,
    assertPersistence, translate, onLanguageChanged, setStartAtLogin,
    hasActiveEngine, reconnect, disconnect, getActiveProfileId,
  ]) {
    if (typeof dependency !== 'function') {
      throw new TypeError('settings credential IPC dependencies are incomplete');
    }
  }
  if (!credentialTransactions || [
    'runCredentialMutation', 'applyCredentialRecoveryOutcome',
    'isCredentialTransactionBlocked', 'retryCredentialTransactionRecovery',
  ].some((name) => typeof credentialTransactions[name] !== 'function')) {
    throw new TypeError('settings credential transaction owner is required');
  }
  const oneShotDependencies = [
    credentialStorageAvailable, stageOneShotCredential, clearOneShotCredential,
  ];
  const oneShotEnabled = oneShotDependencies.every((dependency) => typeof dependency === 'function');
  if (!oneShotEnabled && oneShotDependencies.some((dependency) => dependency != null)) {
    throw new TypeError('one-shot credential IPC dependencies are incomplete');
  }

  register('save', async (_event, rawPatch) => {
    let previous = null;
    let patch;
    let next;
    let portChanged;
    let proxyAuthChanged;
    let underlayChanged;
    let expectedProfileId = null;
    let oneShotRevision = null;
    let credentialStorage = null;
    try {
      try {
        previous = loadSettings();
        patch = settingsPatchFromIpc(rawPatch);
        const credentialPatch = patch.username != null || patch.password != null;
        expectedProfileId = patch.expectedProfileId;
        delete patch.expectedProfileId;
        if (credentialPatch && expectedProfileId !== getActiveProfileId()) {
          const message = translate('error.profileCredentialContextChanged');
          throw Object.assign(new Error(message), { userMessage: message });
        }
        ({ settings: next, portChanged, proxyAuthChanged, underlayChanged } = applySettingsPatch(previous, patch));
      } catch (error) {
        return {
          ok: false,
          error: error.userMessage || error.message,
          settings: previous,
        };
      }
      const replacingPassword = typeof patch.password === 'string' && patch.password.length > 0;
      let useOneShotCredential = false;
      const policyTransactionRequired = patch.routeDomains != null || patch.port != null ||
        patch.strictProxyAuth != null || patch.underlaySourceAddress != null;
      if (replacingPassword && policyTransactionRequired) {
        return {
          ok: false,
          error: translate('error.credentialPolicyCombined'),
          settings: previous,
        };
      }

      const commitCandidateSettings = () => {
        const usernameChanged = patch.username != null && next.username !== previous.username;
        if (usernameChanged && !replacingPassword) {
          const message = translate('error.usernameNeedsPassword');
          throw Object.assign(new Error(message), { userMessage: message });
        }
        if (!replacingPassword) {
          next = saveSettings(next);
          return next;
        }

        if (expectedProfileId !== getActiveProfileId()) {
          const message = translate('error.profileCredentialContextChanged');
          throw Object.assign(new Error(message), { userMessage: message });
        }
        if (oneShotEnabled) {
          try { useOneShotCredential = credentialStorageAvailable() !== true; }
          catch { useOneShotCredential = true; }
        }

        let transaction;
        try {
          transaction = credentialTransactions.runCredentialMutation({
            mutate: () => {
              if (useOneShotCredential) {
                const request = {
                  profileId: expectedProfileId,
                  username: next.username,
                  password: patch.password,
                };
                let staged;
                try { staged = stageOneShotCredential(request); }
                finally { clearPasswordReference(request); }
                if (!staged || staged.ok !== true || staged.storage !== 'memory_only' ||
                    !Number.isSafeInteger(staged.revision) || staged.revision <= 0) {
                  throw Object.assign(new Error('one-shot credential staging failed'), {
                    credentialStoreUnavailable: true,
                  });
                }
                oneShotRevision = staged.revision;
                credentialStorage = 'memory_only';
                // Retire any older encrypted username/password pair. Leaving
                // it beside a new username could authenticate the wrong
                // account after a later relaunch.
                if (!removePassword()) {
                  throw new Error('could not durably remove the replaced encrypted credential');
                }
              } else {
                if (!savePassword(patch.password, next.username)) {
                  throw Object.assign(new Error('protected credential storage unavailable'), {
                    credentialStoreUnavailable: true,
                  });
                }
                credentialStorage = 'persistent';
              }
              next = saveSettings(next);
              return next;
            },
          });
        } catch (error) {
          if (oneShotRevision !== null) {
            try { clearOneShotCredential(oneShotRevision); } catch {}
            oneShotRevision = null;
            credentialStorage = null;
          }
          throw error;
        }
        if (!transaction.ok) {
          if (oneShotRevision !== null) {
            try { clearOneShotCredential(oneShotRevision); } catch {}
            oneShotRevision = null;
            credentialStorage = null;
          }
          const passwordWasCleared = transaction.recovery?.status === 'credential-cleared';
          credentialTransactions.applyCredentialRecoveryOutcome(transaction.recovery, {
            clearedNoticeKey: 'error.settingsSaveFailedPasswordCleared',
          });
          const message = credentialTransactions.isCredentialTransactionBlocked()
            ? translate('error.credentialRecoveryBlocked')
            : (passwordWasCleared
              ? translate('error.settingsSaveFailedPasswordCleared')
              : transaction.error?.credentialStoreUnavailable
                ? translate('error.passwordStoreUnavailable')
                : translate('error.settingsSaveFailed'));
          throw Object.assign(new Error(message), {
            userMessage: message,
            rollbackIncomplete: credentialTransactions.isCredentialTransactionBlocked(),
          });
        }
        credentialTransactions.applyCredentialRecoveryOutcome(
          { ok: true, status: 'committed' },
          { clearNotice: true },
        );
        if (credentialStorage === 'persistent' && oneShotEnabled) {
          try { clearOneShotCredential(); } catch {}
        }
        return transaction.value;
      };

      try {
        if (policyTransactionRequired) {
          await runPolicyTransaction(() => {
            previous = loadSettings();
            ({ settings: next, portChanged, proxyAuthChanged, underlayChanged } = applySettingsPatch(
              previous,
              patch,
            ));
            return {
              commit: commitCandidateSettings,
              rollback: () => saveSettings(previous),
              resumeBrowser: !(portChanged || proxyAuthChanged || underlayChanged),
            };
          });
        } else {
          await runSerialTransaction(() => {
            assertPersistence();
            previous = loadSettings();
            ({ settings: next, portChanged, proxyAuthChanged } = applySettingsPatch(
              previous,
              patch,
            ));
            return {
              commit: commitCandidateSettings,
              rollback: replacingPassword ? undefined : () => saveSettings(previous),
            };
          });
        }
      } catch (saveError) {
        return {
          ok: false,
          error: saveError.userMessage || (policyTransactionRequired
            ? saveError.message
            : translate('error.settingsSaveFailed')),
          rollbackIncomplete: saveError.rollbackIncomplete === true,
          settings: previous,
        };
      }

      if (next.language !== previous.language) onLanguageChanged(next.language);
      if (typeof patch.startAtLogin === 'boolean') setStartAtLogin(patch.startAtLogin);
      let reconnected = false;
      let reconnectStatus = 'not_required';
      let warning = credentialStorage === 'memory_only'
        ? translate('error.passwordStoreUnavailable')
        : null;
      if (hasActiveEngine() && (portChanged || proxyAuthChanged || underlayChanged)) {
        reconnectStatus = 'failed';
        let reconnectResult = null;
        try { reconnectResult = await reconnect(); }
        catch (error) { reconnectResult = { ok: false, error: error?.userMessage || error?.message }; }
        reconnected = reconnectResult?.ok === true;
        reconnectStatus = reconnected ? 'succeeded'
          : (reconnectResult?.stale === true ? 'stale' : 'failed');
        if (!reconnected) warning = reconnectFailureMessage(reconnectResult, translate);
      }
      const outcome = credentialStorage === 'memory_only'
        ? 'saved_memory_only'
        : (reconnectStatus === 'succeeded'
          ? 'saved_reconnected'
          : (reconnectStatus === 'failed' || reconnectStatus === 'stale'
            ? 'saved_reconnect_failed'
            : 'saved'));
      return {
        ok: true,
        outcome,
        warning,
        settings: next,
        portChanged,
        proxyAuthChanged,
        underlayChanged,
        reconnected,
        reconnect: Object.freeze({
          attempted: reconnectStatus !== 'not_required',
          status: reconnectStatus,
        }),
        credentialStorage,
      };
    } finally {
      clearPasswordReference(patch);
      clearPasswordReference(rawPatch);
    }
  });

  register('logout', () => runSerialTransaction(() => ({
    commit: async () => {
      const stopped = await disconnect();
      if (!stopped.ok) return { ok: false, error: translate('error.engineStuck') };
      if (oneShotEnabled) {
        try { clearOneShotCredential(); } catch {}
      }
      if (credentialTransactions.isCredentialTransactionBlocked()) {
        const recovery = credentialTransactions.retryCredentialTransactionRecovery();
        if (recovery.status === 'blocked') {
          return { ok: false, error: translate('error.credentialRecoveryBlocked') };
        }
      }

      let previous;
      try {
        previous = loadSettings();
      } catch (error) {
        return { ok: false, error: error.message };
      }
      const transaction = credentialTransactions.runCredentialMutation({
        mutate: () => {
          if (!removePassword()) {
            throw new Error('could not durably remove encrypted credential');
          }
          return saveSettings({ ...previous, username: '' });
        },
      });
      if (!transaction.ok) {
        const passwordWasCleared = transaction.recovery?.status === 'credential-cleared';
        credentialTransactions.applyCredentialRecoveryOutcome(transaction.recovery, {
          clearedNoticeKey: 'error.logoutFailedPasswordCleared',
        });
        const message = credentialTransactions.isCredentialTransactionBlocked()
          ? translate('error.credentialRecoveryBlocked')
          : (passwordWasCleared
            ? translate('error.logoutFailedPasswordCleared')
            : translate('error.logoutFailed'));
        return {
          ok: false,
          error: message,
          rollbackIncomplete: credentialTransactions.isCredentialTransactionBlocked(),
        };
      }
      credentialTransactions.applyCredentialRecoveryOutcome(
        { ok: true, status: 'committed' },
        { clearNotice: true },
      );
      return { ok: true, settings: transaction.value };
    },
  })));
}

module.exports = {
  registerSettingsCredentialIpc,
  settingsPatchFromIpc,
};
