import zh_common from './locales/zh/common.mjs';
import zh_account from './locales/zh/account.mjs';
import zh_connection from './locales/zh/connection.mjs';
import zh_resources from './locales/zh/resources.mjs';
import zh_workspace from './locales/zh/workspace.mjs';
import zh_control_tower from './locales/zh/control-tower.mjs';
import zh_settings from './locales/zh/settings.mjs';
import zh_browser from './locales/zh/browser.mjs';
import en_common from './locales/en/common.mjs';
import en_account from './locales/en/account.mjs';
import en_connection from './locales/en/connection.mjs';
import en_resources from './locales/en/resources.mjs';
import en_workspace from './locales/en/workspace.mjs';
import en_control_tower from './locales/en/control-tower.mjs';
import en_settings from './locales/en/settings.mjs';
import en_browser from './locales/en/browser.mjs';
import { composeLocale } from './compose.mjs';

export const dictionaries = {
  zh: composeLocale([zh_common, zh_account, zh_connection, zh_resources, zh_workspace, zh_control_tower, zh_settings, zh_browser]),
  en: composeLocale([en_common, en_account, en_connection, en_resources, en_workspace, en_control_tower, en_settings, en_browser]),
};

export function resolveLocale(rawLocale) {
  const value = String(rawLocale || '').trim().toLowerCase();
  if (!value || value.startsWith('zh')) return 'zh';
  return 'en';
}

function interpolate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (match, name) => (
    vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  ));
}

export function createT(locale) {
  const dict = dictionaries[locale] || dictionaries.zh;
  return (key, vars) => {
    const template = dict[key] ?? dictionaries.zh[key];
    return template === undefined ? key : interpolate(template, vars);
  };
}

// Static markup opts in with data-i18n="key" (textContent) and
// data-i18n-attr="placeholder:some.key; title:other.key" (attributes).
export function applyStatic(t, doc) {
  for (const el of doc.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'));
  }
  for (const el of doc.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.getAttribute('data-i18n-attr').split(';')) {
      const [attr, key] = pair.split(':').map((part) => part.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
}
