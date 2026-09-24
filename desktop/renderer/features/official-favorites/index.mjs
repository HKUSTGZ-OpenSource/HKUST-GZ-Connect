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

  function resourceFor(target = entry) {
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
    busy = value === true;
    for (const id of [
      'officialFavoriteGroup', 'officialFavoriteNewGroup', 'saveOfficialFavorite',
      'cancelOfficialFavorite', 'closeOfficialFavorite',
    ]) $(id).disabled = busy;
    $('saveOfficialFavorite').textContent = translate(busy
      ? 'favoriteDialog.saving' : 'favoriteDialog.save');
  }

  function open(nextEntry) {
    if (!nextEntry?.id || !comparableUrl(nextEntry.url)) return false;
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
    if (busy || !entry) return;
    const currentRevision = revision;
    $('officialFavoriteError').textContent = '';
    setBusy(true);
    try {
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
        if (!created?.ok) throw new Error(created?.error || translate('favoriteDialog.failed'));
        const groups = created.groups || getGroups();
        setGroups(groups);
        groupId = groups.find(({ id }) => !previousIds.has(id))?.id || null;
        if (!groupId) throw new Error(translate('favoriteDialog.failed'));
      }
      const saved = await api.createFavoriteResource({
        name: [...localized(entry, 'Name')].slice(0, 40).join(''),
        url: entry.url,
        description: [...localized(entry, 'UseCase')].slice(0, 80).join(''),
        routePreference: 'auto',
        groupId: null,
      });
      if (!saved?.ok || !saved.resource) {
        throw new Error(saved?.error || translate('favoriteDialog.failed'));
      }
      setResources(saved.resources || getResources());
      const moved = await api.moveFavoriteResource({
        resourceId: saved.resource.id,
        groupId,
        index: 0,
      });
      if (!moved?.ok) throw new Error(moved?.error || translate('favoriteDialog.failed'));
      setGroups(moved.groups || getGroups());
      if (currentRevision !== revision || !dialog.open) return;
      dialog.close();
      onSaved({ groupId, resource: saved.resource });
      toast(translate('favoriteDialog.saved'));
    } catch (error) {
      if (currentRevision === revision && dialog.open) {
        $('officialFavoriteError').textContent = error?.message || translate('favoriteDialog.failed');
      }
    } finally {
      setBusy(false);
    }
  }

  function start() {
    if (started) return false;
    started = true;
    $('officialFavoriteGroup').addEventListener('change', () => {
      const creating = $('officialFavoriteGroup').value === NEW_GROUP_VALUE;
      $('officialFavoriteNewGroupField').hidden = !creating;
      $('officialFavoriteNewGroup').required = creating;
      if (creating) $('officialFavoriteNewGroup').focus();
    });
    $('officialFavoriteForm').addEventListener('submit', submit);
    $('closeOfficialFavorite').addEventListener('click', () => { if (!busy) dialog.close(); });
    $('cancelOfficialFavorite').addEventListener('click', () => { if (!busy) dialog.close(); });
    dialog.addEventListener('close', () => { entry = null; revision += 1; });
    doc.addEventListener('app-locale-changed', () => {
      if (dialog.open) renderGroupOptions($('officialFavoriteGroup').value);
    });
    return true;
  }

  return Object.freeze({
    isFavorite: (target) => resourceFor(target) !== null,
    open,
    start,
  });
}
