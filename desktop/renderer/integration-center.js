// Transitional composition only; the native public entrypoint has no startup side effects.
import { adapterView, createIntegrationCenter, previewView } from './features/integration-center/index.mjs';
export { adapterView, createIntegrationCenter, previewView };
const root = typeof self !== 'undefined' ? self : globalThis;
root.integrationCenter = { adapterView, createIntegrationCenter, previewView };

if (typeof window !== 'undefined' && window.document && window.api && window.I18N) {
  const locale = () => window.document.documentElement.lang?.startsWith('zh') ? 'zh' : 'en';
  const feature = window.integrationCenter.createIntegrationCenter({
    api: window.api,
    document: window.document,
    translate: window.I18N.createT(locale()),
  });
  window.document.addEventListener('app-locale-changed', () => {
    feature.setTranslator(window.I18N.createT(locale()));
  });
  window.document.addEventListener('app-state-refreshed', (event) => {
    if (event.detail?.loggedIn === true) feature.refresh().catch(() => {});
  });
  feature.start();
  window.integrationCenterFeature = feature;
}
