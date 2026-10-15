'use strict';

/**
 * 交互路径测试：模拟用户"进入设置页并填写数据源"的完整点击流程。
 *
 * 为什么需要它：渲染成功 ≠ 点得动。
 * 用户反馈"连 key 窗口都打不开"，说明问题可能出在交互链路上
 * （导航切换、按钮绑定、跳转），而不是渲染本身。
 *
 * 使用共享 DOM 桩（tools/lib/dom.js），保证各测试对浏览器行为的
 * 假设一致 —— 之前各自手写桩，一度把桩的缺陷误判成产品缺陷。
 *
 * 用法: node tools/test_settings_flow.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('./lib/dom');

const ROOT = path.join(__dirname, '..');
const dom = createDom();

/* ────────────── mock 后端 ────────────── */

const now = Date.now();
const appState = {
  config: {
    routes: [], intervalSec: 60, rushIntervalSec: 20, dedupeWindowMin: 10,
    quietHours: { start: 23, end: 6 },
    wechat: { enabled: false, channel: 'pushplus', token: '' },
    dataSource: { provider: 'auto', apihz: { id: '', key: '', endpoint: '' }, fallbackToApihz: true, tryDirect: false },
  },
  stationCount: 3384,
  diagnostics: { lastRunAt: now, lastOkAt: null, lastError: null, blocked: false, cycles: 0, consecutiveFailures: 0 },
  latency: [], events: [], unread: 0, routes: [],
  quietNow: false, rushNow: false, intervalSec: 60, serverTime: now, version: '0.1.0',
  web: { ok: true, exists: true, files: 4 },
  dataSource: {
    providers: [
      { id: 'direct', label: '直连 12306', ready: false, note: '' },
      { id: 'apihz', label: '第三方数据源', ready: false, note: '' },
    ],
    active: null, reason: '第三方数据源未配置（请在设置里填写 id/key）', anyReady: false,
  },
};

let postedConfig = null;
const apiLog = [];

const sandbox = {
  document: dom.document,
  window: { devicePixelRatio: 1, open: () => {}, matchMedia: () => ({ matches: false }), addEventListener: () => {} },
  navigator: {},
  fetch: async (url, opts) => {
    const u = String(url);
    apiLog.push((opts && opts.method ? opts.method : 'GET') + ' ' + u);
    if (u.includes('/api/state')) return { ok: true, status: 200, json: async () => appState };
    if (u.includes('/api/config') && opts && opts.body) postedConfig = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  },
  EventSource: class { constructor() {} addEventListener() {} },
  requestAnimationFrame: (fn) => fn(),
  setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
  setInterval: () => 0,
  clearTimeout: () => {},
  console,
  confirm: () => true,
  getComputedStyle: () => ({ getPropertyValue: () => '#07c160' }),
};
sandbox.globalThis = sandbox;

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

const run = (x) => vm.runInContext(x, sandbox);
const $ = (id) => dom.$(id);
const mainHtml = () => dom.mainHtml();

/** 一条可用的监控线路（用于触发"有线路但未接数据源"分支）。 */
const ROUTE_FIXTURE = `[{raw:{from:'北京南',to:'上海虹桥',dateOffset:45,seats:['second']},from:'北京南',to:'上海虹桥',fromCode:'VNP',toCode:'AOH',date:'2026-10-08',rows:null,updatedAt:null,endpoint:null}]`;

(async () => {
  dom.initFromFile(path.join(ROOT, 'web', 'index.html'));
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
  await dom.settle();

  console.log('\n【路径 1：左侧导航点「设置」】');
  const navSettings = dom.navItems.find((n) => n.dataset.view === 'settings');
  check('导航里有 settings 项', !!navSettings);
  navSettings.click();
  await dom.settle();
  check('视图切到 settings', run('S.view') === 'settings', 'S.view=' + run('S.view'));
  check('设置页渲染出数据源 ID 输入框', mainHtml().includes('id="dsId"'));
  check('设置页渲染出 KEY 输入框', mainHtml().includes('id="dsKey"'));

  console.log('\n【路径 2：填写并测试连接】');
  $('dsId').value = '12345678';
  $('dsKey').value = 'abcdef123456';
  const testBtn = $('btnDsTest');
  check('测试按钮存在', !!testBtn);
  check('测试按钮有处理函数', typeof testBtn.onclick === 'function', 'onclick=' + typeof testBtn.onclick);

  apiLog.length = 0;
  if (typeof testBtn.onclick === 'function') await testBtn.onclick();
  await dom.settle();
  check('发起过 /api/datasource/test 请求', apiLog.some((l) => l.includes('/api/datasource/test')), apiLog.join(' | '));
  check('显示测试结果', /连接|失败|正在/.test($('dsResult').innerHTML), $('dsResult').innerHTML.slice(0, 80));

  console.log('\n【路径 3：保存设置时带上数据源】');
  postedConfig = null;
  await $('btnSaveCfg').onclick();
  await dom.settle();
  check('保存请求包含 dataSource', !!(postedConfig && postedConfig.dataSource),
    JSON.stringify(postedConfig && postedConfig.dataSource));
  if (postedConfig && postedConfig.dataSource) {
    check('  apihz.id 被提交', postedConfig.dataSource.apihz.id === '12345678', String(postedConfig.dataSource.apihz.id));
    check('  apihz.key 被提交', postedConfig.dataSource.apihz.key === 'abcdef123456', String(postedConfig.dataSource.apihz.key));
    check('  provider 被提交', postedConfig.dataSource.provider === 'auto', String(postedConfig.dataSource.provider));
  }

  console.log('\n【路径 4：有线路 + 未接数据源 → 引导卡跳设置】');
  run(`S.data.routes=${ROUTE_FIXTURE}`);
  run('S.data.dataSource.anyReady=false');
  run("S.view='radar'");
  run('render()');
  await dom.settle();
  const radarHtml = mainHtml();
  check('渲染出开通引导卡', radarHtml.includes('还差一步就能看到余票'),
    'routes=' + run('S.data.routes.length') + ' anyReady=' + run('S.data.dataSource.anyReady'));
  const goDsEl = $('btnGoDs');
  check('引导卡有「去填写数据源」按钮', !!goDsEl);
  // 注意：typeof null === 'object'，所以必须直接判断是不是函数
  check('  该按钮有处理函数（回归：曾经渲染了却没绑定）',
    typeof goDsEl.onclick === 'function',
    'onclick=' + String(goDsEl.onclick));
  if (typeof goDsEl.onclick === 'function') {
    await goDsEl.onclick();
    await dom.settle();
    check('  点它能进设置页', run('S.view') === 'settings', 'S.view=' + run('S.view'));
    check('  进设置页后能填 KEY', mainHtml().includes('id="dsKey"'));
  }

  console.log('\n【路径 5：从「怎么抢到票」页跳设置】');
  run("S.view='help'");
  run('render()');
  await dom.settle();
  const goSettings = $('btnGoSettings');
  check('帮助页有跳设置入口', !!goSettings);
  if (goSettings && typeof goSettings.onclick === 'function') {
    await goSettings.onclick({ preventDefault() {} });
    await dom.settle();
    check('跳转后视图是 settings', run('S.view') === 'settings', 'S.view=' + run('S.view'));
  }

  console.log('\n【路径 6：没有监控线路时的引导（关键回归）】');
  // 新用户往往先配数据源，此时页面上必须有入口 —— 曾经这里无处可点
  run('S.data.routes=[]');
  run('S.data.dataSource.anyReady=false');
  run("S.view='radar'");
  run('render()');
  await dom.settle();
  const onboardHtml = mainHtml();
  check('显示首次引导卡', onboardHtml.includes('onboard'));
  check('引导卡有添加区间按钮', typeof $('btnOnboardAdd').onclick === 'function');

  const onboardDs = $('btnOnboardDs');
  check('无线路时提供数据源入口', !!onboardDs && typeof onboardDs.onclick === 'function',
    '引导卡按钮: ' + (onboardHtml.match(/id="(btn[\w]+)"/g) || []).join(','));
  if (onboardDs && typeof onboardDs.onclick === 'function') {
    await onboardDs.onclick();
    await dom.settle();
    check('  点它能进设置页', run('S.view') === 'settings', 'S.view=' + run('S.view'));
    check('  进设置页后能填 KEY', mainHtml().includes('id="dsKey"'));
  }
  check('无数据源时提示了原因', /还得先接一个数据源/.test(onboardHtml));

  console.log('\n【路径 7：已接数据源时不应再劝配置】');
  run(`S.data.routes=${ROUTE_FIXTURE}`);
  run('S.data.dataSource.anyReady=true');
  run("S.data.dataSource.active='apihz'");
  run("S.data.diagnostics={lastError:null,blocked:false,consecutiveFailures:0,lastOkAt:Date.now()}");
  run("S.data.config.wechat={enabled:true,channel:'pushplus',token:'x'}");
  run("S.view='radar'");
  run('render()');
  await dom.settle();
  const okHtml = mainHtml();
  check('已接入后不再显示开通引导', !okHtml.includes('还差一步就能看到余票'));
  check('无线路时也不再劝配置（由 anyReady 决定）', (() => {
    run('S.data.routes=[]');
    run("S.view='radar'");
    run('render()');
    return !mainHtml().includes('btnOnboardDs');
  })());

  console.log('\n══════════════════════════════');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
