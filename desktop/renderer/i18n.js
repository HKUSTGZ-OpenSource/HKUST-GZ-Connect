// Compatibility bridge for legacy Renderer consumers; canonical text lives in localization/.
import { applyStatic, createT, dictionaries, resolveLocale } from './features/localization/index.mjs';
export { applyStatic, createT, dictionaries, resolveLocale };
if (typeof window !== 'undefined') window.I18N = { applyStatic, createT, dictionaries, resolveLocale };
