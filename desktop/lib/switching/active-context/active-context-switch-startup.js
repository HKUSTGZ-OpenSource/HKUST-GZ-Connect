'use strict';

const {
  ActiveContextSwitchJournalStore,
} = require('./active-context-switch-store');

function assertActiveContextSwitchStartupClear({
  mode,
  filePath,
  profileStorageEffects,
  createStore = (options) => new ActiveContextSwitchJournalStore({
    ...options,
    profileStorageEffects,
  }),
} = {}) {
  if (!['legacy-flat', 'profile-workspace'].includes(mode) ||
      typeof filePath !== 'string' || !filePath || typeof createStore !== 'function') {
    throw new TypeError('active context startup guard inputs are invalid');
  }
  if (mode === 'legacy-flat') return Object.freeze({ clear: true, mode });
  let journal;
  try { journal = createStore({ filePath }).read(); }
  catch (cause) {
    const error = new Error('active context switch authority is unreadable', { cause });
    error.code = 'ACTIVE_CONTEXT_SWITCH_UNREADABLE';
    throw error;
  }
  if (journal !== null) {
    const error = new Error('active context switch recovery is required');
    error.code = 'ACTIVE_CONTEXT_SWITCH_RECOVERY_REQUIRED';
    error.switchState = journal.state;
    throw error;
  }
  return Object.freeze({ clear: true, mode });
}

module.exports = { assertActiveContextSwitchStartupClear };
