const WEEK_SLOT_START = 8 * 60;
const WEEK_SLOT_MINUTES = 120;
const WEEK_SLOT_COUNT = 7;

export function weekRange(now = Date.now(), campusTime = false) {
  if (campusTime) {
    const offset = 8 * 60 * 60 * 1000;
    const day = new Date(now + offset);
    if (!Number.isFinite(day.getTime())) throw new TypeError('week timestamp is invalid');
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    const start = day.getTime() - offset;
    return Object.freeze({ start, end: start + 7 * 86_400_000,
      days: Object.freeze(Array.from({ length: 7 }, (_, i) => start + i * 86_400_000)) });
  }
  const start = new Date(now);
  if (!Number.isFinite(start.getTime())) throw new TypeError('week timestamp is invalid');
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(day.getDate() + index);
    return day.getTime();
  });
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return Object.freeze({ start: start.getTime(), end: end.getTime(), days: Object.freeze(days) });
}

export function sameLocalDay(left, right, campusTime = false) {
  if (campusTime) return Math.floor((left + 28_800_000) / 86_400_000) ===
    Math.floor((right + 28_800_000) / 86_400_000);
  const a = new Date(left);
  const b = new Date(right);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

export function scheduleWeekModel(entries, now = Date.now(), campusTime = false) {
  const range = weekRange(now, campusTime);
  const items = Array.isArray(entries) ? entries : [];
  const intersecting = items.filter((entry) => Number.isFinite(entry?.startsAt) &&
    Number.isFinite(entry?.endsAt) && entry.endsAt > entry.startsAt &&
    Number.isFinite(new Date(entry.startsAt).getTime()) &&
    Number.isFinite(new Date(entry.endsAt).getTime()) &&
    entry.startsAt < range.end && entry.endsAt > range.start);
  const segments = intersecting.flatMap((entry) => range.days.flatMap((dayStart, day) => {
    const dayEnd = range.days[day + 1] ?? range.end;
    const segmentStart = Math.max(entry.startsAt, dayStart);
    const segmentEnd = Math.min(entry.endsAt, dayEnd);
    if (segmentEnd <= segmentStart) return [];
    const start = new Date(segmentStart + (campusTime ? 28_800_000 : 0));
    const end = new Date(segmentEnd + (campusTime ? 28_800_000 : 0));
    const minutes = (date) => campusTime ? date.getUTCHours() * 60 + date.getUTCMinutes()
      : date.getHours() * 60 + date.getMinutes();
    const startMinutes = minutes(start);
    const endMinutes = segmentEnd === dayEnd ? 24 * 60
      : minutes(end);
    return [{ entry, day, startMinutes, endMinutes, segmentStart, segmentEnd }];
  }));
  const slotStart = Math.floor(Math.min(WEEK_SLOT_START,
    ...segments.map(({ startMinutes }) => startMinutes)) / WEEK_SLOT_MINUTES) * WEEK_SLOT_MINUTES;
  const slotEnd = Math.ceil(Math.max(WEEK_SLOT_START + WEEK_SLOT_COUNT * WEEK_SLOT_MINUTES,
    ...segments.map(({ endMinutes }) => endMinutes)) / WEEK_SLOT_MINUTES) * WEEK_SLOT_MINUTES;
  const slotCount = (slotEnd - slotStart) / WEEK_SLOT_MINUTES;
  const events = segments.map(({ startMinutes, endMinutes, ...segment }) => {
    const slot = Math.floor((startMinutes - slotStart) / WEEK_SLOT_MINUTES);
    const endSlot = Math.max(slot + 1, Math.ceil((endMinutes - slotStart) / WEEK_SLOT_MINUTES));
    return { ...segment, startMinutes, endMinutes, slot, span: endSlot - slot };
  }).sort((left, right) => left.segmentStart - right.segmentStart);
  return Object.freeze({ ...range, slotStart, slotCount,
    events: Object.freeze(events.map(Object.freeze)), eventCount: intersecting.length });
}

export function scheduleWeekLayout(model, miniature = false) {
  let start = model.events.length ? Math.floor(Math.min(...model.events.map(e => e.startMinutes)) / 120) * 120 : 480;
  let end = model.events.length ? Math.ceil(Math.max(...model.events.map(e => e.endMinutes)) / 120) * 120 : 1200;
  if (end - start < 240) { start = Math.max(0, start - 120); end = Math.min(1440, start + 240); start = end - 240; }
  const height = Math.min(miniature ? 180 : 300, Math.max(miniature ? 140 : 180, (end - start) * (miniature ? .42 : .6)));
  const scale = height / (end - start);
  const groups = [];
  for (let day = 0; day < 7; day++) {
    let previous = null;
    for (const event of model.events.filter(e => e.day === day)) {
      const minimumHeight = miniature ? 28 : 30;
      const top = Math.min(height - minimumHeight, (event.startMinutes - start) * scale);
      const bottom = Math.min(height, Math.max(top + minimumHeight, (event.endMinutes - start) * scale));
      // Group intersecting visual intervals instead of creating unreadable narrow columns.
      // Very short adjacent entries can share a group too; the detail view retains exact times.
      if (previous && top < previous.bottom) {
        previous.bottom = Math.max(previous.bottom, bottom);
        previous.segmentEnd = Math.max(previous.segmentEnd, event.segmentEnd);
        previous.members.push(event);
      } else {
        previous = { day, top, bottom, segmentStart: event.segmentStart, segmentEnd: event.segmentEnd, members: [event] };
        groups.push(previous);
      }
    }
  }
  return Object.freeze({ start, end, height, scale, slotCount: (end - start) / 120,
    groups: Object.freeze(groups.map(group => Object.freeze({ ...group, members: Object.freeze(group.members) }))) });
}
