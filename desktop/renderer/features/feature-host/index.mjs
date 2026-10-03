import { createFeatureRegistry } from './registry.mjs';
import { create as createCampusData } from '../campus-data/index.mjs';
import { create as createOfficialFavorites } from '../official-favorites/index.mjs';
import { create as createAuthChallenge } from '../auth-challenge/index.mjs';
import { create as createIntegrationCenter } from '../integration-center/index.mjs';
import { create as createConnectionOverview } from '../connection-overview/index.mjs';
import { create as createUpdateNotices } from '../update-notices/index.mjs';
import { create as createNotifications } from '../notifications/index.mjs';
import { create as createControlTower } from '../control-tower/index.mjs';
import { create as createBrowserNewTabSettings } from '../browser-new-tab-settings/index.mjs';

// Only owners with an explicit start/dispose contract belong in this catalog.
export const FEATURE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'auth-challenge', create: createAuthChallenge }),
  Object.freeze({ id: 'integration-center', create: createIntegrationCenter }),
  Object.freeze({ id: 'official-favorites', create: createOfficialFavorites }),
  Object.freeze({ id: 'campus-data', create: createCampusData }),
  Object.freeze({ id: 'connection-overview', create: createConnectionOverview }),
  Object.freeze({ id: 'update-notices', create: createUpdateNotices }),
  Object.freeze({ id: 'notifications', create: createNotifications }),
  Object.freeze({ id: 'control-tower', create: createControlTower }),
  Object.freeze({ id: 'browser-new-tab-settings', create: createBrowserNewTabSettings }),
]);

export function createRendererFeatures({ target } = {}) {
  return createFeatureRegistry({ definitions: FEATURE_DEFINITIONS, target });
}
