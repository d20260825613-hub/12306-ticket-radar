'use strict';

/**
 * 核心逻辑测试：parser / state / engine / client 的纯逻辑与边界条件。
 *
 * 界面有 smoke_ui.js 覆盖，但变化检测、去重、快照、配置匹配这些
 * "看不到"的逻辑一直没有测试 —— 而它们恰恰决定工具是否有用。
 *
 * 用法: node tools/test_core.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const parser = require(path.join(ROOT, 'src', 'core', 'parser.js'));
const stations = require(path.join(ROOT, 'src', 'core', 'stations.js'));

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

function section(t) {
  console.log('\n【' + t + '】');
}

/* ══════════════════ parser ══════════════════ */

section('parser 余票解析');

/** 造一行 58 段的原始记录（与 12306 实际格式一致）。 */
function makeRow(overrides) {
  const f = new Array(58).fill('');
  f[0] = 'SECRET%2FTOKEN%0A';
  f[1] = '预订';
  f[2] = '240000G1';
  f[3] = 'G1';
  f[4] = 'VNP';
  f[5] = 'AOH';
  f[6] = 'VNP';
  f[7] = 'AOH';
  f[8] = '06:30';
  f[9] = '11:24';
  f[10] = '04:54';
  f[11] = 'Y';
  f[13] = '20261008';
  Object.assign(f, overrides || {});
  return f.join('|');
}

test('解析出车次与时刻', () => {
  const r = parser.parseRow(makeRow(), { VNP: '北京南', AOH: '上海虹桥' });
  assert.strictEqual(r.code, 'G1');
  assert.strictEqual(r.departTime, '06:30');
  assert.strictEqual(r.arriveTime, '11:24');
  assert.strictEqual(r.duration, '04:54');
  assert.strictEqual(r.boardName, '北京南');
  assert.strictEqual(r.alightName, '上海虹桥');
});

test('URL 编码的字段不会造成错位', () => {
  // 首段含 %0A 与 %2F；若不先解码再切分，后续所有字段都会偏移
  const row = makeRow();
  const r = parser.parseRow(row, {});
  assert.strictEqual(r.code, 'G1', '字段错位：解出了 ' + r.code);
  assert.strictEqual(r.date, '20261008');
});

test('席位状态：有 / 无 / 数字 / 候补', () => {
  assert.deepStrictEqual(parser.normalizeAvailability('有'), { state: 'available', count: null, text: '有' });
  assert.deepStrictEqual(parser.normalizeAvailability('无'), { state: 'none', count: 0, text: '无' });
  assert.strictEqual(parser.normalizeAvailability('12').state, 'available');
  assert.strictEqual(parser.normalizeAvailability('12').count, 12);
  assert.strictEqual(parser.normalizeAvailability('0').state, 'none');
  assert.strictEqual(parser.normalizeAvailability('候补').state, 'waitlist');
  assert.strictEqual(parser.normalizeAvailability('').state, 'unknown');
});

test('时长字段不是席位（回归：曾把到达时间误当席位）', () => {
  const r = parser.parseRow(makeRow(), {});
  // 席位集合里不应出现 06:30 / 11:24 这类时刻值
  const texts = r.seatList.map((s) => s.text);
  assert.ok(!texts.includes('06:30'), '时刻被误判为席位');
});

test('缺字段或空行返回 null 而非抛出', () => {
  assert.strictEqual(parser.parseRow('', {}), null);
  assert.strictEqual(parser.parseRow('a|b|c', {}), null);
  assert.strictEqual(parser.parseRow(null, {}), null);
  assert.strictEqual(parser.parseRow('|'.repeat(58), {}), null, '无车次号应返回 null');
});

test('hasAnyTicket 判定', () => {
  const none = parser.parseRow(makeRow({ 30: '无', 31: '无' }), {});
  assert.strictEqual(parser.hasAnyTicket(none), false);
  const some = parser.parseRow(makeRow({ 30: '有' }), {});
  assert.strictEqual(parser.hasAnyTicket(some), true);
});

/* ══════════════════ stations ══════════════════ */

section('stations 站点解析');

test('中文名 / 电报码 / 拼音 / 前缀 均可解析', () => {
  assert.strictEqual(stations.resolve('北京南').code, 'VNP');
  assert.strictEqual(stations.resolve('VNP').name, '北京南');
  assert.strictEqual(stations.resolve('vnp').code, 'VNP');
  assert.strictEqual(stations.resolve('beijingnan').code, 'VNP');
  assert.ok(stations.resolve('北京'));
});

test('无效输入返回 null', () => {
  assert.strictEqual(stations.resolve('不存在的站名XYZ'), null);
  assert.strictEqual(stations.resolve(''), null);
  assert.strictEqual(stations.resolve(null), null);
  assert.strictEqual(stations.resolve('   '), null);
});

/* ══════════════════ state ══════════════════ */

section('state 变化检测');

const state = require(path.join(ROOT, 'src', 'core', 'state.js'));

// 这些用例必须跑在 loadConfig() 之前：验证未加载配置时的兜底行为
test('未加载配置时 isQuietNow 不抛异常（回归）', () => {
  // config 在 loadConfig() 之前是 null；曾因直接解构 quietHours 而 TypeError
  assert.doesNotThrow(() => state.isQuietNow());
  assert.strictEqual(typeof state.isQuietNow(), 'boolean');
  assert.doesNotThrow(() => state.isRushWindow());
  assert.doesNotThrow(() => state.currentIntervalSec());
});

// 之后需要真实配置
state.loadConfig();

/** 造一条"快照里的行"（只含 code/seats/departTime，与 engine 存的一致）。 */
function snapRow(code, seats, dep) {
  const all = {};
  for (const k of ['business', 'first', 'second', 'topGrade', 'softSleeper', 'deluxeSleeper',
    'hardSleeper', 'softSeat', 'hardSeat', 'noSeat', 'preferredFirst']) {
    all[k] = { state: 'unknown', count: null, text: '' };
  }
  return { code, departTime: dep || '06:30', seats: Object.assign(all, seats) };
}

/** 造一条解析后的行（含 seatList）。 */
function liveRow(code, seats, dep) {
  const base = snapRow(code, seats, dep);
  base.seatList = Object.entries(base.seats)
    .filter(([, v]) => v.state !== 'unknown')
    .map(([k, v]) => Object.assign({ key: k, name: k, short: k }, v));
  base.type = code[0];
  base.fromCode = 'VNP';
  base.toCode = 'AOH';
  base.fromName = '北京南';
  base.toName = '上海虹桥';
  return base;
}

const avail = (n) => ({ state: 'available', count: n === undefined ? null : n, text: n === undefined ? '有' : '有(' + n + ')' });
const none = () => ({ state: 'none', count: 0, text: '无' });
const unknown = () => ({ state: 'unknown', count: null, text: '' });

test('无票 → 有票 产生 becameAvailable', () => {
  const prev = [snapRow('G1', { second: none() })];
  const next = [liveRow('G1', { second: avail(12) })];
  const ev = state.diffSnapshot(prev, next, ['second']);
  assert.strictEqual(ev.length, 1, '事件数应为 1，实际 ' + ev.length);
  assert.strictEqual(ev[0].kind, 'becameAvailable');
  assert.strictEqual(ev[0].trainCode, 'G1');
});

test('有票 → 无票 不产生事件（不打扰用户）', () => {
  const prev = [snapRow('G1', { second: avail(5) })];
  const next = [liveRow('G1', { second: none() })];
  assert.strictEqual(state.diffSnapshot(prev, next, ['second']).length, 0);
});

test('一直无票 不产生事件', () => {
  const prev = [snapRow('G1', { second: none() })];
  const next = [liveRow('G1', { second: none() })];
  assert.strictEqual(state.diffSnapshot(prev, next, ['second']).length, 0);
});

test('余票数量增加 产生 countIncreased', () => {
  const prev = [snapRow('G1', { second: avail(5) })];
  const next = [liveRow('G1', { second: avail(20) })];
  const ev = state.diffSnapshot(prev, next, ['second']);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].kind, 'countIncreased');
});

test('数量减少 不产生事件', () => {
  const prev = [snapRow('G1', { second: avail(20) })];
  const next = [liveRow('G1', { second: avail(5) })];
  assert.strictEqual(state.diffSnapshot(prev, next, ['second']).length, 0);
});

test('未知 → 有票 视为 becameAvailable', () => {
  const prev = [snapRow('G1', { second: unknown() })];
  const next = [liveRow('G1', { second: avail() })];
  assert.strictEqual(state.diffSnapshot(prev, next, ['second'])[0].kind, 'becameAvailable');
});

test('prev 为空时不产生事件（engine 的基线语义）', () => {
  // engine 仅在快照存在时才调用 diffSnapshot；这里锁定该前提下的行为
  const next = [liveRow('G1', { second: avail(9) }), liveRow('G9', { second: avail(4) })];
  assert.strictEqual(state.diffSnapshot([], next, ['second'], new Set()).length, 0);
});

test('首次采集不刷屏：45 趟可购车次只在有 prev 后才报新增（回归）', () => {
  // 首次采集（无 prev）必须静默建立基线，否则 45 趟车就是 45 条推送
  const rows = [];
  for (let i = 1; i <= 45; i++) rows.push(liveRow('G' + i, { second: avail(i) }));
  assert.strictEqual(state.diffSnapshot([], rows, ['second'], new Set()).length, 0, '无 prev 应完全静默');

  // 第二轮：上一轮已建立基线，此时才可能出现事件
  const noTrains = rows.map((r) => snapRow(r.code, { second: none() }));
  const seen = state.seenTrainsFrom([]);
  const ev = state.diffSnapshot(noTrains, rows, ['second'], seen);
  assert.strictEqual(ev.length, 45, '第二轮应检出 45 条变化，实际 ' + ev.length);
  assert.ok(ev.every((e) => e.kind === 'becameAvailable'), '应为 becameAvailable 而非 newTrain');
});

test('只关注指定席位', () => {
  const prev = [snapRow('G1', { second: none(), business: none() })];
  const next = [liveRow('G1', { second: none(), business: avail(3) })];
  const ev = state.diffSnapshot(prev, next, ['second']);
  assert.strictEqual(ev.length, 0, '未关注的席位不应产生事件');
  assert.strictEqual(state.diffSnapshot(prev, next, ['business']).length, 1);
});

test('未指定席位时关注全部', () => {
  const prev = [snapRow('G1', { business: none() })];
  const next = [liveRow('G1', { business: avail(3) })];
  assert.strictEqual(state.diffSnapshot(prev, next, []).length, 1);
  assert.strictEqual(state.diffSnapshot(prev, next, null).length, 1);
});

test('新增车次且从未提醒过 产生 newTrain', () => {
  const prev = [snapRow('G1', { second: none() })];
  const next = [liveRow('G1', { second: none() }), liveRow('G9', { second: avail(4) })];
  const seen = new Set(['G1']);
  const ev = state.diffSnapshot(prev, next, ['second'], seen);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].kind, 'newTrain');
  assert.strictEqual(ev[0].trainCode, 'G9');
});

test('已提醒过的车次重现 不再报 newTrain', () => {
  const prev = [snapRow('G1', { second: none() })];
  const next = [liveRow('G1', { second: none() }), liveRow('G9', { second: avail(4) })];
  const ev = state.diffSnapshot(prev, next, ['second'], new Set(['G1', 'G9']));
  assert.strictEqual(ev.length, 0);
});

test('快照行没有 seatList 时能从 seats 重建（回归）', () => {
  // 上一轮快照里的行不带 seatList，只有 seats
  const prev = [snapRow('G1', { second: none() })];
  const next = [liveRow('G1', { second: avail(7) })];
  assert.strictEqual(prev[0].seatList, undefined, '前置条件：快照行确实没有 seatList');
  const ev = state.diffSnapshot(prev, next, ['second'], new Set());
  assert.strictEqual(ev.length, 1, '应从 seats 重建席位列表并检出变化');
  assert.strictEqual(ev[0].kind, 'becameAvailable');
});

test('seenTrainsFrom 从历史事件收集车次', () => {
  const seen = state.seenTrainsFrom([
    { trainCode: 'G1' },
    { trainCode: 'G9' },
    { trainCode: 'G1' },
    null,
    {},
  ]);
  assert.strictEqual(seen.size, 2);
  assert.ok(seen.has('G1') && seen.has('G9'));
});

test('去重：同车次同席位同类型在窗口内只留一次', () => {
  const ev = [{ trainCode: 'G1', seatKey: 'second', kind: 'becameAvailable', text: 'x' }];
  const recent = [{ ts: Date.now() - 60000, trainCode: 'G1', seatKey: 'second', kind: 'becameAvailable' }];
  assert.strictEqual(state.dedupe(ev, recent, 10).length, 0);
});

test('去重：超出窗口的事件不阻止新通知', () => {
  const ev = [{ trainCode: 'G1', seatKey: 'second', kind: 'becameAvailable', text: 'x' }];
  const old = [{ ts: Date.now() - 20 * 60000, trainCode: 'G1', seatKey: 'second', kind: 'becameAvailable' }];
  assert.strictEqual(state.dedupe(ev, old, 10).length, 1);
});

test('去重：不同类型不互相抑制', () => {
  const ev = [{ trainCode: 'G1', seatKey: 'second', kind: 'countIncreased', text: 'x' }];
  const recent = [{ ts: Date.now() - 60000, trainCode: 'G1', seatKey: 'second', kind: 'becameAvailable' }];
  assert.strictEqual(state.dedupe(ev, recent, 10).length, 1);
});

test('去重：同批次内重复事件只留一条', () => {
  const ev = [
    { trainCode: 'G1', seatKey: 'second', kind: 'becameAvailable', text: 'a' },
    { trainCode: 'G1', seatKey: 'second', kind: 'becameAvailable', text: 'b' },
  ];
  assert.strictEqual(state.dedupe(ev, [], 10).length, 1);
});

test('routeKey 对同线路不同日期产生不同键', () => {
  const a = state.routeKey({ from: '北京南', to: '上海虹桥', date: '2026-10-08' });
  const b = state.routeKey({ from: '北京南', to: '上海虹桥', date: '2026-10-09' });
  assert.notStrictEqual(a, b);
});

test('routeKey 在只有 dateOffset 时回退到 offset 键', () => {
  const k = state.routeKey({ from: '北京南', to: '上海虹桥', dateOffset: 45 });
  assert.ok(k.includes('offset45'), '实际: ' + k);
});

test('静默时段跨午夜判定', () => {
  const inQuiet = (start, end, h) => {
    if (start === end) return false;
    return start < end ? h >= start && h < end : h >= start || h < end;
  };
  assert.strictEqual(inQuiet(23, 6, 23), true, '23 点应静默');
  assert.strictEqual(inQuiet(23, 6, 3), true, '3 点应静默');
  assert.strictEqual(inQuiet(23, 6, 12), false, '12 点不应静默');
  assert.strictEqual(inQuiet(23, 6, 6), false, '6 点应结束静默');
  assert.strictEqual(inQuiet(23, 6, 22), false, '22 点不该静默');
  assert.strictEqual(inQuiet(5, 5, 5), false, '起止相同表示不启用');
});

test('isQuietNow 在设定的静默小时内返回 true', () => {
  const cfg = state.getConfig();
  const orig = cfg.quietHours;
  try {
    const h = new Date().getHours();
    cfg.quietHours = { start: h, end: (h + 1) % 24 };
    // start<end 且当前小时等于 start，应静默
    if (cfg.quietHours.start < cfg.quietHours.end) {
      assert.strictEqual(state.isQuietNow(), true);
    }
    cfg.quietHours = { start: h, end: h };
    assert.strictEqual(state.isQuietNow(), false);
  } finally {
    cfg.quietHours = orig;
  }
});

/* ══════════════════ 配置持久化 ══════════════════ */

section('配置持久化与匹配');

test('config.json 是可解析的 UTF-8 JSON，站名能解析', () => {
  const p = path.join(ROOT, 'data', 'config.json');
  if (!fs.existsSync(p)) return; // 首次运行尚未生成
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(Array.isArray(cfg.routes), 'routes 应为数组');
  for (const r of cfg.routes) {
    assert.ok(stations.resolve(r.from), '出发站无法解析: ' + r.from);
    assert.ok(stations.resolve(r.to), '到达站无法解析: ' + r.to);
  }
});

test('删除线路的匹配逻辑与前端发送的字段一致', () => {
  // 前端发送 { from, to, dateOffset }（取自 route.raw）
  // 服务端按 String(r.dateOffset) === String(body.dateOffset) 匹配
  const routes = [
    { from: '北京南', to: '上海虹桥', dateOffset: 45 },
    { from: '北京南', to: '上海虹桥', dateOffset: 7 },
  ];
  const body = { from: '北京南', to: '上海虹桥', dateOffset: 45 };
  const left = routes.filter(
    (r) => !(r.from === body.from && r.to === body.to && String(r.dateOffset) === String(body.dateOffset))
  );
  assert.strictEqual(left.length, 1, '应只删掉 dateOffset 匹配的那条');
  assert.strictEqual(left[0].dateOffset, 7);
});

test('新增线路时同 (from,to,dateOffset) 会被替换而非重复', () => {
  const routes = [{ from: '北京南', to: '上海虹桥', dateOffset: 45, seats: ['second'] }];
  const route = { from: '北京南', to: '上海虹桥', dateOffset: 45, seats: ['first'] };
  const next = routes.filter((r) => !(r.from === route.from && r.to === route.to && r.dateOffset === route.dateOffset));
  next.push(route);
  assert.strictEqual(next.length, 1);
  assert.deepStrictEqual(next[0].seats, ['first']);
});

/* ══════════════════ client ══════════════════ */

section('client 内部逻辑');

const client = require(path.join(ROOT, 'src', 'core', 'client.js'));

test('Cookie 解析为请求头', () => {
  const h = client.cookieHeaderFrom(['JSESSIONID=abc; Path=/; HttpOnly', 'SF_cookie_2=99; Path=/']);
  assert.ok(h.includes('JSESSIONID=abc'), h);
  assert.ok(h.includes('SF_cookie_2=99'), h);
  assert.ok(!h.includes('Path'), '不应带上属性: ' + h);
});

test('Cookie 空输入不抛错', () => {
  assert.strictEqual(client.cookieHeaderFrom(null), '');
  assert.strictEqual(client.cookieHeaderFrom([]), '');
  assert.strictEqual(client.cookieHeaderFrom(['garbage']), '');
});

test('请求最小间隔生效（串行两次请求不小于设定间隔）', async () => {
  // 该用例是异步的，放到最后的 await 段执行
});

/* ══════════════════ 轮询间隔钳位 ══════════════════ */

section('轮询间隔钳位');

test('越界与非法间隔被收敛到可用范围', () => {
  // 网页端写进来的 1e21 会让 setTimeout 溢出、被 Node 折算成 1ms，引擎于是
  // 以约 70 次/秒的频率猛打上游。写侧拒绝 + 读侧钳位，两道都要在。
  assert.strictEqual(state.clampIntervalSec(1e21), state.MAX_INTERVAL_SEC);
  assert.strictEqual(state.clampIntervalSec(0), state.MIN_INTERVAL_SEC);
  assert.strictEqual(state.clampIntervalSec(-5), state.MIN_INTERVAL_SEC);
  assert.strictEqual(state.clampIntervalSec(1e9), state.MAX_INTERVAL_SEC);
  assert.strictEqual(state.clampIntervalSec(60), 60);
  assert.strictEqual(state.clampIntervalSec('abc'), state.DEFAULT_CONFIG.intervalSec);
  assert.strictEqual(state.clampIntervalSec(NaN), state.DEFAULT_CONFIG.intervalSec);
  assert.strictEqual(state.clampIntervalSec(undefined), state.DEFAULT_CONFIG.intervalSec);
});

test('钳位后的间隔换算成毫秒一定落在 setTimeout 的安全范围', () => {
  for (const v of [1e21, -1e21, Infinity, -Infinity, 1e300, Math.pow(2, 60)]) {
    const ms = state.clampIntervalSec(v) * 1000;
    assert.ok(ms >= 10 * 1000, '延时 ' + ms + ' 太短');
    assert.ok(ms <= 2147483647, '延时 ' + ms + ' 超出 32 位 setTimeout 上限');
  }
});

test('畸形请求目标会让 new URL 抛错（服务端必须自己兜住）', () => {
  // 锁住崩溃的成因：`GET /\` 不是合法 URL。异常一旦冒出请求处理器，未捕获的
  // 异常就会打死整个进程 —— 所以 server.js 里那句 new URL 必须在 try 内。
  assert.throws(() => new URL('/\\', 'http://127.0.0.1'), /Invalid URL/);
});

/* ══════════════════ 结论 ══════════════════ */

(async () => {
  // 异步用例：最小间隔
  section('client 最小间隔（异步）');
  const t0 = Date.now();
  const p1 = client.httpGet({ path: '/otn/leftTicket/init', minIntervalMs: 0 });
  const p2 = client.httpGet({ path: '/otn/leftTicket/init', minIntervalMs: 1200 });
  await Promise.all([p1, p2]);
  const elapsed = Date.now() - t0;
  if (elapsed >= 1150) {
    pass++;
    console.log('  ok   两次请求间隔不小于 1200ms（实测 ' + elapsed + 'ms）');
  } else {
    fail++;
    console.log('  FAIL 最小间隔未生效，实测 ' + elapsed + 'ms');
  }

  // 异步用例：一个畸形请求不该打死服务
  section('服务端健壮性（异步）');
  const { spawn } = require('child_process');
  const net = require('net');
  const port = 13000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), NO_OPEN: '1' }),
    stdio: 'ignore',
  });

  const rawGet = (target) =>
    new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => {
        // Node 的 http 客户端不会构造这种请求目标，只能用裸 socket 发
        s.write('GET ' + target + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let buf = '';
      s.on('data', (d) => {
        buf += d;
      });
      s.on('end', () => resolve(buf));
      s.on('error', reject);
      setTimeout(() => {
        s.destroy();
        resolve(buf);
      }, 3000);
    });

  try {
    // 等端口真的开起来，而不是赌一个固定睡眠
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      up = await new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1');
        s.on('connect', () => {
          s.destroy();
          resolve(true);
        });
        s.on('error', () => resolve(false));
      });
      if (!up) await new Promise((r) => setTimeout(r, 150));
    }
    if (!up) throw new Error('服务未在 6 秒内监听 ' + port);

    const response = await rawGet('/\\');
    if (child.exitCode === null && /^HTTP\/1\.1 400/.test(response)) {
      pass++;
      console.log('  ok   畸形请求目标得到 400，且进程仍然存活');
    } else {
      fail++;
      console.log('  FAIL 畸形请求目标: 存活=' + (child.exitCode === null) + ' 响应=' + JSON.stringify(response.slice(0, 40)));
    }

    // 正常请求仍然能用，确认不是把服务打残了
    const okResponse = await rawGet('/api/state');
    if (/^HTTP\/1\.1 200/.test(okResponse)) {
      pass++;
      console.log('  ok   畸形请求之后正常请求仍是 200');
    } else {
      fail++;
      console.log('  FAIL 畸形请求之后正常请求异常: ' + JSON.stringify(okResponse.slice(0, 40)));
    }
  } catch (e) {
    fail++;
    console.log('  FAIL 服务端健壮性: ' + e.message);
  } finally {
    child.kill();
  }

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
})();
