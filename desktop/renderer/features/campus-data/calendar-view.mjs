import { weekRange, sameLocalDay, scheduleWeekModel, scheduleWeekLayout } from './calendar-model.mjs';

export function renderSchedule(module, {
  selectedDate, clockNow, miniature, locale, translate, escapeHtml, stateHtml, actionHtml, onGroups, scheduleNotice,
  lastScheduleLayout = null, onLayout = () => {},
}) {
  const navigation = `<div class="week-navigation" role="group" aria-label="${escapeHtml(translate('workspace.scheduleChooseWeek'))}">`
    + `<button type="button" data-week-move="-1" aria-label="${escapeHtml(translate('workspace.schedulePrevious'))}">‹</button>`
    + `<label><span class="week-date-label">${escapeHtml(translate('workspace.scheduleChooseWeek'))}</span><input id="scheduleDate" type="date" aria-label="${escapeHtml(translate('workspace.scheduleChooseWeek'))}" min="0001-01-01" max="9999-12-31" value="${selectedDate}"></label>`
    + `<button type="button" data-week-move="1" aria-label="${escapeHtml(translate('workspace.scheduleNext'))}">›</button>`
    + `<button type="button" data-week-today>${escapeHtml(translate('workspace.scheduleToday'))}</button></div>`;
  const pending = module.state === 'loading';
  if (!pending && !['ready', 'empty'].includes(module.state)) return navigation + stateHtml(module, 'schedule');
  const now = clockNow();
  const campusTime = pending || module.source === 'myportal-calendar';
  const model = scheduleWeekModel(module.state === 'ready' ? module.items : [],
    Date.parse(`${selectedDate}T12:00:00+08:00`), campusTime);
  let layout = scheduleWeekLayout(model, miniature);
  if (pending) {
    layout = { ...layout, ...(lastScheduleLayout || {}), groups: [],
      height: Math.min(lastScheduleLayout?.height || 180, miniature ? 140 : 180) };
  } else {
    const { start, end, height, slotCount } = layout;
    onLayout({ start, end, height, slotCount });
  }
  onGroups(layout.groups);
  const format = (value, options) => new Intl.DateTimeFormat(locale(), {
    ...options, ...(campusTime ? { timeZone: 'Asia/Shanghai' } : {}),
  }).format(new Date(value));
  const formatDate = value => format(value, { month: 'short', day: 'numeric' });
  const formatWeekday = value => format(value, { weekday: 'short' });
  const formatTime = value => format(value, { hour: '2-digit', minute: '2-digit', hour12: false });
  const lastDay = model.days.at(-1);
  const weekLabel = translate('workspace.scheduleWeekRange', {
    start: format(model.start, { ...(miniature ? {} : { year: 'numeric' }), month: miniature ? 'numeric' : 'short', day: 'numeric' }),
    end: format(lastDay, { ...(miniature ? {} : { year: 'numeric' }), month: miniature ? 'numeric' : 'short', day: 'numeric' }),
  });
  const headers = model.days.map((day, index) => {
    const today = sameLocalDay(day, now, campusTime);
    return `<div class="week-day-head${today ? ' is-today' : ''}" data-day="${index}" role="columnheader" aria-label="${escapeHtml(`${formatWeekday(day)} ${formatDate(day)}`)}"${today ? ' aria-current="date"' : ''}>`
      + `<span>${escapeHtml(formatWeekday(day))}</span><strong>${escapeHtml(miniature ? format(day, { day: 'numeric' }) : formatDate(day))}</strong></div>`;
  }).join('');
  const lanes = model.days.map((day, index) => (
    `<div class="week-day-lane${sameLocalDay(day, now, campusTime) ? ' is-today' : ''}" data-day="${index}" aria-hidden="true"></div>`
  )).join('');
  const times = Array.from({ length: layout.slotCount }, (_, index) => {
    const hour = String(layout.start / 60 + index * 2).padStart(2, '0');
    return `<time class="week-time" data-slot="${index}" aria-hidden="true">${hour}:00</time>`;
  }).join('');
  const events = model.days.map((_, index) => {
    const dayEvents = layout.groups.filter(({ day }) => day === index)
      .map((group) => {
    const { day, segmentStart, segmentEnd, top, bottom, members } = group;
    const endLabel = segmentEnd === (model.days[day + 1] ?? model.end) ? '24:00' : formatTime(segmentEnd);
    const cardHeight = bottom - top - 4;
    const grouped = members.length > 1;
    const fullTitle = members[0].entry.title;
    const shortTitle = /[\u3400-\u9fff]/u.test(fullTitle) ? fullTitle.slice(0, 3) : fullTitle.trim().split(/[\s–—-]+/u)[0].slice(0, 8);
    const title = grouped ? translate(miniature ? 'workspace.scheduleGroupedCompact' : 'workspace.scheduleGrouped', { count: members.length }) : miniature ? shortTitle : fullTitle;
    const content = `<time>${escapeHtml(miniature || cardHeight < 40 ? formatTime(segmentStart) : `${formatTime(segmentStart)}–${endLabel}`)}</time>`
      + `<strong>${escapeHtml(title)}</strong>`;
    const label = `${formatTime(segmentStart)}–${endLabel} ${members.map(e => e.entry.title).join(' · ')}`;
    const attrs = `class="week-event${cardHeight < 40 ? ' is-inline' : ''}${cardHeight >= 48 ? ' is-tall' : ''}${grouped ? ' is-group' : ''}" data-day="${day}" data-count="${members.length}"`
      + ` data-offset="${top}" data-height="${cardHeight}" data-schedule-index="${layout.groups.indexOf(group)}"`
      + ` title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"`;
    return `<button type="button" ${attrs}>${content}</button>`;
      }).join('');
    return `<div class="week-event-day" data-day="${index}">${dayEvents}</div>`;
  }).join('');
  const empty = pending || model.events.length ? ''
    : `<div class="week-empty" role="status"><strong>${escapeHtml(translate('workspace.scheduleWeekEmpty'))}</strong>`
      + `<span>${escapeHtml(translate('workspace.scheduleWeekEmptyHint'))}</span></div>`;
  return navigation + (scheduleNotice ? `<p class="week-refresh-notice" role="status">${escapeHtml(translate(scheduleNotice))}</p>` : '') + `<div class="week-summary" aria-live="polite"><strong>${escapeHtml(weekLabel)}${model.start === weekRange(now, campusTime).start ? ` · ${escapeHtml(translate('workspace.scheduleToday'))}` : ''}</strong>`
    + `<span role="status">${escapeHtml(pending ? translate('workspace.scheduleLoadingWeek') : translate('workspace.scheduleWeekCount', { count: model.eventCount }))}</span></div>`
    + `<div class="week-scroll" role="region" aria-label="${escapeHtml(translate('workspace.scheduleWeekTable'))}">`
    + `<div class="week-table${miniature ? ' is-mini' : ''}" role="grid" aria-busy="${pending}"><div class="week-head" role="row">`
    + `<div class="week-time-head" role="columnheader">${escapeHtml(translate('workspace.scheduleTime'))}</div>${headers}</div>`
    + `<div class="week-body" data-slot-count="${layout.slotCount}" data-height="${layout.height}">${lanes}${times}${events}${empty}</div></div></div>`
    + `<dialog id="scheduleDetail" class="week-detail"></dialog>` + actionHtml('source', 'schedule');
}
