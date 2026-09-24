import { createAuthChallengeFeature } from './controller.mjs';

export function create(options = {}) {
  const view = createAuthChallengeFeature(options);
  const { api } = options;
  let started = false, disposed = false, version = 0, unsubscribe = null;
  function render(challenge) {
    if (!started || disposed) return;
    version++; view.render(challenge);
  }
  function dispose() {
    if (disposed) return false;
    disposed = true; started = false; version++;
    const stop = unsubscribe; unsubscribe = null;
    const errors = [];
    try { stop?.(); } catch (error) { errors.push(error); }
    try { view.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'auth owner cleanup failed');
    return true;
  }
  function start() {
    if (disposed) return false;
    if (started) return true;
    started = true;
    try {
      if (view.start() !== true || disposed) throw new Error('auth owner retired during startup');
      const initialVersion = version;
      const stop = api.onAuthChallenge(render);
      if (typeof stop !== 'function') throw new TypeError('auth subscription must return cleanup');
      if (disposed) { stop(); throw new Error('auth owner retired during subscription'); }
      unsubscribe = stop;
      Promise.resolve(api.getState()).then(state => {
        if (!disposed && version === initialVersion) render(state?.authChallenge || null);
      }).catch(() => {});
      return !disposed;
    } catch (error) {
      try { dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'auth owner startup failed'); }
      throw error;
    }
  }
  return Object.freeze({ start, dispose, render, clearResponse: view.clearResponse });
}

export function start(options = {}) {
  if (!options.document || !options.api || !options.i18n) return null;
  const owner = create(options);
  if (owner.start() !== true) throw new Error('auth owner retired during startup');
  return owner;
}
