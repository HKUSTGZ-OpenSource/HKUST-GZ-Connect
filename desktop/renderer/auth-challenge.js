// Compatibility entrypoint. Lifecycle changes are reviewed separately from this extraction.
import { createAuthChallengeFeature as create, MAX_RESPONSE_BYTES, start as startOwner } from './features/auth-challenge/index.mjs';
const target = typeof window !== 'undefined' ? window : globalThis;
export const createAuthChallengeFeature = options => create({ ...options, target: options?.target ?? target });
export const start = () => startOwner({ target, document: target.document, api: target.api, i18n: target.I18N });
export { MAX_RESPONSE_BYTES };
target.authChallenge = { createAuthChallengeFeature, MAX_RESPONSE_BYTES, start };
if (target.document) target.setTimeout(() => start(), 0);
