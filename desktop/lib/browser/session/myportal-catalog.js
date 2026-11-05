'use strict';

const MAX_RESPONSE_BYTES = 512 * 1024;
const failure = code => sourceError(code, 'portal request could not complete');

function isPortalSignInResponse(response, portalUrl) {
  if (response.status < 200 || response.status >= 300 || !response.url) return false;
  try {
    const portal = new URL(portalUrl);
    const final = new URL(response.url);
    const knownOrigin = final.origin === portal.origin ||
      (portal.origin === 'https://myportal.hkust-gz.edu.cn' &&
        final.origin === 'https://sso.hkust-gz.edu.cn');
    return knownOrigin && final.protocol === 'https:' && !final.username && !final.password &&
      /^\/(?:account\/login|connect\/authorize)(?:\/|$)/iu.test(final.pathname);
  } catch { return false; }
}

// Electron Session.fetch does not reliably populate Response.url/redirected.
// A request-local redirect observer avoids replacing shared webRequest hooks.
// Only the existing Session supplies cookies; no credential material is exposed.
function portalSessionTransport(net, session, portalUrl) {
  if (!net) return session; // Injected portable/offline fetch implementation.
  if (typeof net.request !== 'function') throw new TypeError('portal request transport is unavailable');
  return { fetch(url, options) {
    return new Promise((resolve, reject) => {
      let currentUrl = new URL(url);
      const origin = new URL(portalUrl).origin;
      if (currentUrl.origin !== origin || currentUrl.protocol !== 'https:' ||
          currentUrl.username || currentUrl.password) {
        reject(failure('PORTAL_RESPONSE_INVALID')); return;
      }
      let request, settled = false, redirects = 0, bytes = 0;
      const chunks = [];
      const settle = (error, value) => {
        if (settled) return;
        settled = true; options.signal?.removeEventListener('abort', abort);
        chunks.length = 0;
        if (error) reject(error); else resolve(value);
      };
      const stop = code => { if (!settled) { settle(failure(code)); request?.abort(); } };
      const abort = () => stop('PORTAL_SOURCE_TIMEOUT');
      if (options.signal?.aborted) { abort(); return; }
      try {
        request = net.request({ url: currentUrl.href, method: 'GET', session,
          credentials: 'include', redirect: 'manual', cache: 'no-store' });
        request.setHeader('Accept', options.headers?.Accept || '*/*');
        options.signal?.addEventListener('abort', abort, { once: true });
        request.on('error', () => stop('PORTAL_REQUEST_FAILED'));
        // Writable close can precede IncomingMessage in Electron; the existing
        // request deadline, not that event, owns incomplete-response termination.
        request.on('login', (info, callback) => { callback(); stop(info.isProxy ? 'PORTAL_REQUEST_FAILED' : 'PORTAL_SESSION_EXPIRED'); });
        request.on('redirect', (_status, _method, target) => {
          if (settled) return;
          if (isPortalSignInResponse({ status: 200, url: target }, portalUrl)) {
            stop('PORTAL_SESSION_EXPIRED'); return;
          }
          try {
            const next = new URL(target);
            if (++redirects > 5 || next.origin !== origin || next.username || next.password) {
              stop('PORTAL_RESPONSE_INVALID'); return;
            }
            currentUrl = next; request.followRedirect();
          } catch { stop('PORTAL_RESPONSE_INVALID'); }
        });
        request.on('response', response => {
          if (settled) return;
          const status = response.statusCode;
          const headers = new Headers();
          for (const name of ['content-length', 'content-type']) {
            const value = response.headers[name];
            if (value) headers.set(name, Array.isArray(value) ? value[0] : value);
          }
          const result = text => ({ status, url: currentUrl.href, headers, text: async () => text });
          response.on('error', () => stop('PORTAL_REQUEST_FAILED'));
          response.on('aborted', () => stop('PORTAL_REQUEST_FAILED'));
          if (status === 401 || status === 403) {
            settle(null, result('')); request.abort(); return;
          }
          if (Number(headers.get('content-length')) > MAX_RESPONSE_BYTES) {
            stop('PORTAL_RESPONSE_INVALID'); return;
          }
          response.on('data', chunk => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES) { stop('PORTAL_RESPONSE_INVALID'); return; }
            chunks.push(Buffer.from(chunk));
          });
          response.on('end', () => {
            if (!settled) settle(null, result(Buffer.concat(chunks).toString('utf8')));
          });
        });
        request.end();
      } catch { stop('PORTAL_REQUEST_FAILED'); }
    });
  } };
}

const MAX_GROUPS = 12;
const MAX_ENTRIES = 64;
const CATALOG_STATES = new Set([
  'not-authenticated', 'loading', 'ready', 'empty', 'forbidden',
  'session-expired', 'source-unavailable', 'tunnel-required', 'failed',
]);
const SENSITIVE_QUERY = /^(?:access_token|auth|authorization|code|id_token|relaystate|samlresponse|session|state|ticket|token)$/iu;

function sourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundedText(value, name, { maxLength = 160, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw sourceError('PORTAL_RESPONSE_INVALID', `${name} is not text`);
  const result = value.trim();
  if ((!allowEmpty && !result) || result.length > maxLength || /[\u0000-\u001f\u007f<>]/u.test(result)) {
    throw sourceError('PORTAL_RESPONSE_INVALID', `${name} is unsafe`);
  }
  return result;
}

function safeUrl(value, portalUrl) {
  try {
    const url = new URL(String(value || ''), portalUrl);
    if (url.protocol !== 'https:') throw sourceError('PORTAL_RESPONSE_INVALID', 'portal catalog URL protocol is unsafe');
    if (!url.hostname || url.username || url.password) throw sourceError('PORTAL_RESPONSE_INVALID', 'portal catalog URL authority is unsafe');
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.href;
  } catch (error) {
    if (error?.code === 'PORTAL_RESPONSE_INVALID') throw error;
    throw sourceError('PORTAL_RESPONSE_INVALID', 'portal catalog URL is unsafe');
  }
}

function parsePayload(value) {
  const text = String(value || '').trim();
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw sourceError('PORTAL_RESPONSE_INVALID', 'portal catalog response is empty or oversized');
  }
  try {
    if (text.startsWith('{') || text.startsWith('[')) return JSON.parse(text);
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open <= 0 || close <= open ||
        !/^[A-Za-z_$][A-Za-z0-9_$.]{0,95}$/u.test(text.slice(0, open).trim())) {
      throw new Error('invalid JSONP');
    }
    return JSON.parse(text.slice(open + 1, close));
  } catch {
    throw sourceError('PORTAL_RESPONSE_INVALID', 'portal catalog response is invalid');
  }
}

async function readPortalResponseWithinDeadline(context, target, consumeResponse) {
  const controller = new AbortController();
  let timer;
  const timedOut = () => sourceError('PORTAL_SOURCE_TIMEOUT', 'portal source request timed out');
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      // Settle independently of transport cancellation: a late or non-cooperative
      // body must not keep a public source read and its single-flight slot alive.
      reject(timedOut());
      controller.abort();
    }, context.timeoutMs || 8_000);
    timer.unref?.();
  });
  const operation = (async () => {
    const response = await context.session.fetch(target.href, {
      method: 'GET', credentials: 'include', redirect: 'follow', cache: 'no-store',
      headers: { Accept: '*/*' }, signal: controller.signal,
    });
    if (controller.signal.aborted) throw timedOut();
    // fetch follows redirects: a successful HTTP status may now describe the
    // sign-in page, not the API. Never consume its authentication body, expose
    // its query, or infer MFA from arbitrary HTML / an unrelated response URL.
    if (isPortalSignInResponse(response, context.portalUrl)) {
      controller.abort();
      throw sourceError('PORTAL_SESSION_EXPIRED', 'portal sign-in is required');
    }
    const result = await consumeResponse(response);
    if (controller.signal.aborted) throw timedOut();
    return result;
  })();
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPayload(context, pathname, query, callback = null) {
  const target = new URL(pathname, context.portalUrl);
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, String(value));
  if (callback) target.searchParams.set('callback', callback);
  return readPortalResponseWithinDeadline(context, target, async response => {
    if (response.status === 401) throw sourceError('PORTAL_SESSION_EXPIRED', 'portal session expired');
    if (response.status === 403) throw sourceError('PORTAL_FORBIDDEN', 'portal catalog is forbidden');
    if (response.status < 200 || response.status >= 300) {
      throw sourceError('PORTAL_RESPONSE_INVALID', 'portal catalog returned an unsupported status');
    }
    const length = Number(response.headers?.get?.('content-length') || 0);
    if (length > MAX_RESPONSE_BYTES) throw sourceError('PORTAL_RESPONSE_INVALID', 'portal catalog is oversized');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw sourceError('PORTAL_RESPONSE_INVALID', 'portal catalog is oversized');
    }
    return parsePayload(text);
  });
}

function groupId(prefix, value) {
  const token = String(value ?? '').trim();
  if (!/^[0-9]{1,8}$/u.test(token)) {
    throw sourceError('PORTAL_RESPONSE_INVALID', 'portal catalog group id is invalid');
  }
  return `${prefix}-${token}`;
}

function appIdentity(value, prefix) {
  const number = Number(value?.appId ?? value?.id);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw sourceError('PORTAL_RESPONSE_INVALID', 'portal catalog app id is invalid');
  }
  return `${prefix}-${number}`;
}

function aliases(value) {
  return Object.freeze([...new Set([
    value?.appName, value?.name, value?.appType,
  ].filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => entry.trim().slice(0, 80)))].slice(0, 8));
}

function catalogEntry(value, prefix, groups, portalUrl) {
  const name = boundedText(value?.name || value?.appDetail || value?.appName,
    'portal catalog app name', { maxLength: 80 });
  const detail = typeof value?.appDetail === 'string' && value.appDetail.trim() !== name
    ? value.appDetail : value?.appType;
  const useCase = boundedText(detail || name,
    'portal catalog app detail', { maxLength: 160 });
  const audience = boundedText(value?.applyUserScope || 'myPortal',
    'portal catalog audience', { maxLength: 80 });
  return Object.freeze({
    id: appIdentity(value, prefix),
    name,
    url: safeUrl(value?.entranceUrl || value?.appUrl, portalUrl),
    route: 'auto',
    groups: Object.freeze([...new Set(groups)].slice(0, 8)),
    useCase,
    audience,
    aliases: aliases(value),
  });
}

function groupProjection(value, prefix, field = 'name') {
  return Object.freeze({
    id: groupId(prefix, value?.id),
    name: boundedText(value?.[field], 'portal catalog group name', { maxLength: 40 }),
  });
}

function normalizeGroups(value, name) {
  if (!Array.isArray(value) || value.length > MAX_GROUPS) {
    throw sourceError('PORTAL_RESPONSE_INVALID', `${name} group count is invalid`);
  }
  const groups = value.map((group) => Object.freeze({
    id: boundedText(group?.id, `${name} group id`, { maxLength: 40 }),
    name: boundedText(group?.name, `${name} group name`, { maxLength: 40 }),
  }));
  if (new Set(groups.map(({ id }) => id)).size !== groups.length) {
    throw sourceError('PORTAL_RESPONSE_INVALID', `${name} groups are duplicated`);
  }
  return Object.freeze(groups);
}

function normalizeEntries(value, groups, name) {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
    throw sourceError('PORTAL_RESPONSE_INVALID', `${name} entry count is invalid`);
  }
  const allowedGroups = new Set(groups.map(({ id }) => id));
  const entries = value.map((entry) => {
    if (!Array.isArray(entry?.groups) || entry.groups.length > 8 ||
        entry.groups.some((id) => !allowedGroups.has(id))) {
      throw sourceError('PORTAL_RESPONSE_INVALID', `${name} entry groups are invalid`);
    }
    return Object.freeze({
      id: boundedText(entry.id, `${name} id`, { maxLength: 40 }),
      name: boundedText(entry.name, `${name} name`, { maxLength: 80 }),
      url: safeUrl(entry.url, 'https://myportal.hkust-gz.edu.cn/'),
      route: entry.route === 'auto' ? 'auto' : 'auto',
      groups: Object.freeze([...entry.groups]),
      useCase: boundedText(entry.useCase, `${name} useCase`, { maxLength: 160 }),
      audience: boundedText(entry.audience, `${name} audience`, { maxLength: 80 }),
      aliases: Object.freeze(Array.isArray(entry.aliases)
        ? entry.aliases.slice(0, 8).map((alias) => boundedText(alias, `${name} alias`, { maxLength: 80 }))
        : []),
    });
  });
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    throw sourceError('PORTAL_RESPONSE_INVALID', `${name} entries are duplicated`);
  }
  return Object.freeze(entries);
}

function normalizePortalCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !CATALOG_STATES.has(value.state)) {
    throw sourceError('PORTAL_RESPONSE_INVALID', 'portal catalog state is invalid');
  }
  const applicationGroups = normalizeGroups(value.applicationGroups || [], 'application');
  const serviceGroups = normalizeGroups(value.serviceGroups || [], 'service');
  const applications = normalizeEntries(value.applications || [], applicationGroups, 'application');
  const serviceItems = normalizeEntries(value.serviceItems || [], serviceGroups, 'service');
  if (value.state === 'ready' && (!applications.length || !serviceItems.length)) {
    throw sourceError('PORTAL_RESPONSE_INVALID', 'ready portal catalog is incomplete');
  }
  if (value.state !== 'ready' && (applications.length || serviceItems.length ||
      applicationGroups.length || serviceGroups.length)) {
    throw sourceError('PORTAL_RESPONSE_INVALID', 'inactive portal catalog contains entries');
  }
  return Object.freeze({
    state: value.state,
    source: boundedText(value.source || 'none', 'portal catalog source', { maxLength: 80 }),
    fetchedAt: Number.isSafeInteger(value.fetchedAt) && value.fetchedAt > 0 ? value.fetchedAt : null,
    applicationGroups,
    applications,
    serviceGroups,
    serviceItems,
  });
}

function portalCatalogState(state, fetchedAt, source = 'myportal-catalog') {
  return normalizePortalCatalog({
    state, source, fetchedAt,
    applicationGroups: [], applications: [], serviceGroups: [], serviceItems: [],
  });
}

function projectCatalog(appPayload, serviceGroupPayload, servicePayload, context) {
  const categories = appPayload?.data;
  const serviceCategories = serviceGroupPayload?.data;
  const services = servicePayload?.data?.appList;
  if (!Array.isArray(categories) || !categories.length || categories.length > MAX_GROUPS + 1 ||
      !Array.isArray(serviceCategories) || serviceCategories.length > MAX_GROUPS ||
      !Array.isArray(services) || services.length > MAX_ENTRIES) {
    throw sourceError('PORTAL_RESPONSE_INVALID', 'portal catalog payload is incomplete');
  }
  const all = categories.find((category) => String(category?.id) === '0') || categories[0];
  if (!Array.isArray(all?.list) || !all.list.length || all.list.length > MAX_ENTRIES) {
    throw sourceError('PORTAL_RESPONSE_INVALID', 'portal application list is incomplete');
  }
  const appCategories = categories.filter((category) => category !== all);
  const applicationGroups = appCategories.map((category) => groupProjection(category, 'portal-app-group'));
  const applicationMembership = new Map(applicationGroups.map((group, index) => [
    group.id,
    new Set((appCategories[index].list || []).map((app) => appIdentity(app, 'portal-app'))),
  ]));
  const applications = all.list.map((app) => {
    const id = appIdentity(app, 'portal-app');
    const groups = [...applicationMembership]
      .filter(([, members]) => members.has(id)).map(([group]) => group);
    return catalogEntry(app, 'portal-app', groups, context.portalUrl);
  });
  const serviceGroups = serviceCategories.map((category) => (
    groupProjection(category, 'portal-service-group', 'typeName')
  ));
  const serviceGroupIds = new Set(serviceGroups.map(({ id }) => id));
  const serviceItems = services.map((service) => {
    const groups = String(service?.appTypeId || '').split(',')
      .map((id) => id.trim()).filter((id) => /^[0-9]{1,8}$/u.test(id))
      .map((id) => `portal-service-group-${id}`).filter((id) => serviceGroupIds.has(id));
    return catalogEntry(service, 'portal-service', groups, context.portalUrl);
  });
  return normalizePortalCatalog({
    state: 'ready', source: 'myportal-catalog', fetchedAt: context.checkedAt,
    applicationGroups, applications, serviceGroups, serviceItems,
  });
}

const hkustPortalCatalogSource = Object.freeze({
  async read(context) {
    const common = { _p: 'YXM9MiZ0PTEmcD0xJm09TiY_' };
    const [apps, serviceGroups, services] = await Promise.all([
      fetchPayload(context, '/sopplus/_web/customized/getMyFavoriteAppsByCategory.jsp', {
        ...common, parentCategoryId: 27, name: 'MyFavoriteApps_side', clientType: 2,
      }, 'hkustgzConnectApps'),
      fetchPayload(context, '/sopplus/_web/customized/getPortalCenterTermByStrategy.jsp', {
        ...common, parentCategoryId: 42, showCategoryType: 0,
      }),
      fetchPayload(context, '/sopplus/_web/customized/loadAllServiceApps.jsp', {
        ...common, parentCategoryId: 42, clientType: 2, categoryId: '',
      }),
    ]);
    return projectCatalog(apps, serviceGroups, services, context);
  },
});

module.exports = {
  portalSessionTransport,
  hkustPortalCatalogSource,
  normalizePortalCatalog,
  portalCatalogState,
  projectCatalog,
  readPortalResponseWithinDeadline,
};
