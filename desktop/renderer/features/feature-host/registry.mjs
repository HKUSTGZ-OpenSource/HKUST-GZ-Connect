// Synchronous Renderer owners only. No implicit discovery, globals or dynamic imports.
export function createFeatureRegistry({ definitions, target } = {}) {
  const synchronous = value => Object.prototype.toString.call(value) === '[object Function]';
  if (!Array.isArray(definitions)) throw new TypeError('feature definitions must be an array');
  const factories = new Map();
  for (const definition of definitions) {
    const { id, create } = definition || {};
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id) ||
        !synchronous(create) || factories.has(id)) {
      throw new TypeError('invalid or duplicate feature definition');
    }
    factories.set(id, create);
  }
  if (target && (typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function')) {
    throw new TypeError('invalid feature lifecycle target');
  }
  const mounted = new Map();
  let disposed = false, mounting = false;

  function retire(record, errors) {
    if (record.cleaned || !record.instance) return;
    record.cleaned = true;
    try {
      const cleanup = record.instance.dispose;
      if (!synchronous(cleanup)) throw new TypeError('feature cleanup must be synchronous');
      cleanup.call(record.instance);
    } catch (error) { errors.push(error); }
  }

  function retireAll(errors) {
    disposed = true;
    try { target?.removeEventListener('pagehide', dispose); }
    catch (error) { errors.push(error); }
    const records = [...mounted.values()].reverse();
    mounted.clear();
    for (const record of records) retire(record, errors);
  }

  function dispose() {
    if (disposed) return false;
    const errors = [];
    retireAll(errors);
    if (errors.length) throw new AggregateError(errors, 'feature cleanup failed');
    return true;
  }

  function mount(id, options) {
    if (disposed) throw new Error('feature registry is disposed');
    if (mounting) throw new Error('reentrant feature mount');
    if (!factories.has(id)) throw new Error('unknown feature');
    if (mounted.has(id)) throw new Error('feature already mounted');
    const record = { instance: null, cleaned: false };
    mounted.set(id, record);
    mounting = true;
    try {
      record.instance = factories.get(id)(options);
      if (disposed) throw new Error('feature registry is disposed');
      const owner = record.instance;
      if (!synchronous(owner?.start) || !synchronous(owner?.dispose)) {
        throw new TypeError('feature requires synchronous start and dispose');
      }
      if (owner.start() !== true) throw new Error('feature did not start');
      if (disposed) throw new Error('feature registry is disposed');
      return owner;
    } catch (primary) {
      const errors = [primary];
      retireAll(errors);
      // A constructor can retire the registry before returning its new owner.
      retire(record, errors);
      if (errors.length > 1) throw new AggregateError(errors, 'feature startup and cleanup failed');
      throw primary;
    } finally { mounting = false; }
  }

  target?.addEventListener('pagehide', dispose);
  return Object.freeze({ mount, dispose });
}
