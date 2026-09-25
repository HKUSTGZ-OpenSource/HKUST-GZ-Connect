'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const presenter = require('../../../renderer/campus-search-presenter');

const desk = {
  applications: [{
    id: 'app-hpc2', name: 'HPC2 登录节点', aliases: ['hpc', 'hpc2', '算力', '超算', 'ssh'],
    useCase: 'SSH 高性能计算入口', audience: '科研人员', route: 'campus',
  }, {
    id: 'app-library', name: '图书馆', aliases: ['借书', 'library', '馆藏'],
    useCase: '馆藏检索、借阅与数据库', audience: '全体师生', route: 'direct',
  }],
  serviceItems: [{
    id: 'svc-reimbursement', name: '采购与报销申请', aliases: ['报销', '采购', 'pbms'],
    useCase: '科研项目经费报销与采购', audience: '科研项目负责人 / 成员', route: 'campus',
  }, {
    id: 'svc-enrollment-cert', name: '在读证明', aliases: ['在读', '证明', '在读证明'],
    useCase: '开具在读身份证明', audience: '本科生 / 研究生', route: 'direct',
  }],
};

const score = (entry, query) => presenter.scoreEntry(entry, query).value;

test('names outrank aliases which outrank use cases', () => {
  const [hpc2] = desk.applications;
  assert.equal(score({ name: 'HPC2', aliases: [], useCase: '' }, 'HPC2'), 500);
  assert.equal(score(hpc2, 'HPC2 登录'), 400);
  assert.ok(score(hpc2, '超算') <= 350 && score(hpc2, '超算') >= 290);
  assert.ok(score(hpc2, '高性能计算') === 250);
  assert.equal(score(hpc2, '报销'), 0);
});

test('task phrasing is stripped so natural requests hit the structured entry', () => {
  const [reimbursement] = desk.serviceItems;
  assert.ok(score(reimbursement, '我要报销') >= 300, '报销 alias must beat the board fan-out');
  assert.ok(score(reimbursement, '我想申请报销') >= 300);
  const certificate = desk.serviceItems[1];
  assert.ok(score(certificate, '我要申请在读证明') >= 300);
  assert.ok(score(certificate, '在读证明') >= 290);
});

test('scores stay structured: no hardcoded per-site audience hints remain', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', '..', 'renderer', 'campus-search-presenter.js'), 'utf8',
  );
  assert.doesNotMatch(source, /REVIEWED_HINTS/);
  assert.equal(typeof presenter.present, 'undefined');
  assert.equal(typeof presenter.audienceFor, 'undefined');
});

test('highlighting escapes source text before adding bounded mark elements', () => {
  const markup = presenter.highlight('<HPC2 & login>', 'hpc2', (value) => String(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
  assert.equal(markup, '&lt;<mark>HPC2</mark> &amp; login&gt;');
});
