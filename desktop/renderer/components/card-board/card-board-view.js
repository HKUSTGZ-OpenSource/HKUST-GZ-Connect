(function initializeCardBoardView(root, factory) {
  const api = factory(
    typeof module !== 'undefined' && module.exports ? require('./card-board-icons') : root.cardBoardIcons,
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.cardBoardView = api;
})(typeof self !== 'undefined' ? self : globalThis, function cardBoardViewFactory(icons) {
  'use strict';

  if (!icons?.categoryIcon || !icons?.siteIcon) {
    throw new TypeError('card board presentation dependencies are required');
  }

  // §10: every card in a slot shares one geometry; back layers are complete
  // cards peeking 36px from the top. A deck never shows more than three cards.
  const MAX_VISIBLE_DEPTH = 3;
  const PREVIEW_BY_SIZE = Object.freeze({ small: 4, medium: 6, large: 8 });

  function label(strings, key, fallback) {
    return strings?.[key] || fallback;
  }

  function format(template, values) {
    return String(template || '').replace(/\{(\w+)\}/gu, (match, key) => (
      Object.hasOwn(values, key) ? String(values[key]) : match
    ));
  }

  function cardTone(kind) {
    return kind === 'system-widget' ? 'gold' : 'brand';
  }

  function previewLimitFor(size) {
    return PREVIEW_BY_SIZE[size] || PREVIEW_BY_SIZE.small;
  }

  // Display order puts the front card last (highest layer, largest offset).
  function displayOrder(unit, frontPlacementId) {
    const placements = unit.placements;
    const front = frontPlacementId
      && placements.some(({ placementId }) => placementId === frontPlacementId)
      ? frontPlacementId
      : unit.deck?.activePlacementId
        && placements.some(({ placementId }) => placementId === unit.deck.activePlacementId)
          ? unit.deck.activePlacementId
          : placements.at(-1)?.placementId;
    return {
      front,
      order: [
        ...placements.filter(({ placementId }) => placementId !== front),
        ...placements.filter(({ placementId }) => placementId === front),
      ],
    };
  }

  // Layer offset for display index i in a deck of n cards, capped at the
  // three visible layers (front + two peeping backs). Deeper legacy cards
  // share the rearmost offset and stay reachable via the keyboard.
  function layerOffset(index, count) {
    const depth = Math.min(count, MAX_VISIBLE_DEPTH);
    return Math.max(0, (depth - 1) - (count - 1 - index)) * 36;
  }

  function renderSiteRows(items, options) {
    const { escapeHtml: esc, translate } = options;
    const previewLimit = Math.max(1, Number(options.previewLimit) || 4);
    const visible = items.slice(0, previewLimit);
    if (!visible.length) {
      return `<p class="cb-empty">${esc(label(options.strings, 'emptyCategory', '此分类暂无网站'))}`
        + `<button class="cb-empty-action" type="button" data-card-action="add-site">`
        + `${esc(label(options.strings, 'addSite', '添加网站'))}</button></p>`;
    }
    return visible.map((resource) => {
      const favorite = resource.favorite === true;
      const favoriteLabel = translate(favorite ? 'resources.unfavorite' : 'resources.favorite');
      return `<div class="cb-site" data-card-resource-id="${esc(resource.id)}" data-campus-id="${esc(resource.id)}">`
        + `<button class="cb-site-open" type="button" data-resource-action="open" title="${esc(resource.name)}">`
        + `<span class="cb-site-icon">${icons.siteIcon(resource)}</span>`
        + `<span class="cb-site-name">${esc(resource.name)}</span></button>`
        + `<button class="resource-favorite${favorite ? ' active' : ''}" type="button" data-resource-action="favorite" title="${esc(favoriteLabel)}" aria-label="${esc(favoriteLabel)}" aria-pressed="${favorite}">${favorite ? '★' : '☆'}</button></div>`;
    }).join('');
  }

  function renderCard(placement, card, context, layerIndex, layerCount) {
    const esc = context.escapeHtml;
    const front = layerIndex === layerCount - 1;
    const count = Array.isArray(card?.items) ? card.items.length : 0;
    const kind = placement.card.kind;
    const cardName = card?.name || placement.card.id;
    const pinned = context.pinnedCardKeys?.has(`${kind}:${placement.card.id}`) === true;
    const canPin = placement.boardId !== 'connect' && kind !== 'system-widget' && !pinned;
    const removeLabel = placement.boardId === 'connect'
      ? label(context.strings, 'removeFromConnect', '从连接页移除')
      : label(context.strings, 'hideCard', '从当前页面隐藏');
    const nextSize = placement.size === 'small' ? 'medium' : placement.size === 'medium' ? 'large' : 'small';
    const ariaTemplate = front
      ? label(context.strings, 'cardAriaFront',
        '{name}，{count} 个网站，第 {index} 张，共 {total} 张，当前在正面')
      : label(context.strings, 'cardAria', '{name}，{count} 个网站，第 {index} 张，共 {total} 张');
    const ariaLabel = format(ariaTemplate, {
      name: cardName, count, index: layerIndex + 1, total: layerCount,
    });
    const editControls = context.editing
      ? `<div class="cb-card-edit-controls" data-card-edit-controls>`
        + `<button class="cb-icon-action" type="button" data-card-edit-action="resize" data-card-next-size="${nextSize}" aria-label="${esc(label(context.strings, 'resizeCard', '调整卡片尺寸'))}" title="${esc(label(context.strings, 'resizeCard', '调整卡片尺寸'))}">↔</button>`
        + (context.renameCards && kind === 'user-collection'
          ? `<button class="cb-icon-action" type="button" data-card-edit-action="rename" aria-label="${esc(label(context.strings, 'renameCard', '重命名分类'))}" title="${esc(label(context.strings, 'renameCard', '重命名分类'))}">✎</button>`
          : '')
        + (canPin ? `<button class="cb-icon-action" type="button" data-card-edit-action="pin" aria-label="${esc(label(context.strings, 'pinToConnect', '固定到连接页'))}" title="${esc(label(context.strings, 'pinToConnect', '固定到连接页'))}">⌂</button>` : '')
        + `<button class="cb-icon-action" type="button" data-card-edit-action="remove" aria-label="${esc(removeLabel)}" title="${esc(removeLabel)}">×</button></div>`
      : '';
    const dragLabel = esc(label(context.strings, 'dragCard', '拖动卡片'));
    const previewLimit = previewLimitFor(context.deckSize || placement.size);
    const foot = count > previewLimit
      ? `<button class="cb-show-all" type="button" data-card-action="show-all" aria-label="${esc(format(label(context.strings, 'showAllAria', '查看 {name} 全部网站'), { name: cardName }))}">${esc(format(label(context.strings, 'showAll', '查看全部（{count}）'), { count }))}</button>`
      : '';
    const expand = !context.editing && count > 0
      ? `<button class="cb-card-more" type="button" data-card-action="expand" aria-haspopup="dialog" aria-label="${esc(format(label(context.strings, 'showAllAria', '查看 {name} 全部网站'), { name: cardName }))}">${esc(context.translate('workspace.more'))}</button>` : '';
    return `<article class="cb-card${front ? ' is-front' : ' is-back'}" role="group"`
      + ` data-card-placement-id="${esc(placement.placementId)}" data-card-ref-kind="${esc(kind)}"`
      + ` data-card-ref-id="${esc(placement.card.id)}" data-card-size="${esc(placement.size)}"`
      + ` data-card-tone="${cardTone(kind)}" data-card-front="${front}" data-dragging="false"`
      + ` data-layer="${layerIndex}"`
      + (context.editing ? ` draggable="true" tabindex="0" data-card-drag-handle aria-label="${dragLabel}"` : '')
      + `><header class="cb-card-head${context.editing ? ' is-draggable' : ''}">`
      + `<button class="cb-card-tab" type="button" role="tab" data-card-action="draw"`
      + ` aria-selected="${front}" aria-label="${esc(ariaLabel)}">`
      + `<span class="cb-category-icon">${icons.categoryIcon(kind, placement.card.id)}</span>`
      + `<span class="cb-card-title">${esc(cardName)}</span>`
      + `<span class="cb-card-count" aria-hidden="true">${count}</span>`
      + `</button>${expand}${editControls}</header>`
      + `<div class="cb-card-body"${front ? '' : ' inert'}>`
      + `<div class="cb-site-list">${renderSiteRows(card?.items || [], {
        ...context,
        previewLimit,
      })}</div></div>`
      + `<div class="cb-card-foot"${front ? '' : ' inert'}>${foot}</div>`
      + (context.editing ? '<div class="cb-drop-zones" aria-hidden="true"><span data-card-drop="before"></span><span data-card-drop="stack"></span><span data-card-drop="after"></span></div>' : '')
      + '</article>';
  }

  function renderDeck(unit, cardsByKey, context) {
    const deckId = unit.deck?.deckId || unit.unitId;
    const { order } = displayOrder(unit, context.frontByDeck[deckId]);
    // The slot keeps one fixed geometry no matter which card is in front:
    // the widest member decides the deck tier, so drawing never reflows peers.
    const sizeRank = { small: 0, medium: 1, large: 2 };
    const size = order.reduce((widest, placement) => (
      (sizeRank[placement.size] || 0) > (sizeRank[widest] || 0) ? placement.size : widest
    ), order[0]?.size || 'small');
    const cards = order.map((placement, index) => renderCard(
      placement,
      cardsByKey.get(`${placement.card.kind}:${placement.card.id}`),
      { ...context, deckSize: size },
      index,
      order.length,
    )).join('');
    return `<section class="cb-deck" role="tablist"`
      + ` aria-label="${context.escapeHtml(label(context.strings, 'deckAria', '分类牌堆'))}"`
      + ` data-card-deck-id="${context.escapeHtml(deckId)}" data-card-size="${context.escapeHtml(size)}"`
      + ` data-stack-count="${order.length}">${cards}</section>`;
  }

  function renderBoard({ boardId, units, cardsByKey, frontByDeck = {}, editing = false,
    escapeHtml, translate, strings = {}, columns = 1, pinnedCardKeys = new Set(), renameCards = false } = {}) {
    const context = {
      boardId, frontByDeck, editing, escapeHtml, translate, strings, pinnedCardKeys, renameCards,
    };
    const content = units.map((unit) => renderDeck(unit, cardsByKey, context)).join('');
    const empty = `<div class="cb-board-empty"><strong>${escapeHtml(label(strings, 'emptyBoard', '这里还没有卡片'))}</strong>`
      + `<span>${escapeHtml(label(strings, 'emptyBoardHint', '可在整理模式中恢复或固定卡片。'))}</span></div>`;
    return `<div class="cb-board-grid" data-card-board data-board-id="${escapeHtml(boardId)}"`
      + ` aria-label="${escapeHtml(label(strings, 'boardAria', '分类卡片'))}"`
      + ` data-editing="${editing}" data-board-columns="${columns}">${content || empty}</div>`;
  }

  return Object.freeze({
    MAX_VISIBLE_DEPTH,
    PREVIEW_BY_SIZE,
    cardTone,
    categoryIcon: icons.categoryIcon,
    displayOrder,
    layerOffset,
    previewLimitFor,
    renderBoard,
    renderSiteRows,
    siteIcon: icons.siteIcon,
  });
});
