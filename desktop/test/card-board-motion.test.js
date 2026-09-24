'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const motion = require('../renderer/components/card-board/card-board-motion');

test('service-style switches share a bounded soft animation and respect Reduced Motion', async () => {
  const { animations, makeCard, container } = fixture();
  await motion.animateSwitch(container, { front: makeCard('front'), back: makeCard('back') });
  assert.deepEqual(animations.map(a=>a.options.duration),[240,220]);
  assert.ok(animations.every(a=>a.options.easing==='cubic-bezier(.2,.8,.2,1)'));
  assert.equal(animations[0].frames[0].transform,'translateY(-7px) scale(.994)');
  const reduced=fixture({reduced:true});
  await motion.animateSwitch(reduced.container,{front:reduced.makeCard('front')});
  assert.equal(reduced.animations.length,0);
});

function fixture({ reduced = false } = {}) {
  const animations = [];
  const makeCard = (placementId) => ({
    dataset: { cardPlacementId: placementId },
    getBoundingClientRect: () => ({ left: 80, top: 120, width: 200, height: 44 }),
    animate: (frames, options) => {
      animations.push({ frames, options, placementId });
      return { finished: Promise.resolve(), cancel() {} };
    },
    querySelector: () => null,
  });
  const ownerWindow = {
    innerHeight: 900,
    matchMedia: () => ({ matches: reduced }),
    requestAnimationFrame: (callback) => { callback(); return 1; },
  };
  const container = {
    ownerDocument: { defaultView: ownerWindow },
    getBoundingClientRect: () => ({ top: 180 }),
    querySelectorAll: () => [],
  };
  return { animations, makeCard, container };
}

test('the draw animation stays within the approved 240ms transform-only window', async () => {
  const { animations, makeCard, container } = fixture();
  const target = makeCard('target');
  const oldFront = makeCard('front');
  const between = [makeCard('middle')];
  await motion.animateDraw(container, { target, oldFront, between, deltaPx: 72 });
  const [drawn] = animations;
  assert.equal(drawn.placementId, 'target');
  assert.equal(drawn.options.duration, 240);
  assert.ok(drawn.options.duration >= 220 && drawn.options.duration <= 260);
  assert.equal(drawn.options.easing, 'cubic-bezier(.2,.7,.2,1)');
  assert.equal(drawn.options.fill, 'forwards');
  assert.ok(drawn.frames.every((frame) => (
    Object.keys(frame).every((key) => ['transform', 'opacity', 'offset'].includes(key))
  )), 'only transform/opacity/offset may animate');
  assert.match(drawn.frames[1].transform, /translate\(0px, -14px\) scale\(1\.015\)/u);
  assert.match(drawn.frames.at(-1).transform, /translate\(0px, 72px\) scale\(1\)/u);
  const retired = animations.find(({ placementId }) => placementId === 'front');
  assert.match(retired.frames.at(-1).transform, /translateY\(-36px\) scale\(1\)/u);
  const follower = animations.find(({ placementId }) => placementId === 'middle');
  assert.equal(follower.options.duration, 180);
  assert.equal(follower.options.delay, 60);
});

test('FLIP draws an existing card from its prior position with the approved timing', () => {
  const { container } = fixture();
  const card = {
    dataset: { cardPlacementId: 'placement-a' },
    getBoundingClientRect: () => ({ left: 80, top: 120, width: 200, height: 44 }),
    animate: (frames, options) => {
      container.captured = { frames, options };
      return { finished: Promise.resolve(), cancel() {} };
    },
  };
  container.querySelectorAll = () => [card];
  const previous = new Map([['placement-a', { left: 20, top: 40, width: 200, height: 44 }]]);
  assert.equal(motion.animateFrom(container, previous), true);
  assert.deepEqual(container.captured.frames[0], {
    transform: 'translate(-60px, -80px)', opacity: .82,
  });
  assert.equal(container.captured.options.duration, 250);
});

test('Reduced Motion skips positional card animation', () => {
  const { container } = fixture({ reduced: true });
  assert.equal(motion.isReducedMotion(container), true);
  const previous = new Map([['placement-a', { left: 20, top: 40 }]]);
  assert.equal(motion.animateFrom(container, previous), false);
});

test('a drawn card scrolls into the nearest visible area and respects Reduced Motion', () => {
  const { container } = fixture({ reduced: true });
  const card = {
    dataset: { cardPlacementId: 'placement-a' },
    scrollIntoView(value) { this.options = value; },
  };
  container.querySelectorAll = () => [card];
  assert.equal(motion.scrollPlacementIntoView(container, 'placement-a'), true);
  assert.deepEqual(card.options, { block: 'nearest', behavior: 'auto' });
  assert.equal(motion.scrollPlacementIntoView(container, 'missing'), false);
});
