(function initializeCardBoardMotion(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.cardBoardMotion = api;
})(typeof self !== 'undefined' ? self : globalThis, function cardBoardMotionFactory() {
  'use strict';

  // §11 draw animation: 240ms total, transform + opacity only, the z-order swap
  // happens on the first frame. Reduced Motion degrades to a 100ms fade.
  const DRAW_DURATION_MS = 240;
  const DRAW_EASING = 'cubic-bezier(.2,.7,.2,1)';
  const LAYER_OFFSET_PX = 36;

  function isReducedMotion(container) {
    return container?.ownerDocument?.defaultView
      ?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  }

  function animateSwitch(container, { front, back = null } = {}) {
    if (isReducedMotion(container)) return Promise.resolve();
    const options = { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' };
    const animations = [];
    if (front?.animate) animations.push(front.animate([
      { opacity: .72, transform: 'translateY(-7px) scale(.994)' },
      { opacity: 1, transform: 'none' },
    ], options));
    if (back?.animate) animations.push(back.animate([
      { opacity: .82, transform: 'translateY(5px)' },
      { opacity: 1, transform: 'none' },
    ], { ...options, duration: 220 }));
    return Promise.all(animations.map(animation => animation.finished.catch(() => {})));
  }

  function placementRects(container) {
    return new Map([...container.querySelectorAll('[data-card-placement-id]')].map((card) => [
      card.dataset.cardPlacementId,
      card.getBoundingClientRect(),
    ]));
  }

  function scrollPlacementIntoView(container, placementId) {
    const card = [...container.querySelectorAll('[data-card-placement-id]')]
      .find((candidate) => candidate.dataset.cardPlacementId === placementId);
    if (!card || typeof card.scrollIntoView !== 'function') return false;
    card.scrollIntoView({ block: 'nearest', behavior: isReducedMotion(container) ? 'auto' : 'smooth' });
    return true;
  }

  // FLIP feedback for organize-mode reflows. Draw animations do not use this;
  // they run on a fixed slot whose geometry never changes (§10.4).
  function animateFrom(container, previousRects) {
    const ownerWindow = container?.ownerDocument?.defaultView;
    if (!previousRects?.size || !ownerWindow || isReducedMotion(container)) return false;
    ownerWindow.requestAnimationFrame(() => {
      for (const card of container.querySelectorAll('[data-card-placement-id]')) {
        const previous = previousRects.get(card.dataset.cardPlacementId);
        if (!previous || typeof card.animate !== 'function') continue;
        const current = card.getBoundingClientRect();
        const dx = previous.left - current.left;
        const dy = previous.top - current.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        card.animate([
          { transform: `translate(${dx}px, ${dy}px)`, opacity: .82 },
          { transform: 'translate(0, 0)', opacity: 1 },
        ], { duration: 250, easing: DRAW_EASING });
      }
    });
    return true;
  }

  // target/oldFront/between are card elements; deltaPx is how far the drawn card
  // travels downward into the front position. Resolves when every animation
  // settles; interruptions finish early via cancel(). Reduced Motion is handled
  // by the caller (instant swap + 100ms fade).
  function animateDraw(container, { target, oldFront, between = [], deltaPx }) {
    if (typeof target?.animate !== 'function') return Promise.resolve();
    const anims = [];
    anims.push(target.animate([
      { transform: 'translate(0px, 0px) scale(1)', offset: 0 },
      { transform: 'translate(0px, -14px) scale(1.015)', offset: 0.25 },
      { transform: `translate(10px, ${deltaPx * 0.55 - 8}px) scale(1.008)`, offset: 0.66 },
      { transform: `translate(0px, ${deltaPx}px) scale(1)`, offset: 1 },
    ], { duration: DRAW_DURATION_MS, easing: DRAW_EASING, fill: 'forwards' }));
    for (const selector of ['.cb-card-body', '.cb-card-foot']) {
      const region = target.querySelector(selector);
      if (region?.animate) {
        anims.push(region.animate(
          [{ opacity: 0 }, { opacity: 1 }],
          { duration: 80, delay: 160, fill: 'backwards' },
        ));
      }
    }
    if (oldFront?.animate) {
      anims.push(oldFront.animate([
        { transform: 'translateY(0px) scale(1)', offset: 0 },
        { transform: 'translateY(0px) scale(1)', offset: 0.25 },
        { transform: 'translateY(8px) scale(.985)', offset: 0.66 },
        { transform: `translateY(${-LAYER_OFFSET_PX}px) scale(1)`, offset: 1 },
      ], { duration: DRAW_DURATION_MS, easing: DRAW_EASING, fill: 'forwards' }));
    }
    for (const card of between) {
      if (!card?.animate) continue;
      anims.push(card.animate(
        [{ transform: 'translateY(0px)' }, { transform: `translateY(${-LAYER_OFFSET_PX}px)` }],
        { duration: 180, delay: 60, easing: DRAW_EASING, fill: 'forwards' },
      ));
    }
    return Promise.all(anims.map((animation) => animation.finished.catch(() => {})))
      .then(() => anims.forEach((animation) => { try { animation.cancel(); } catch {} }));
  }

  function observeResponsive({ container, model, current, onChange, delay = 120 } = {}) {
    if (!container || typeof model?.columnsForWidth !== 'function' ||
        typeof current !== 'function' || typeof onChange !== 'function') {
      throw new TypeError('card board responsive motion dependencies are incomplete');
    }
    const ownerWindow = container.ownerDocument?.defaultView;
    let frame = null;
    let timer = null;
    const schedule = (width = container.clientWidth) => {
      ownerWindow?.cancelAnimationFrame?.(frame);
      clearTimeout(timer);
      frame = ownerWindow?.requestAnimationFrame?.(() => {
        const state = current();
        const columns = model.columnsForWidth(width || container.clientWidth);
        if (columns !== state.columns) {
          onChange({ columns, animate: false });
          return;
        }
        // Same column count: only card metrics (narrow/wide tier) may change.
        timer = setTimeout(() => onChange({ columns, measureOnly: true }), delay);
      }) ?? null;
    };
    const ResizeObserverClass = ownerWindow?.ResizeObserver || globalThis.ResizeObserver;
    const observer = typeof ResizeObserverClass === 'function'
      ? new ResizeObserverClass((entries) => schedule(
        entries[0]?.contentRect?.width || container.clientWidth,
      )) : null;
    observer?.observe(container);
    ownerWindow?.addEventListener?.('resize', schedule);
    return Object.freeze({
      schedule,
      destroy() {
        ownerWindow?.cancelAnimationFrame?.(frame);
        clearTimeout(timer);
        observer?.disconnect();
        ownerWindow?.removeEventListener?.('resize', schedule);
      },
    });
  }

  return Object.freeze({
    DRAW_DURATION_MS,
    DRAW_EASING,
    LAYER_OFFSET_PX,
    animateDraw,
    animateSwitch,
    animateFrom,
    isReducedMotion,
    observeResponsive,
    placementRects,
    scrollPlacementIntoView,
  });
});
