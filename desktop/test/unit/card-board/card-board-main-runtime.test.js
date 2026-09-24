'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { createCardBoardMainRuntime } = require('../../../lib/app/card-board-main-runtime');

test('Main composition derives layout authority and commits through one context transaction', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-card-main-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const allowedFile = path.join(root, 'index.html');
  const handlers = new Map();
  const notifications = [];
  const runtime = createCardBoardMainRuntime({
    favoritesFile: path.join(root, 'favorites.json'),
    platform: process.platform,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    allowedFiles: [allowedFile],
    getResources: () => [
      { id: 'portal', category: 'gateway', reviewed: true, favorite: true },
      { id: 'sis', category: 'courses', reviewed: true, favorite: true },
    ],
    getGroups: () => [{ id: 'group_abcdefghijkl', resourceIds: ['sis'] }],
    runTransaction: async (factory) => {
      const operation = factory();
      const value = await operation.commit();
      await operation.applyExternal?.();
      return value;
    },
    onChanged: (document) => notifications.push(document.revision),
  });
  const initial = runtime.getLayout();
  assert.deepEqual(initial.document.placements
    .filter(({ boardId }) => boardId === 'browser-catalog')
    .map(({ card }) => card.id), ['gateway', 'courses']);
  assert.deepEqual(initial.document.placements
    .filter(({ boardId }) => boardId === 'browser-personal')
    .map(({ card }) => card.id), ['group_abcdefghijkl', 'ungrouped-favorites']);
  const courses = initial.document.placements.find(({ card }) => card.id === 'courses');
  const committed = await runtime.commitLayout({
    baseRevision: initial.document.revision,
    operations: [{
      type: 'pin-to-board', sourcePlacementId: courses.placementId,
      boardId: 'connect', index: 1, size: 'medium',
    }],
  });
  assert.equal(committed.changed, true);
  assert.deepEqual(notifications, [1]);

  runtime.register('card-board-fixture', () => true);
  const event = {
    sender: {},
    senderFrame: { url: pathToFileURL(allowedFile).href },
  };
  assert.equal(await handlers.get('card-board-fixture')(event), true);
  assert.throws(() => handlers.get('card-board-fixture')({
    sender: {}, senderFrame: { url: pathToFileURL(path.join(root, 'other.html')).href },
  }));
});
