'use strict';

/**
 * 时间与日期的人性化显示测试。
 *
 * 覆盖：日期格式化（今天/明天/后天/星期）、跨零点车次的"次日"标注、
 * 历时占位值、以及事件文案里的时间范围。
 *
 * 这些都是"看起来对但很容易错"的地方：跨零点不标次日，
 * 用户会以为"19:10 开、08:44 到"是数据错误。
 *
 * 用法: node tools/test_time_format.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('./lib/dom');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    failures.push({ name, error: e });
    console.log('  FAIL ' + name);
    console.log('       ' + e.message);
  }
}
function eq(a, b, label) {
  if (a !== b) throw new Error(`${label || ''} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function section(t) {
  console.log('\n【' + t + '】');
}

/* ══════════════ 载入 app.js（取其中的格式化函数） ══════════════ */

const dom = createDom();
dom.initFromFile(path.join(ROOT, 'web', 'index.html'));

const sandbox = {
  document: dom.document,
  window: { devicePixelRatio: 1, open: () => {}, matchMedia: () => ({ matches: false }), addEventListener: () => {} },
  navigator: {},
  fetch: async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      config: { routes: [], wechat: {} }, stationCount: 0, diagnostics: {},
      latency: [], events: [], unread: 0, routes: [], intervalSec: 60,
      serverTime: Date.now(), dataSource: { providers: [], anyReady: false }, web: { ok: true },
    }),
  }),
  EventSource: class { addEventListener() {} },
  requestAnimationFrame: (fn) => fn(),
  setTimeout: () => 0,
  setInterval: () => 0,
  clearTimeout: () => {},
  console: { log: () => {}, warn: () => {}, error: () => {} },
  confirm: () => true,
  getComputedStyle: () => ({ getPropertyValue: () => '#07c160' }),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
const run = (e) => vm.runInContext(e, sandbox);

function dateAfter(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ══════════════ 日期格式化 ══════════════ */

section('日期格式化');

test('今天显示"今天 + 星期"', () => {
  const s = run(`fmtDate("${dateAfter(0)}")`);
  if (!/^今天 周[日一二三四五六]$/.test(s)) throw new Error('实际 ' + s);
});

test('明天 / 后天用相对说法', () => {
  if (!/^明天 周/.test(run(`fmtDate("${dateAfter(1)}")`))) throw new Error('明天格式不对');
  if (!/^后天 周/.test(run(`fmtDate("${dateAfter(2)}")`))) throw new Error('后天格式不对');
});

test('3 天以后显示 MM-DD + 星期', () => {
  const s = run(`fmtDate("${dateAfter(3)}")`);
  if (!/^\d{2}-\d{2} 周[日一二三四五六]$/.test(s)) throw new Error('实际 ' + s);
});

test('短格式一律 MM-DD + 星期', () => {
  const s = run(`fmtDate("${dateAfter(0)}",{short:true})`);
  if (!/^\d{2}-\d{2} 周[日一二三四五六]$/.test(s)) throw new Error('实际 ' + s);
});

test('星期计算正确（固定日期校验）', () => {
  // 2026-01-01 是周四
  eq(run('fmtDate("2026-01-01",{short:true})'), '01-01 周四', '2026-01-01');
  // 2026-10-01 是周四
  eq(run('fmtDate("2026-10-01",{short:true})'), '10-01 周四', '2026-10-01');
  // 2026-09-19 是周六
  eq(run('fmtDate("2026-09-19",{short:true})'), '09-19 周六', '2026-09-19');
});

test('非法日期原样返回，不抛错', () => {
  eq(run('fmtDate("")'), '');
  eq(run('fmtDate("乱写")'), '乱写');
  eq(run('fmtDate(null)'), '');
});

test('dayLabel 带星期', () => {
  const s = run('dayLabel(Date.now())');
  eq(s, '今天', '今天应无星期后缀');
  const past = run('dayLabel(Date.now() - 86400000)');
  eq(past, '昨天');
  const older = run('dayLabel(Date.now() - 3*86400000)');
  if (!/周[日一二三四五六]$/.test(older)) throw new Error('更早的日期应带星期，实际 ' + older);
});

test('daysFromToday 计算正确', () => {
  eq(run(`daysFromToday("${dateAfter(0)}")`), 0);
  eq(run(`daysFromToday("${dateAfter(7)}")`), 7);
  eq(run(`daysFromToday("${dateAfter(-2)}")`), -2);
});

/* ══════════════ 跨零点（关键） ══════════════ */

section('跨零点车次');

test('出发晚于到达 → 判为次日', () => {
  eq(run('isNextDay("19:10","08:44")'), true, 'Z281 型');
  eq(run('isNextDay("20:04","11:02")'), true, 'T109 型');
  eq(run('isNextDay("23:50","00:30")'), true, '跨零点');
  eq(run('isNextDay("11:59","06:45")'), true, '白天出发深夜到');
});

test('同日到达不标次日', () => {
  eq(run('isNextDay("06:30","11:24")'), false, '京沪高铁');
  eq(run('isNextDay("08:00","08:30")'), false, '半小时');
  eq(run('isNextDay("08:00","08:00")'), false, '同点');
});

test('占位时刻 24:00 不算跨日', () => {
  eq(run('isNextDay("24:00","24:00")'), false);
  eq(run('isNextDay("19:10","24:00")'), false);
});

test('到达时刻带"次日"前缀', () => {
  eq(run('fmtArriveTime("19:10","08:44")'), '次日 08:44');
  eq(run('fmtArriveTime("06:30","11:24")'), '11:24');
});

test('缺失或占位时刻显示为 —', () => {
  eq(run('fmtArriveTime("08:00","")'), '—');
  eq(run('fmtArriveTime("08:00","24:00")'), '—');
  eq(run('fmtArriveTime("","")'), '—');
});

/* ══════════════ 历时 ══════════════ */

section('历时显示');

test('正常历时原样显示', () => {
  eq(run('fmtDuration("05:56")'), '05:56');
  eq(run('fmtDuration("18:46")'), '18:46');
});

test('平台占位值 99:59 显示为 —', () => {
  eq(run('fmtDuration("99:59")'), '—', '这是"当日不开行"的占位值');
});

test('空历时显示为 —', () => {
  eq(run('fmtDuration("")'), '—');
  eq(run('fmtDuration(null)'), '—');
});

/* ══════════════ 事件文案（服务端） ══════════════ */

section('事件文案的时间范围');

const stateMod = require(path.join(ROOT, 'src', 'core', 'state.js'));

test('同日车次给出"出发→到达"', () => {
  eq(stateMod.timeRange({ departTime: '06:30', arriveTime: '11:24' }), '06:30→11:24');
});

test('跨零点车次标"次日"', () => {
  eq(stateMod.timeRange({ departTime: '19:10', arriveTime: '08:44' }), '19:10→次日 08:44');
});

test('占位时刻退化为"出发 开"', () => {
  eq(stateMod.timeRange({ departTime: '24:00', arriveTime: '24:00' }), '24:00 开');
  eq(stateMod.timeRange({ departTime: '08:00', arriveTime: '' }), '08:00 开');
});

test('缺出发时间返回空串', () => {
  eq(stateMod.timeRange({}), '');
  eq(stateMod.timeRange(null), '');
});

test('事件文案包含时间范围（端到端串起来）', () => {
  const prev = [{ code: 'G1', seats: { second: { state: 'none', count: 0, text: '无' } }, departTime: '06:30', arriveTime: '11:24' }];
  const next = [{
    code: 'G1', departTime: '06:30', arriveTime: '11:24', seatList: [],
    seats: { second: { state: 'available', count: 12, text: '有(12)' } },
  }];
  next[0].seatList = Object.entries(next[0].seats).map(([k, v]) => Object.assign({ key: k, name: '二等座', short: '二等' }, v));
  const ev = stateMod.diffSnapshot(prev, next, ['second'], new Set());
  eq(ev.length, 1);
  if (!ev[0].text.includes('06:30→11:24')) throw new Error('事件文案缺少时间范围: ' + ev[0].text);
});

/* ══════════════ 微信推送文案 ══════════════ */

section('微信推送文案');

const wechat = require(path.join(ROOT, 'src', 'notify', 'wechat.js'));

test('推送里的日期带星期', () => {
  const s = wechat.humanDate('2026-01-01');
  eq(s, '01-01 周四');
});

test('推送里的跨零点到达标"次日"', () => {
  eq(wechat.humanArrive('19:10', '08:44'), '次日 08:44');
  eq(wechat.humanArrive('06:30', '11:24'), '11:24');
});

test('推送表格渲染包含次日标注', () => {
  const rows = [{
    code: 'Z281', departTime: '19:10', arriveTime: '08:44',
    seatList: [{ short: '硬卧', state: 'available', text: '有' }],
  }];
  const md = wechat.renderTicketTable({ from: '北京', to: '上海', date: '2026-10-02' }, rows);
  if (!md.includes('次日 08:44')) throw new Error('表格里缺次日标注:\n' + md);
  if (!md.includes('10-02 周五')) throw new Error('表格里日期未人性化:\n' + md);
});

/* ══════════════ 结论 ══════════════ */

console.log('\n══════════════════════════════');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail === 0) {
  console.log('全部通过');
  process.exit(0);
}
for (const f of failures) {
  console.log('\n失败: ' + f.name);
  console.log(f.error.stack);
}
process.exit(1);
