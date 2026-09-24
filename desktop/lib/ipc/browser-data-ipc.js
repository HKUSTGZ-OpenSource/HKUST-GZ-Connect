'use strict';

const { calendarWeekQuery } = require('../browser/session/browser-session-manager');

function registerBrowserDataIpc({ register, clearSiteData, translate, campusData = null } = {}) {
  for (const dependency of [register, clearSiteData, translate]) {
    if (typeof dependency !== 'function') {
      throw new TypeError('browser data IPC dependencies are incomplete');
    }
  }
  if (campusData && (typeof campusData.snapshot !== 'function' ||
      typeof campusData.refreshSchedule !== 'function' || typeof campusData.invalidate !== 'function')) {
    throw new TypeError('campus data IPC dependencies are incomplete');
  }
  register('clear-browser-data', async (_event, ...args) => {
    if (args.length !== 0) {
      return { ok: false, error: translate('error.browserDataClearFailed') };
    }
    try {
      campusData?.invalidate();
      if (await clearSiteData() !== true) {
        return { ok: false, error: translate('error.browserDataClearFailed') };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: translate('error.browserDataClearFailed') };
    } finally {
      try { campusData?.invalidate(); }
      catch { return { ok: false, error: translate('error.browserDataClearFailed') }; }
    }
  });
  if (campusData) {
    register('get-campus-data', (_event, ...args) => {
      if (args.length) throw new TypeError('campus data request must be value-free');
      return campusData.snapshot();
    });
    register('refresh-campus-data', (_event, ...args) => {
      if (args.length) throw new TypeError('campus data refresh must be value-free');
      return campusData.snapshot({ force: true });
    });
    register('refresh-campus-schedule', (_event, ...args) => {
      if (args.length) throw new TypeError('campus schedule refresh must be value-free');
      return campusData.refreshSchedule();
    });
    register('get-campus-schedule-week', (_event, ...args) => {
      if (args.length !== 1) throw new TypeError('calendar selection requires one value');
      const { date, force } = calendarWeekQuery(args[0]);
      return campusData.scheduleWeek({ date, force });
    });
  }
}

module.exports = { registerBrowserDataIpc };
