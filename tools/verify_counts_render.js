'use strict';

/**
 * 用真实接口数据验证"具体余票数量"能正确渲染。
 *
 * 与 smoke_ui 的区别：那个用构造数据验证渲染逻辑，
 * 这个确认**真实接口返回的 count 能变成界面上的数字**。
 *
 * 用法: node tools/verify_counts_render.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('./lib/dom');

const ROOT = path.join(__dirname, '..');
const apihz = require(path.join(ROOT, 'src', 'core', 'providers', 'apihz'));

function loadCfg() {
  const candidates = [
    'C:/Users/ADMIN/Desktop/\u4F59\u7968\u96F7\u8FBE/data/config.json',
    path.join(ROOT, 'data', 'config.json'),
  ];
  for (const p of candidates) {
    try {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      const a = (c.dataSource || {}).apihz || {};
      if (a.id && a.key) return c.dataSource;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

(async () => {
  const cfg = loadCfg();
  if (!cfg) {
    console.log('\n未找到含 id/key 的配置，跳过。\n');
    process.exit(0);
  }

  console.log('\n真实数据的余票数量渲染验证');

  // 多试几个日期，找一批带具体数量的数据
  const from = '北京南';
  const to = '上海虹桥';
  let rows = null;
  let usedDate = null;

  for (const off of [7, 8, 9, 10, 5, 6]) {
    const d = new Date(Date.now() + off * 86400000);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const res = await apihz.fetchTickets({ date, from, to, cfg });
    if (!res.ok) {
      console.log('  ' + date + ' 取数失败: ' + res.error);
      continue;
    }
    const withCount = res.rows.reduce(
      (n, r) => n + Object.values(r.seats).filter((s) => s.state === 'available' && s.count !== null).length,
      0
    );
    console.log('  ' + date + '：' + res.rows.length + ' 趟，' + withCount + ' 个席位有具体数量');
    if (withCount > 0) {
      rows = res.rows;
      usedDate = date;
      break;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }

  if (!rows) {
    console.log('\n  各日期都没有返回具体数量 —— 平台当前只给"有/无"。');
    console.log('  渲染逻辑仍由 smoke_ui 的构造数据覆盖，此处无法验证真实数字。\n');
    process.exit(0);
  }

  console.log('\n  使用 ' + usedDate + ' 的数据验证');

  // 渲染
  const dom = createDom();
  dom.initFromFile(path.join(ROOT, 'web', 'index.html'));
  const state = {
    config: {
      routes: [{ from, to, dateOffset: 7, seats: ['second', 'first', 'business', 'noSeat', 'softSleeper', 'hardSleeper'] }],
      intervalSec: 60, rushIntervalSec: 20, dedupeWindowMin: 10,
      quietHours: { start: 23, end: 6 },
      wechat: { enabled: true, channel: 'pushplus', token: 'x' },
      dataSource: { provider: 'apihz', apihz: { id: 'x', key: 'y' } },
    },
    stationCount: 3384,
    diagnostics: { lastRunAt: Date.now(), lastOkAt: Date.now(), lastError: null, cycles: 1, consecutiveFailures: 0 },
    latency: [], events: [], unread: 0,
    routes: [{
      raw: { from, to, dateOffset: 7, seats: ['second', 'first', 'business', 'noSeat', 'softSleeper', 'hardSleeper'] },
      from, to, fromCode: '', toCode: '', date: usedDate,
      rows, updatedAt: Date.now(), endpoint: 'apihz',
    }],
    quietNow: false, rushNow: false, intervalSec: 60, serverTime: Date.now(), version: '0.1.0',
    web: { ok: true },
    dataSource: { providers: [], active: 'apihz', reason: '', anyReady: true },
  };

  const sandbox = {
    document: dom.document,
    window: { devicePixelRatio: 1, open: () => {}, matchMedia: () => ({ matches: false }), addEventListener: () => {} },
    navigator: {},
    fetch: async () => ({ ok: true, status: 200, json: async () => state }),
    EventSource: class { constructor() {} addEventListener() {} },
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    setInterval: () => 0,
    clearTimeout: () => {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
    confirm: () => true,
    getComputedStyle: () => ({ getPropertyValue: () => '#07c160' }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
  await dom.settle();

  const html = dom.mainHtml();

  const ROUTE_SEATS = ['second', 'first', 'business', 'noSeat', 'softSleeper', 'hardSleeper'];

  // 真实数据里"该线路关注范围内"应有的具体数量
  const expected = new Map();
  for (const r of rows) {
    for (const [k, s] of Object.entries(r.seats)) {
      if (!ROUTE_SEATS.includes(k)) continue; // 未关注的席位表格里本就不渲染
      if (s.state === 'available' && s.count !== null) expected.set(r.code + '|' + k, s.count);
    }
  }

  const rendered = [...html.matchAll(/<span class="num">(\d+)<\/span><span class="sn">([^<]*)<\/span>/g)].map((m) => ({
    count: Number(m[1]),
    name: m[2],
  }));

  console.log('');
  check('渲染出的数字标签数量 > 0', rendered.length > 0, '实际 ' + rendered.length);
  check('渲染出的数量与真实数据一致（数量上是同一批）',
    rendered.length === expected.size,
    `渲染 ${rendered.length} / 真实 ${expected.size}`);
  check('数字都是正整数',
    rendered.every((r) => Number.isInteger(r.count) && r.count > 0),
    JSON.stringify(rendered.slice(0, 5)));
  check('没有把 0 渲染成数字', !renderdHasZero(html));

  const sum = html.match(/<b>(\d+)<\/b> 个席位有确切余票数量/);
  check('统计摘要里的确切数量与渲染一致',
    !!sum && Number(sum[1]) === rendered.length,
    sum ? `摘要 ${sum[1]} / 渲染 ${rendered.length}` : '摘要缺失');

  console.log('');
  console.log('  渲染出的数字（前 12 个）:');
  for (const r of rendered.slice(0, 12)) console.log(`    ${r.name} 余票 ${r.count} 张`);

  console.log('\n══════════════════════════════');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();

function renderdHasZero(html) {
  return /<span class="num">0<\/span>/.test(html);
}
