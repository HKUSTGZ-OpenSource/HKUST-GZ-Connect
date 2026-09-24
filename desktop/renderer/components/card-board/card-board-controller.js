(function initializeCardBoardController(root, factory) {
  const api = factory(
    typeof module !== 'undefined' && module.exports ? require('./card-board-model') : root.cardBoardModel,
    typeof module !== 'undefined' && module.exports ? require('./card-board-view') : root.cardBoardView,
    typeof module !== 'undefined' && module.exports ? require('./card-board-drag') : root.cardBoardDrag,
    typeof module !== 'undefined' && module.exports ? require('./card-board-adapter') : root.cardBoardAdapter,
    typeof module !== 'undefined' && module.exports ? require('./card-board-motion') : root.cardBoardMotion,
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.cardBoardController = api;
})(typeof self !== 'undefined' ? self : globalThis, function cardBoardControllerFactory(model, view, drag, adapterTools, motion) {
  'use strict';

  if (!model || !view || !drag || !adapterTools || !motion) throw new TypeError('card board dependencies are required');
  const { createMemoryAdapter, localeStrings, normalizeAdapter, resultDocument } = adapterTools;

  // §10.2: the slot height is fixed per tier; only the width tier reacts to
  // the measured slot width. Card height = 56 head + rows + 40 foot.
  const NARROW_SLOT_WIDTH = 400;
  const CARD_HEIGHT_WIDE = 236;
  const CARD_HEIGHT_NARROW = 280;
  const CARD_HEIGHT_LARGE = 280;

  function cardHeight(size, narrow) {
    if (narrow) return CARD_HEIGHT_NARROW;
    return size === 'large' ? CARD_HEIGHT_LARGE : CARD_HEIGHT_WIDE;
  }

  function unitIndexForPlacement(document, placementId) {
    const placement = document.placements.find((candidate) => candidate.placementId === placementId);
    if (!placement) return -1;
    const unitId = placement.deckId || placement.placementId;
    return model.boardUnits(document, placement.boardId).findIndex((unit) => unit.unitId === unitId);
  }

  function dropOperationsForDocument(document, { sourcePlacementId, targetPlacementId, position }) {
    const source = document.placements.find(({ placementId }) => placementId === sourcePlacementId);
    const target = document.placements.find(({ placementId }) => placementId === targetPlacementId);
    if (!source || !target || source.boardId !== target.boardId || source.placementId === target.placementId) return [];
    const targetUnitIndex = unitIndexForPlacement(document, targetPlacementId);
    const targetDeck = target.deckId
      ? document.decks.find(({ deckId }) => deckId === target.deckId)
      : null;
    // §10: a deck never holds more than three cards; stacking onto a full
    // deck degrades to an ordinary after-insertion.
    const stackable = position === 'stack'
      && (!targetDeck || targetDeck.placementIds.length < model.MAX_DECK_DEPTH);
    if (position === 'stack' && stackable) {
      if (targetDeck) {
        const index = Math.max(0, targetDeck.placementIds.indexOf(targetPlacementId)) + 1;
        return [{ type: 'move-into-deck', placementId: sourcePlacementId, deckId: targetDeck.deckId, index }];
      }
      const create = {
        type: 'create-deck',
        boardId: target.boardId,
        placementIds: [targetPlacementId, sourcePlacementId],
        activePlacementId: sourcePlacementId,
        index: Math.max(0, targetUnitIndex),
      };
      return source.deckId
        ? [{ type: 'remove-from-deck', placementId: sourcePlacementId, index: Math.max(0, targetUnitIndex) }, create]
        : [create];
    }
    const effectivePosition = position === 'stack' ? 'after' : position;
    const sourceUnitIndex = unitIndexForPlacement(document, sourcePlacementId);
    const targetIndexAfterDetach = targetUnitIndex - (
      source.deckId === null && sourceUnitIndex >= 0 && sourceUnitIndex < targetUnitIndex ? 1 : 0
    );
    const index = Math.max(0, targetIndexAfterDetach + (effectivePosition === 'after' ? 1 : 0));
    return source.deckId
      ? [{ type: 'remove-from-deck', placementId: sourcePlacementId, index }]
      : [{ type: 'move-placement', placementId: sourcePlacementId, boardId: source.boardId, index }];
  }

  function create(options = {}) {
    const {
      container,
      boardId,
      escapeHtml,
      translate,
      manageButton = null,
      toolbar = null,
      adapter: requestedAdapter = null,
      autoPlace = boardId !== 'connect',
      autoStack = false,
      pager = null,
      pageSize = 0,
      pagerByCard = false,
      switchStyle = 'draw',
      renameCards = false,
      onDocument = null,
      onEditingChange = null,
      onAddSite = null,
      onRenameCard = null,
      announce = null,
      toast = null,
      externalDropTargets = [],
    } = options;
    if (!container || !model.BOARD_IDS.includes(boardId) || typeof escapeHtml !== 'function' ||
        typeof translate !== 'function') {
      throw new TypeError('card board controller dependencies are incomplete');
    }

    let categories = [];
    let cardsByKey = new Map();
    let documentState = model.defaultDocument();
    let draftDocument = null;
    let baseDocument = null;
    let operations = [];
    let history = [];
    let historyIndex = -1;
    let editing = false;
    let resetRequested = false;
    let frontByDeck = {};
    // Service-style personal cards follow the official desk's viewport breakpoint.
    // Only the projection changes: resizing never rewrites a saved deck or ordering.
    const serviceLayout = autoStack && switchStyle === 'service';
    const responsiveModel = serviceLayout ? { columnsForWidth: () =>
      container.ownerDocument.defaultView.innerWidth >= 980 ? 2 : 1 } : model;
    let columns = responsiveModel.columnsForWidth(container.getBoundingClientRect().width);
    let page = 0;
    let activePagerPlacementId = null;
    let destroyed = false;
    let dragFeature = null;
    let responsiveFeature = null;
    let overlay = null;
    const hasExternalAdapter = [requestedAdapter?.get, requestedAdapter?.commit, requestedAdapter?.reset]
      .every((method) => typeof method === 'function');
    const adapter = normalizeAdapter(requestedAdapter, documentState);

    const liveDocument = () => editing ? draftDocument : documentState;
    const strings = () => localeStrings(container.ownerDocument);

    function announceMessage(message) {
      if (typeof announce === 'function') announce(message);
      const live = container.ownerDocument.getElementById('cardBoardLiveRegion');
      if (live) live.textContent = message || '';
    }

    function reconcile(document) {
      const reconciled = autoPlace
        ? model.reconcileBoard(document, boardId, categories.map(({ kind, id }) => ({ kind, id })))
        : model.repairDocument(document);
      return autoStack ? model.autoStackBoard(reconciled, boardId) : reconciled;
    }

    function visibleUnits() {
      const current = reconcile(liveDocument());
      const units = model.boardUnits(current, boardId).map((unit) => ({
        ...unit,
        placements: unit.placements.filter((placement) => cardsByKey.has(model.cardKey(placement.card))),
      })).filter(({ placements }) => placements.length);
      return serviceLayout && columns > 1 && !editing ? units.flatMap(unit =>
        unit.deck?.deckId.startsWith(`auto_${boardId}_`) ? unit.placements.map(placement => ({
          unitId: placement.placementId, kind: 'placement', deck: null, placements: [placement],
        })) : [unit]) : units;
    }

    // Positions every card inside its fixed slot. This is the only place that
    // writes geometry, and it never runs during a draw animation.
    function layoutBoard() {
      for (const slot of container.querySelectorAll('.cb-deck')) {
        const cards = [...slot.querySelectorAll(':scope > .cb-card')];
        if (!cards.length) continue;
        const count = cards.length;
        const narrow = slot.clientWidth > 0 && slot.clientWidth < NARROW_SLOT_WIDTH;
        slot.classList.toggle('cb-narrow', narrow);
        const height = cardHeight(slot.dataset.cardSize, narrow);
        const frontOffset = (Math.min(count, view.MAX_VISIBLE_DEPTH) - 1) * motion.LAYER_OFFSET_PX;
        slot.style.height = `${height + frontOffset}px`;
        cards.forEach((card, index) => {
          card.style.top = `${view.layerOffset(index, count)}px`;
          card.style.zIndex = String(index + 1);
          card.style.height = `${height}px`;
        });
      }
    }

    function renderToolbar() {
      if (!toolbar) return;
      toolbar.hidden = !editing;
      if (!editing) {
        toolbar.replaceChildren();
        return;
      }
      const labels = strings();
      toolbar.innerHTML = `<span class="cb-edit-hint">${escapeHtml(labels.editHint)}</span>`
        + `<button type="button" data-board-action="undo"${historyIndex <= 0 ? ' disabled' : ''}>${escapeHtml(labels.undo)}</button>`
        + `<button type="button" data-board-action="redo"${historyIndex >= history.length - 1 ? ' disabled' : ''}>${escapeHtml(labels.redo)}</button>`
        + `<button type="button" data-board-action="reset">${escapeHtml(labels.reset)}</button>`
        + `<span class="cb-toolbar-spacer"></span><button type="button" data-board-action="cancel">${escapeHtml(labels.cancel)}</button>`
        + `<button class="cb-toolbar-primary" type="button" data-board-action="done">${escapeHtml(labels.done)}</button>`;
    }

    function renderPager(units) {
      if (!pager) return;
      if (pagerByCard && !(serviceLayout && columns > 1 && !editing)) {
        const targets = units.flatMap((unit, unitIndex) => unit.placements.map((placement) => ({
          placement,
          unit,
          unitIndex,
        })));
        const available = new Set(targets.map(({ placement }) => placement.placementId));
        if (!available.has(activePagerPlacementId)) {
          activePagerPlacementId = targets[0]?.unit.deck?.activePlacementId ||
            targets[0]?.placement.placementId || null;
        }
        pager.hidden = targets.length <= 1;
        pager.replaceChildren(...targets.map(({ placement }, index) => {
          const button = container.ownerDocument.createElement('button');
          button.type = 'button';
          button.className = 'portal-page';
          button.dataset.cardPagePlacement = placement.placementId;
          button.setAttribute('aria-label', translate('workspace.cardPage', {
            name: cardsByKey.get(model.cardKey(placement.card))?.name || placement.card.id,
            page: index + 1,
            count: targets.length,
          }));
          if (placement.placementId === activePagerPlacementId) {
            button.setAttribute('aria-current', 'page');
          }
          return button;
        }));
        return;
      }
      const total = units.length;
      const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : total;
      const count = size > 0 ? Math.ceil(total / size) : 0;
      page = Math.max(0, Math.min(page, Math.max(0, count - 1)));
      pager.hidden = count <= 1;
      pager.replaceChildren(...Array.from({ length: count }, (_, index) => {
        const button = container.ownerDocument.createElement('button');
        button.type = 'button';
        button.className = 'portal-page';
        button.dataset.cardPageIndex = String(index);
        button.setAttribute('aria-label', translate('workspace.page', {
          page: index + 1, count,
        }));
        if (index === page) button.setAttribute('aria-current', 'page');
        return button;
      }));
    }

    function render({ preserveFocus = true, animate = false } = {}) {
      if (destroyed) return;
      const previousRects = animate ? motion.placementRects(container) : null;
      const focusedPlacementId = preserveFocus
        ? container.ownerDocument.activeElement?.closest?.('[data-card-placement-id]')?.dataset.cardPlacementId : null;
      const current = reconcile(liveDocument());
      const allUnits = visibleUnits();
      const boundedPageSize = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 0;
      if (boundedPageSize) {
        page = Math.min(page, Math.max(0, Math.ceil(allUnits.length / boundedPageSize) - 1));
      }
      const units = boundedPageSize
        ? allUnits.slice(page * boundedPageSize, (page + 1) * boundedPageSize)
        : allUnits;
      const markup = view.renderBoard({
        boardId,
        units,
        cardsByKey,
        frontByDeck,
        editing,
        escapeHtml,
        translate,
        strings: strings(),
        columns,
        pinnedCardKeys: new Set(current.placements
          .filter((placement) => placement.boardId === 'connect' && !placement.hidden)
          .map((placement) => model.cardKey(placement.card))),
        renameCards,
      });
      if (overlay?.open && overlay.parentNode === container) {
        // Keep the modal connected to the top layer while replacing only the card projection.
        // Detaching/reinserting the dialog would lose modal state and keyboard focus.
        const template = container.ownerDocument.createElement('template');
        template.innerHTML = markup;
        for (const child of [...container.childNodes]) {
          if (child !== overlay) child.remove();
        }
        container.insertBefore(template.content, overlay);
      } else {
        closeOverlay();
        container.innerHTML = markup;
      }
      container.style.setProperty('--cb-columns', String(columns));
      renderPager(allUnits);
      layoutBoard();
      renderToolbar();
      if (manageButton) {
        manageButton.textContent = editing ? strings().done : strings().edit;
        manageButton.setAttribute('aria-pressed', String(editing));
      }
      if (focusedPlacementId) {
        const focusedCard = [...container.querySelectorAll('[data-card-placement-id]')]
          .find((card) => card.dataset.cardPlacementId === focusedPlacementId);
        const focusTarget = editing ? focusedCard : focusedCard?.querySelector('[data-card-action="draw"]');
        focusTarget?.focus({ preventScroll: true });
      }
      motion.animateFrom(container, previousRects);
    }

    function cardForPlacement(placementId) {
      const placement = liveDocument().placements.find((candidate) => candidate.placementId === placementId);
      return placement ? cardsByKey.get(model.cardKey(placement.card)) : null;
    }

    // §11: draw a back card to the front. The slot never moves; z-order swaps
    // on the first frame; only transform/opacity animate.
    function drawPlacement(slot, placementId, { focus = true } = {}) {
      if (editing || slot.classList.contains('cb-drawing')) return false;
      const cards = [...slot.querySelectorAll(':scope > .cb-card')];
      const count = cards.length;
      const index = cards.findIndex((card) => card.dataset.cardPlacementId === placementId);
      if (index < 0 || index === count - 1) return false;
      const deckId = slot.dataset.cardDeckId;
      const startedAt = container.ownerDocument.defaultView?.performance?.now?.() ?? 0;
      if (switchStyle === 'service') {
        frontByDeck = { ...frontByDeck, [deckId]: placementId };
        activePagerPlacementId = placementId;
        render({ preserveFocus: false });
        const nextSlot = [...container.querySelectorAll('[data-card-deck-id]')]
          .find(element => element.dataset.cardDeckId === deckId);
        nextSlot.classList.add('cb-drawing');
        const front = nextSlot.querySelector('.is-front');
        Promise.resolve(motion.animateSwitch(nextSlot, { front, back: nextSlot.querySelector('.is-back') })).finally(() => {
          nextSlot.classList.remove('cb-drawing');
          if (destroyed || !nextSlot.isConnected) return;
          if (focus) front.querySelector('[data-card-action="draw"]')?.focus({ preventScroll: true });
          container.dispatchEvent(new CustomEvent('card-board-drawn', { bubbles: true,
            detail: { deckId, placementId, duration: (container.ownerDocument.defaultView?.performance?.now?.() ?? 0) - startedAt } }));
          announceMessage(strings().drawnToFront.replace('{name}', cardForPlacement(placementId)?.name || placementId));
        });
        return true;
      }
      slot.classList.add('cb-drawing');

      const nextOrderIds = [...cards.filter((card) => card.dataset.cardPlacementId !== placementId)
        .map((card) => card.dataset.cardPlacementId), placementId];
      const deltaOf = new Map(cards.map((card, oldIndex) => {
        const newIndex = nextOrderIds.indexOf(card.dataset.cardPlacementId);
        return [card.dataset.cardPlacementId, view.layerOffset(newIndex, count) - view.layerOffset(oldIndex, count)];
      }));

      // First frame: z-order, role state and inert flags already describe the
      // outcome; the visual motion below only expresses it.
      cards.forEach((card) => {
        const newIndex = nextOrderIds.indexOf(card.dataset.cardPlacementId);
        const front = newIndex === count - 1;
        card.style.zIndex = String(newIndex + 1);
        card.classList.toggle('is-front', front);
        card.classList.toggle('is-back', !front);
        card.dataset.layer = String(newIndex);
        const tab = card.querySelector('[data-card-action="draw"]');
        tab?.setAttribute('aria-selected', String(front));
        card.querySelector('.cb-card-body')?.toggleAttribute('inert', !front);
        card.querySelector('.cb-card-foot')?.toggleAttribute('inert', !front);
      });
      frontByDeck = { ...frontByDeck, [deckId]: placementId };
      activePagerPlacementId = placementId;

      const target = cards[index];
      const oldFront = cards[count - 1];
      const finish = () => {
        slot.classList.remove('cb-drawing');
        render({ preserveFocus: false });
        if (focus) {
          const frontCard = [...container.querySelectorAll(`[data-card-deck-id="${CSS.escape(deckId)}"] > .cb-card`)]
            .find((card) => card.dataset.cardPlacementId === placementId);
          frontCard?.querySelector('[data-card-action="draw"]')?.focus({ preventScroll: true });
        }
        const finishedAt = container.ownerDocument.defaultView?.performance?.now?.() ?? 0;
        container.dispatchEvent(new CustomEvent('card-board-drawn', {
          bubbles: true,
          detail: { deckId, placementId, duration: finishedAt - startedAt },
        }));
        const card = cardForPlacement(placementId);
        if (card) {
          announceMessage(strings().drawnToFront.replace('{name}', card.name || placementId));
        }
      };
      if (motion.isReducedMotion(container)) {
        // Reduced Motion: the swap lands immediately, then a 100ms fade-in.
        finish();
        const frontCard = [...container.querySelectorAll('[data-card-placement-id]')]
          .find((card) => card.dataset.cardPlacementId === placementId);
        frontCard?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 100, fill: 'backwards' });
        return true;
      }
      const movers = cards
        .filter((card) => card !== target && card !== oldFront && deltaOf.get(card.dataset.cardPlacementId) !== 0);
      Promise.resolve(motion.animateDraw(container, {
        target,
        oldFront,
        between: movers,
        deltaPx: deltaOf.get(placementId),
      })).then(finish, finish);
      return true;
    }

    function closeOverlay() {
      if (overlay) {
        if (overlay.open) overlay.close();
        overlay.remove();
        overlay = null;
      }
    }

    function openOverlay(placementId) {
      const card = cardForPlacement(placementId);
      if (!card) return;
      closeOverlay();
      const labels = strings();
      const dialog = container.ownerDocument.createElement('dialog');
      dialog.className = `cb-overlay${switchStyle === 'service' ? ' cb-service-overlay' : ''}`;
      dialog.setAttribute('aria-label', card.name || placementId);
      dialog.innerHTML = `<div class="cb-overlay-head"><h3 class="cb-overlay-title">${escapeHtml(card.name || placementId)}</h3>`
        + `<button class="cb-overlay-close" type="button" aria-label="${escapeHtml(labels.closeOverlay)}">×</button></div>`
        + `<div class="cb-overlay-body"><div class="cb-site-list">${view.renderSiteRows(card.items || [], {
          escapeHtml, translate, strings: labels, previewLimit: (card.items || []).length || 1,
        })}</div></div>`;
      dialog.querySelector('.cb-overlay-close').addEventListener('click', () => closeOverlay());
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) closeOverlay();
      });
      container.appendChild(dialog);
      overlay = dialog;
      dialog.showModal();
      if (switchStyle === 'service') void motion.animateSwitch(dialog, { front: dialog });
      dialog.querySelector('.cb-overlay-close').focus({ preventScroll: true });
    }

    function pushDraft(nextDocument, nextOperations, message = strings().draftChanged) {
      if (!editing) return;
      history = history.slice(0, historyIndex + 1);
      history.push({ document: model.cloneDocument(nextDocument), operations: [...nextOperations] });
      historyIndex = history.length - 1;
      draftDocument = history[historyIndex].document;
      operations = history[historyIndex].operations;
      resetRequested = false;
      render();
      announceMessage(message);
    }

    function applyOperations(nextOperations) {
      const bounded = (Array.isArray(nextOperations) ? nextOperations : [nextOperations]).filter(Boolean);
      if (!bounded.length) return;
      const nextDocument = model.applyDraftOperations(draftDocument, bounded);
      pushDraft(nextDocument, [...operations, ...bounded]);
    }

    function enterEdit() {
      if (editing) return;
      closeOverlay();
      editing = true;
      baseDocument = reconcile(documentState);
      draftDocument = model.cloneDocument(baseDocument);
      operations = [];
      history = [{ document: model.cloneDocument(draftDocument), operations: [] }];
      historyIndex = 0;
      resetRequested = false;
      onEditingChange?.(true);
      render({ preserveFocus: false });
      container.querySelector('[data-card-drag-handle]')?.focus();
    }

    function cancelEdit() {
      if (!editing) return;
      editing = false;
      draftDocument = null;
      baseDocument = null;
      history = [];
      historyIndex = -1;
      operations = [];
      resetRequested = false;
      dragFeature?.cancel();
      onEditingChange?.(false);
      render({ preserveFocus: false });
      manageButton?.focus({ preventScroll: true });
    }

    async function finishEdit() {
      if (!editing) return true;
      const labels = strings();
      if (!operations.length && !resetRequested) {
        editing = false;
        draftDocument = null;
        baseDocument = null;
        history = [];
        historyIndex = -1;
        onEditingChange?.(false);
        render({ preserveFocus: false });
        manageButton?.focus({ preventScroll: true });
        return true;
      }
      manageButton && (manageButton.disabled = true);
      toolbar?.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      try {
        const result = hasExternalAdapter
          ? (resetRequested
            ? await adapter.reset({ baseRevision: baseDocument.revision })
            : await adapter.commit({ baseRevision: baseDocument.revision, operations: [...operations] }))
          : null;
        const committed = resultDocument(result) || {
          ...model.cloneDocument(draftDocument),
          revision: baseDocument.revision + (operations.length || resetRequested ? 1 : 0),
        };
        documentState = reconcile(committed);
        editing = false;
        draftDocument = null;
        baseDocument = null;
        operations = [];
        history = [];
        historyIndex = -1;
        resetRequested = false;
        onDocument?.(model.cloneDocument(documentState));
        onEditingChange?.(false);
        render({ preserveFocus: false });
        announceMessage(labels.saved);
        toast?.(labels.saved, 'success');
        manageButton?.focus({ preventScroll: true });
        return true;
      } catch (error) {
        const message = error?.code === 'CARD_BOARD_REVISION_CONFLICT' ? labels.stale : labels.saveFailed;
        toast?.(message, 'error');
        announceMessage(message);
        return false;
      } finally {
        if (manageButton) manageButton.disabled = false;
        renderToolbar();
      }
    }

    function toggleEdit() {
      if (editing) return finishEdit();
      enterEdit();
      return Promise.resolve(true);
    }

    function dropOperations({ sourcePlacementId, targetPlacementId, position }) {
      return dropOperationsForDocument(draftDocument, {
        sourcePlacementId, targetPlacementId, position,
      });
    }

    function onDrop(payload) {
      applyOperations(dropOperations(payload));
    }

    function onKeyboardMove({ placementId, direction }) {
      if (!editing) return;
      const placement = draftDocument.placements.find((candidate) => candidate.placementId === placementId);
      if (!placement) return;
      const currentIndex = unitIndexForPlacement(draftDocument, placementId);
      const delta = direction === 'ArrowLeft' || direction === 'ArrowUp' ? -1 : 1;
      const index = Math.max(0, currentIndex + delta);
      const nextOperation = placement.deckId
        ? { type: 'remove-from-deck', placementId, index }
        : { type: 'move-placement', placementId, boardId: placement.boardId, index };
      applyOperations(nextOperation);
      announceMessage(`已移动到第 ${index + 1} 位`);
    }

    function onExternalDrop({ sourcePlacementId, boardId: targetBoardId }) {
      if (!editing || targetBoardId !== 'connect' || boardId === 'connect') return;
      applyOperations({
        type: 'pin-to-board',
        sourcePlacementId,
        boardId: 'connect',
        index: model.boardUnits(draftDocument, 'connect').length,
        size: 'medium',
      });
      announceMessage(strings().pinToConnect);
    }

    function revealPlacement(placementId) {
      const units = visibleUnits();
      const index = units.findIndex(unit => unit.placements.some(placement => placement.placementId === placementId));
      if (index < 0) return false;
      if (pageSize > 0) page = Math.floor(index / pageSize);
      frontByDeck = { ...frontByDeck, [units[index].unitId]: placementId };
      activePagerPlacementId = placementId;
      return true;
    }

    function focusCard(kind, id) {
      const placement = liveDocument().placements.find((candidate) =>
        candidate.boardId === boardId && candidate.card.kind === kind && candidate.card.id === id && !candidate.hidden);
      if (!placement || !revealPlacement(placement.placementId)) return false;
      render({ preserveFocus: false });
      motion.scrollPlacementIntoView(container, placement.placementId);
      const target = [...container.querySelectorAll('[data-card-placement-id]')]
        .find((card) => card.dataset.cardPlacementId === placement.placementId);
      target?.querySelector('[data-card-action="draw"]')?.focus({ preventScroll: true });
      target?.closest('.cb-deck')?.classList.add('cb-highlight');
      container.ownerDocument.defaultView?.setTimeout?.(() => {
        target?.closest?.('.cb-deck')?.classList.remove('cb-highlight');
      }, 1200);
      return true;
    }

    function handleClick(event) {
      const placementElement = event.target.closest('[data-card-placement-id]');
      const placementId = placementElement?.dataset.cardPlacementId;
      const cardAction = event.target.closest('[data-card-action]')?.dataset.cardAction;
      if (cardAction === 'draw' && placementId && !editing) {
        const slot = placementElement.closest('.cb-deck');
        if (slot) drawPlacement(slot, placementId);
        return;
      }
      if ((cardAction === 'show-all' || cardAction === 'expand') && placementId) {
        openOverlay(placementId);
        return;
      }
      if (cardAction === 'add-site' && placementId) {
        onAddSite?.(cardForPlacement(placementId));
        return;
      }
      const editAction = event.target.closest('[data-card-edit-action]')?.dataset.cardEditAction;
      if (!editing || !placementId || !editAction) return;
      const placement = draftDocument.placements.find((candidate) => candidate.placementId === placementId);
      if (!placement) return;
      if (editAction === 'resize') {
        const size = event.target.closest('[data-card-next-size]')?.dataset.cardNextSize;
        applyOperations({ type: 'resize-placement', placementId, size });
      } else if (editAction === 'pin') {
        applyOperations({
          type: 'pin-to-board',
          sourcePlacementId: placementId,
          boardId: 'connect',
          index: model.boardUnits(draftDocument, 'connect').length,
          size: 'medium',
        });
      } else if (editAction === 'remove') {
        applyOperations(placement.boardId === 'connect'
          ? { type: 'remove-from-board', placementId }
          : { type: 'hide-placement', placementId });
      } else if (editAction === 'rename') {
        onRenameCard?.({ placement, card: cardForPlacement(placementId) });
      }
    }

    function handleKeydown(event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (editing) return;
      const tab = event.target.closest?.('[data-card-action="draw"]');
      if (!tab) return;
      const slot = tab.closest('.cb-deck');
      const tabs = [...slot.querySelectorAll(':scope > .cb-card [data-card-action="draw"]')];
      const index = tabs.indexOf(tab);
      if (index < 0) return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      tabs[(index + direction + tabs.length) % tabs.length].focus();
    }

    async function handleToolbarClick(event) {
      const action = event.target.closest('[data-board-action]')?.dataset.boardAction;
      if (!action || !editing) return;
      if (action === 'undo' && historyIndex > 0) {
        historyIndex -= 1;
        draftDocument = model.cloneDocument(history[historyIndex].document);
        operations = [...history[historyIndex].operations];
        resetRequested = false;
        render();
      } else if (action === 'redo' && historyIndex < history.length - 1) {
        historyIndex += 1;
        draftDocument = model.cloneDocument(history[historyIndex].document);
        operations = [...history[historyIndex].operations];
        resetRequested = false;
        render();
      } else if (action === 'reset') {
        const restore = draftDocument.placements
          .filter((placement) => placement.boardId === boardId)
          .map(({ placementId }) => ({ type: 'restore-default-placement', placementId }));
        applyOperations(restore);
      } else if (action === 'cancel') cancelEdit();
      else if (action === 'done') await finishEdit();
    }

    function setData(next = {}) {
      // Data/context changes retire old detail actions; only geometry-only redraws preserve them.
      closeOverlay();
      categories = (Array.isArray(next.categories) ? next.categories : []).map((category) => ({
        ...category,
        kind: category.kind || 'official-category',
        items: Array.isArray(category.items) ? category.items : [],
      }));
      cardsByKey = new Map(categories.map((category) => [`${category.kind}:${category.id}`, category]));
      documentState = reconcile(documentState);
      if (editing) {
        draftDocument = reconcile(draftDocument);
        history[historyIndex] = { document: model.cloneDocument(draftDocument), operations: [...operations] };
      }
      render();
    }

    function setDocument(nextDocument) {
      if (!nextDocument || editing) return false;
      closeOverlay();
      documentState = reconcile(nextDocument);
      render();
      return true;
    }

    async function load() {
      if (!hasExternalAdapter) return model.cloneDocument(documentState);
      try {
        const result = await adapter.get();
        const loaded = resultDocument(result);
        if (loaded && !editing) {
          closeOverlay();
          documentState = reconcile(loaded);
          onDocument?.(model.cloneDocument(documentState));
          render({ preserveFocus: false });
        }
      } catch {
        // The memory document is already visible; persistence failures must not
        // make campus resources unavailable.
      }
      return model.cloneDocument(documentState);
    }

    container.addEventListener('click', handleClick);
    container.addEventListener('keydown', handleKeydown);
    toolbar?.addEventListener('click', handleToolbarClick);
    manageButton?.addEventListener('click', toggleEdit);
    const handlePagerClick = (event) => {
      const placementButton = event.target.closest('[data-card-page-placement]');
      if (placementButton) {
        const placementId = placementButton.dataset.cardPagePlacement;
        const units = visibleUnits();
        const unitIndex = units.findIndex((unit) => unit.placements.some((placement) => (
          placement.placementId === placementId
        )));
        if (unitIndex < 0) return;
        if (pageSize > 0) page = Math.floor(unitIndex / pageSize);
        const unit = units[unitIndex];
        frontByDeck = { ...frontByDeck, [unit.unitId]: placementId };
        activePagerPlacementId = placementId;
        render({ preserveFocus: false, animate: switchStyle !== 'service' });
        if (switchStyle === 'service') {
          const slot = [...container.querySelectorAll('[data-card-deck-id]')]
            .find(element => element.dataset.cardDeckId === unit.unitId);
          if (slot) void motion.animateSwitch(slot, { front: slot.querySelector('.is-front'), back: slot.querySelector('.is-back') });
        }
        pager.querySelector(`[data-card-page-placement="${CSS.escape(placementId)}"]`)
          ?.focus({ preventScroll: true });
        return;
      }
      const button = event.target.closest('[data-card-page-index]');
      if (!button) return;
      page = Number(button.dataset.cardPageIndex) || 0;
      render({ preserveFocus: false, animate: !serviceLayout });
      if (serviceLayout) {
        for (const slot of container.querySelectorAll('.cb-deck')) {
          void motion.animateSwitch(slot, { front: slot.querySelector('.is-front'), back: slot.querySelector('.is-back') });
        }
        pager.querySelector(`[data-card-page-index="${page}"]`)?.focus({ preventScroll: true });
      }
    };
    pager?.addEventListener('click', handlePagerClick);
    dragFeature = drag.attach({
      container,
      onDrop,
      onKeyboardMove,
      onExternalDrop,
      externalTargets: externalDropTargets,
      announce: announceMessage,
    });
    responsiveFeature = motion.observeResponsive({
      container,
      model: responsiveModel,
      current: () => ({ columns }),
      onChange: (next) => {
        const focused = container.ownerDocument.activeElement;
        const anchor = serviceLayout && next.columns !== columns
          ? (container.contains(focused) ? focused?.closest('[data-card-placement-id]')?.dataset.cardPlacementId : null)
            || container.querySelector('.cb-card.is-front')?.dataset.cardPlacementId || activePagerPlacementId
          : null;
        columns = next.columns;
        if (anchor) revealPlacement(anchor);
        if (next.measureOnly) layoutBoard();
        else render({ animate: next.animate === true });
      },
    });

    return Object.freeze({
      cancelEdit,
      destroy() {
        destroyed = true;
        closeOverlay();
        responsiveFeature?.destroy();
        dragFeature?.destroy();
        container.removeEventListener('click', handleClick);
        container.removeEventListener('keydown', handleKeydown);
        toolbar?.removeEventListener('click', handleToolbarClick);
        manageButton?.removeEventListener('click', toggleEdit);
        pager?.removeEventListener('click', handlePagerClick);
      },
      enterEdit,
      finishEdit,
      focusCard,
      isEditing: () => editing,
      load,
      render,
      setData,
      setDocument,
      snapshot: () => model.cloneDocument(liveDocument()),
      toggleEdit,
      cardForPlacement,
    });
  }

  return Object.freeze({
    create,
    createMemoryAdapter,
    dropOperationsForDocument,
    localeStrings,
    resultDocument,
  });
});
