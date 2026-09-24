const NEW_GROUP_VALUE = '__new_group__';

export function comparableUrl(value) {
  try {
    const url = new URL(String(value || ''));
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

export function create({
  api,
  document: doc,
  translate,
  getResources,
  getGroups,
  setResources,
  setGroups,
  onSaved = () => {},
  toast = () => {},
} = {}) {
  for (const dependency of [translate, getResources, getGroups, setResources, setGroups]) {
    if (typeof dependency !== 'function') {
      throw new TypeError('official favorite dialog dependencies are incomplete');
    }
  }
  if (!api || typeof api.createFavoriteResource !== 'function' ||
      typeof api.createFavoriteGroup !== 'function' ||
      typeof api.moveFavoriteResource !== 'function' || !doc) {
    throw new TypeError('official favorite dialog environment is incomplete');
  }
  const $ = (id) => doc.getElementById(id);
  const dialog = $('officialFavoriteDialog');
  let entry = null;
  let busy = false;
  let revision = 0;
  let started = false;
  let disposed = false;
  const unlisten = [];

  function resourceFor(target = entry) {
    if (disposed) return null;
    const key = comparableUrl(target?.url);
    return key ? getResources().find((resource) => (
      resource.favorite === true && comparableUrl(resource.url) === key
    )) || null : null;
  }

  function localized(target, field) {
    const english = String(doc.documentElement.lang || '').toLowerCase().startsWith('en');
    const bag = target?.[`localized${field}`];
    const plain = `${field.charAt(0).toLowerCase()}${field.slice(1)}`;
    return (english ? bag?.en : bag?.zh) || target?.[plain] || target?.[field] || '';
  }

  function renderGroupOptions(selected = '') {
    const options = [
      { id: '', name: translate('favoriteDialog.ungrouped') },
      ...getGroups(),
      { id: NEW_GROUP_VALUE, name: translate('favoriteDialog.newGroupOption') },
    ];
    $('officialFavoriteGroup').replaceChildren(...options.map(({ id, name }) => {
      const option = doc.createElement('option');
      option.value = id;
      option.textContent = name;
      option.selected = id === selected;
      return option;
    }));
    const creating = $('officialFavoriteGroup').value === NEW_GROUP_VALUE;
    $('officialFavoriteNewGroupField').hidden = !creating;
    $('officialFavoriteNewGroup').required = creating;
  }

  function setBusy(value) {
    if (disposed) return;
    busy = value === true;
    for (const id of [
      'officialFavoriteGroup', 'officialFavoriteNewGroup', 'saveOfficialFavorite',
      'cancelOfficialFavorite', 'closeOfficialFavorite',
    ]) $(id).disabled = busy;
    $('saveOfficialFavorite').textContent = translate(busy
      ? 'favoriteDialog.saving' : 'favoriteDialog.save');
  }

  function open(nextEntry) {
    if (disposed || !nextEntry?.id || !comparableUrl(nextEntry.url)) return false;
    entry = nextEntry;
    revision += 1;
    $('officialFavoriteName').textContent = localized(entry, 'Name');
    $('officialFavoriteDescription').textContent = localized(entry, 'UseCase');
    $('officialFavoriteError').textContent = '';
    $('officialFavoriteNewGroup').value = '';
    renderGroupOptions('');
    setBusy(false);
    if (!dialog.open) dialog.showModal();
    $('officialFavoriteGroup').focus({ preventScroll: true });
    return true;
  }

  async function submit(event) {
    event.preventDefault();
    if (disposed || busy || !entry) return;
    const currentRevision = revision;
    const current = () => !disposed && currentRevision === revision && dialog.open;
    $('officialFavoriteError').textContent = '';
    setBusy(true);
    try {
      const payload = {
        name: [...localized(entry, 'Name')].slice(0, 40).join(''), url: entry.url,
        description: [...localized(entry, 'UseCase')].slice(0, 80).join(''),
        routePreference: 'auto', groupId: null,
      };
      let groupId = $('officialFavoriteGroup').value || null;
      if (groupId === NEW_GROUP_VALUE) {
        const name = $('officialFavoriteNewGroup').value.trim();
        if (!name || name.length > 30) {
          $('officialFavoriteError').textContent = translate('favoriteDialog.invalidGroup');
          $('officialFavoriteNewGroup').focus();
          return;
        }
        const previousIds = new Set(getGroups().map(({ id }) => id));
        const created = await api.createFavoriteGroup(name);
        if (!current()) return;
        if (!created?.ok) throw new Error(created?.error || translate('favoriteDialog.failed'));
        const groups = created.groups || getGroups();
        const added = groups.filter(({ id }) => !previousIds.has(id));
        if (added.length !== 1) throw new Error(translate('favoriteDialog.failed'));
        groupId = added[0].id;
        setGroups(groups);
        if (!current()) return;
      }
      if (!current()) return;
      const saved = await api.createFavoriteResource(payload);
      if (!current()) return;
      if (!saved?.ok || !saved.resource) {
        throw new Error(saved?.error || translate('favoriteDialog.failed'));
      }
      const savedResource = Object.freeze({ ...saved.resource });
      setResources(saved.resources || getResources());
      if (!current()) return;
      const moved = await api.moveFavoriteResource({
        resourceId: savedResource.id,
        groupId,
        index: 0,
      });
      if (!current()) return;
      if (!moved?.ok) throw new Error(moved?.error || translate('favoriteDialog.failed'));
      setGroups(moved.groups || getGroups());
      if (!current()) return;
      setBusy(false);
      entry = null; revision++;
      const completedRevision = revision;
      dialog.close();
      if (disposed || revision !== completedRevision) return;
      onSaved({ groupId, resource: savedResource });
      if (!disposed && revision === completedRevision) toast(translate('favoriteDialog.saved'));
    } catch (error) {
      if (current()) {
        $('officialFavoriteError').textContent = error?.message || translate('favoriteDialog.failed');
      }
    } finally {
      if (current()) setBusy(false);
    }
  }

  function listen(target, type, handler) {
    if (!target?.addEventListener || !target?.removeEventListener) throw new TypeError('favorite listener target is invalid');
    const guarded = event => { if (!disposed) return handler(event); };
    target.addEventListener(type, guarded);
    unlisten.push(() => target.removeEventListener(type, guarded));
  }

  function dispose() {
    if (disposed) return false;
    disposed = true; revision++; entry = null; busy = false;
    const errors = [], attempt = fn => { try { fn(); } catch (error) { errors.push(error); } };
    for (const remove of unlisten.splice(0).reverse()) attempt(remove);
    attempt(() => { if (dialog?.open) dialog.close(); });
    for (const id of ['officialFavoriteName','officialFavoriteDescription','officialFavoriteError']) attempt(() => { const node=$(id); if(node)node.textContent=''; });
    attempt(() => $('officialFavoriteGroup')?.replaceChildren());
    attempt(() => { const node=$('officialFavoriteNewGroup'); if(node)node.value=''; });
    if (errors.length) throw new AggregateError(errors, 'favorite cleanup failed');
    return true;
  }

  function start() {
    if (started || disposed) return false;
    started = true;
    try {
      listen($('officialFavoriteGroup'), 'change', () => {
        const creating = $('officialFavoriteGroup').value === NEW_GROUP_VALUE;
        $('officialFavoriteNewGroupField').hidden = !creating;
        $('officialFavoriteNewGroup').required = creating;
        if (creating) $('officialFavoriteNewGroup').focus();
      });
      listen($('officialFavoriteForm'), 'submit', submit);
      listen($('closeOfficialFavorite'), 'click', () => { if (!busy) dialog.close(); });
      listen($('cancelOfficialFavorite'), 'click', () => { if (!busy) dialog.close(); });
      listen(dialog, 'close', () => { if (!dialog.open && entry) { entry = null; revision += 1; } });
      listen(doc, 'app-locale-changed', () => {
        if (dialog.open) renderGroupOptions($('officialFavoriteGroup').value);
      });
      return true;
    } catch (primary) {
      try { dispose(); }
      catch (cleanup) { throw new AggregateError([primary, cleanup], 'favorite startup and cleanup failed'); }
      throw primary;
    }
  }

  return Object.freeze({
    isFavorite: (target) => resourceFor(target) !== null,
    open,
    start,
    dispose,
  });
}
