'use strict';

const STABLE_SESSION_MS = 20_000;
const MAX_DELAY_MS = 15_000;
const NETWORK_RECOVERY_DELAY_MS = 30_000;

function planReconnect({
  attempts = 0,
  maxAttempts = 0,
  wasConnected = false,
  uptimeMs = 0,
  failureKind = 'unknown',
} = {}) {
  const usedAttempts = wasConnected && uptimeMs > STABLE_SESSION_MS ? 0 : attempts;
  const networkOutage = ['network-transient', 'gateway-transient'].includes(failureKind);
  if (maxAttempts <= 0 || (!networkOutage && usedAttempts >= maxAttempts)) return null;

  // The short retry budget limits the burst, not the duration of a physical
  // outage. Retain intent and poll at a low fixed rate once that burst is spent.
  if (networkOutage && usedAttempts >= maxAttempts) {
    return { attempt: maxAttempts, delayMs: NETWORK_RECOVERY_DELAY_MS };
  }

  const attempt = usedAttempts + 1;
  const delayStep = networkOutage || failureKind === 'gateway-transient' ? 5000 : 2000;
  return {
    attempt,
    delayMs: Math.min(delayStep * attempt, MAX_DELAY_MS),
  };
}

module.exports = { MAX_DELAY_MS, STABLE_SESSION_MS, planReconnect };
