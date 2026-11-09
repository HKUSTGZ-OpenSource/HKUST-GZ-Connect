const ACCEPTED_STATES = new Set([
  'not-authenticated', 'authenticating', 'loading', 'ready', 'empty', 'forbidden',
  'session-expired', 'source-unavailable', 'tunnel-required', 'failed',
]);

export function validModule(module) {
  return module && typeof module === 'object' && ACCEPTED_STATES.has(module.state) &&
    Array.isArray(module.items);
}

export const reusable = module => validModule(module) && ['ready', 'empty'].includes(module.state);

// Undefined retains the last-good catalog; null explicitly retires its projection.
export function catalogProjection(value, allowReady = true) {
  // A schedule permission denial can coexist with an authenticated catalog.
  const retired = value?.sessionState === 'unauthenticated' ||
    ['not-authenticated', 'session-expired'].includes(value?.modules?.schedule?.state) ||
    ['not-authenticated', 'session-expired', 'forbidden'].includes(value?.catalog?.state);
  if (retired) return null;
  return allowReady && value?.catalog?.state === 'ready' ? value.catalog : undefined;
}
