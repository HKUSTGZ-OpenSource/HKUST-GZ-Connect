import { createFeatureRegistry } from './registry.mjs';
import { create as createCampusData } from '../campus-data/index.mjs';
import { create as createOfficialFavorites } from '../official-favorites/index.mjs';
import { create as createAuthChallenge } from '../auth-challenge/index.mjs';
import { create as createIntegrationCenter } from '../integration-center/index.mjs';

// Only owners with an explicit start/dispose contract belong in this catalog.
export const FEATURE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'auth-challenge', create: createAuthChallenge }),
  Object.freeze({ id: 'integration-center', create: createIntegrationCenter }),
  Object.freeze({ id: 'official-favorites', create: createOfficialFavorites }),
  Object.freeze({ id: 'campus-data', create: createCampusData }),
]);

export function createRendererFeatures({ target } = {}) {
  return createFeatureRegistry({ definitions: FEATURE_DEFINITIONS, target });
}
