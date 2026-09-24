// One terminal UI lifetime; operation and list tickets cannot publish across retirement.
export function createLifetime({ setTimeoutFn, clearTimeoutFn }) {
  let started = false, disposed = false, revision = 0, read = 0, timer = null, timerRevision = 0;
  const listeners = [];
  const alive = () => started && !disposed;
  const current = ticket => alive() && ticket.revision === revision &&
    (ticket.read === undefined || ticket.read === read);
  function clearTimer() {
    timerRevision++;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
  }
  function dispose() {
    if (disposed) return false;
    disposed = true; started = false; revision++;
    const errors = [];
    try { clearTimer(); } catch (error) { errors.push(error); }
    for (const [element, type, callback] of listeners.splice(0)) {
      try { element.removeEventListener(type, callback); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'integration listener cleanup failed');
    return true;
  }
  return Object.freeze({
    alive, current, clearTimer, dispose,
    start() { if (disposed) return false; started = true; return true; },
    begin() { return { revision: ++revision }; },
    request() { return { revision, read: ++read }; },
    listen(element, type, callback) {
      if (!alive()) return;
      listeners.push([element, type, callback]); element.addEventListener(type, callback);
      if (!alive()) element.removeEventListener(type, callback);
    },
    schedule(callback, delay) {
      clearTimer(); const version = timerRevision, ticket = { revision };
      const next = setTimeoutFn(() => {
        if (version === timerRevision && current(ticket)) callback();
      }, delay);
      if (version !== timerRevision || !current(ticket)) { clearTimeoutFn(next); return; }
      timer = next;
      timer?.unref?.();
    },
  });
}
