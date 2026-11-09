'use strict';

// Appended to the existing layout preload by the Electron regression.
// Clear and session replies are synthetic; no Main deletion is executed.
function createPortalCatalogFixture(base) {
  let phase = 'ready', generation = 'A', clearOutcome = 'success', held = false;
  const pending = [], counts = { full: 0, week: 0, clear: 0 };
  function snapshot() {
    const denied = phase === 'revoked';
    const state = denied ? 'not-authenticated' : phase === 'transient' ? 'failed' : 'ready';
    const entry = { id: 'synthetic-portal-' + generation, name: 'Synthetic portal ' + generation,
      localizedName: { en: 'Synthetic portal ' + generation, zh: '模拟门户 ' + generation },
      url: 'https://catalog.example.test/' + generation, useCase: 'Synthetic catalog fixture',
      audience: 'Synthetic', group: 'collab', aliases: ['syntheticcatalog'] };
    return {
      schemaVersion: 1, checkedAt: Date.now(), portalUrl: 'https://portal.example.test/',
      sessionState: denied ? 'unauthenticated' : 'authenticated',
      catalog: { state, applicationGroups: [{ id: 'collab', name: 'Synthetic group' }], serviceGroups: [],
        applications: state === 'ready' ? [entry] : [], serviceItems: [] },
      modules: {
        schedule: { state: denied ? 'not-authenticated' : phase === 'transient' ? 'failed' : 'empty',
          source: 'synthetic-calendar', fetchedAt: Date.now(), items: [] },
        loans: { state: 'source-unavailable', source: 'synthetic', items: [] },
        news: { state: 'failed', source: 'synthetic', items: [] },
      },
    };
  }
  function read(kind) {
    counts[kind]++;
    const value = snapshot();
    return held ? new Promise(resolve => pending.push(() => resolve(value))) : Promise.resolve(value);
  }
  return {
    ...base,
    getCampusData: () => read('full'), refreshCampusData: () => read('full'),
    refreshCampusSchedule: () => read('week'), getCampusScheduleWeek: () => read('week'),
    clearBrowserData: async () => {
      counts.clear++; phase = 'revoked';
      if (clearOutcome === 'rejected') throw Error('Synthetic clear rejection');
      return clearOutcome === 'refused' ? { ok: false, error: 'Synthetic clear refusal' } : { ok: true };
    },
    fixturePortal: options => {
      if (options.phase) phase = options.phase;
      if (options.generation) generation = options.generation;
      if (options.clearOutcome) clearOutcome = options.clearOutcome;
      if (typeof options.held === 'boolean') held = options.held;
      if (options.release) { held = false; for (const resolve of pending.splice(0)) resolve(); }
      return { counts: { ...counts }, pending: pending.length };
    },
  };
}
