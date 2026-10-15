'use strict';

/**
 * 数据源层测试。
 *
 * 覆盖：
 *   - provider 选择逻辑（auto / 强制 / 降级）
 *   - apihz 返回结构归一化（这是新功能的核心转换，必须准确）
 *   - 座位余票语义（-1 充足 / 0 无票 / >0 张数）
 *   - 缺字段、异常输入不崩
 *
 * 全部不依赖网络：归一化是纯函数，选择逻辑只读配置。
 *
 * 用法: node tools/test_providers.js
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const providers = require(path.join(ROOT, 'src', 'core', 'providers'));
const apihz = require(path.join(ROOT, 'src', 'core', 'providers', 'apihz'));
const direct = require(path.join(ROOT, 'src', 'core', 'providers', 'direct'));

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

/* ══════════════ 造数据 ══════════════ */

/** 按平台文档的真实结构造一条车次。 */
function trip(over) {
  return Object.assign(
    {
      train_number: 'G3286',
      train_order: '76000G32860A',
      depart_index: '04',
      arrive_index: '24',
      depart_name: '绵阳',
      arrive_name: '上海虹桥',
      depart_city: '绵阳',
      arrive_city: '上海',
      depart_code: 'MYW',
      arrive_code: 'AOH',
      depart_time: '08:32',
      arrive_time: '19:42',
      duration: '11:10',
      seatcode: '9MOO',
      date: '2025-12-15',
      seats: [
        { type: '商务座(特等座)', stock: 0 },
        { type: '一等座', stock: 4 },
        { type: '二等座(二等包座)', stock: -1 },
      ],
    },
    over || {}
  );
}

/* ══════════════ provider 选择 ══════════════ */

section('provider 选择');

test('列表含 direct 与 apihz', () => {
  const ids = providers.list().map((p) => p.id).sort();
  assert.deepStrictEqual(ids, ['apihz', 'direct']);
});

test('auto + 未配置任何源 → 无可用数据源，且给出可操作提示', () => {
  const c = providers.pick({ provider: 'auto', apihz: { id: '', key: '' } });
  assert.strictEqual(c.provider, null);
  assert.ok(/填写 id\/key|未配置/.test(c.reason), c.reason);
});

test('auto + 已配置第三方 → 选 apihz（直连默认不可用）', () => {
  const c = providers.pick({ provider: 'auto', apihz: { id: '1', key: 'k' }, fallbackToApihz: true });
  assert.strictEqual(c.provider.name, 'apihz');
});

test('强制 direct → 选 direct（tryDirect 由 provider 决定 ready）', () => {
  const c = providers.pick({ provider: 'direct', apihz: { id: '1', key: 'k' } });
  assert.strictEqual(c.provider.name, 'direct');
});

test('强制 apihz 但未配置 → 无可用源且说明原因', () => {
  const c = providers.pick({ provider: 'apihz', apihz: { id: '', key: '' } });
  assert.strictEqual(c.provider, null);
  assert.ok(/id\/key/.test(c.reason), c.reason);
});

test('关掉降级后直连不可用 → 无源', () => {
  const c = providers.pick({ provider: 'auto', apihz: { id: '1', key: 'k' }, fallbackToApihz: false });
  assert.strictEqual(c.provider, null);
});

test('tryDirect 打开时直连被视为可用', () => {
  assert.strictEqual(direct.ready({ tryDirect: true }), true);
  assert.strictEqual(direct.ready({ tryDirect: false }), false);
  assert.strictEqual(direct.ready({}), false);
});

test('apihz.ready 需要 id 与 key 同时存在', () => {
  assert.strictEqual(apihz.ready({ apihz: { id: '1', key: '' } }), false);
  assert.strictEqual(apihz.ready({ apihz: { id: '', key: 'k' } }), false);
  assert.strictEqual(apihz.ready({ apihz: { id: '1', key: 'k' } }), true);
  assert.strictEqual(apihz.ready({}), false);
  assert.strictEqual(apihz.ready(null), false);
});

/* ══════════════ 余票语义 ══════════════ */

section('余票语义映射');

test('-1 表示有票且充足', () => {
  const r = apihz.normalizeStock(-1);
  assert.strictEqual(r.state, 'available');
  assert.strictEqual(r.count, null);
  assert.strictEqual(r.text, '有');
});

test('0 表示无票', () => {
  const r = apihz.normalizeStock(0);
  assert.strictEqual(r.state, 'none');
  assert.strictEqual(r.count, 0);
});

test('大于 0 表示具体余票张数', () => {
  const r = apihz.normalizeStock(7);
  assert.strictEqual(r.state, 'available');
  assert.strictEqual(r.count, 7);
  assert.strictEqual(r.text, '有(7)');
});

test('字符串数字同样可解析', () => {
  assert.strictEqual(apihz.normalizeStock('-1').state, 'available');
  assert.strictEqual(apihz.normalizeStock('0').state, 'none');
  assert.strictEqual(apihz.normalizeStock('12').count, 12);
});

test('异常输入退化为 unknown 而不是抛错', () => {
  assert.strictEqual(apihz.normalizeStock(null).state, 'unknown');
  assert.strictEqual(apihz.normalizeStock(undefined).state, 'unknown');
  assert.strictEqual(apihz.normalizeStock('').state, 'unknown');
});

/* ══════════════ 座位名映射 ══════════════ */

section('座位类型映射');

test('带括号的类型名能正确归类', () => {
  assert.strictEqual(apihz.seatKeyOf('二等座(二等包座)'), 'second');
  assert.strictEqual(apihz.seatKeyOf('商务座(特等座)'), 'business');
  assert.strictEqual(apihz.seatKeyOf('软卧(动卧一等卧)'), 'softSleeper');
  assert.strictEqual(apihz.seatKeyOf('硬卧(二等卧)'), 'hardSleeper');
});

test('全角与半角括号都支持', () => {
  assert.strictEqual(apihz.seatKeyOf('二等座（二等包座）'), 'second');
});

test('常见席位都能映射', () => {
  assert.strictEqual(apihz.seatKeyOf('一等座'), 'first');
  assert.strictEqual(apihz.seatKeyOf('优选一等座'), 'preferredFirst');
  assert.strictEqual(apihz.seatKeyOf('高级软卧'), 'topGrade');
  assert.strictEqual(apihz.seatKeyOf('软座'), 'softSeat');
  assert.strictEqual(apihz.seatKeyOf('硬座'), 'hardSeat');
  assert.strictEqual(apihz.seatKeyOf('无座'), 'noSeat');
});

test('认不出的类型返回 null（跳过而不是猜）', () => {
  assert.strictEqual(apihz.seatKeyOf('外星座'), null);
  assert.strictEqual(apihz.seatKeyOf(''), null);
  assert.strictEqual(apihz.seatKeyOf(null), null);
});

test('优选一等座不会被误判为一等座', () => {
  // 包含匹配容易出错，这个用例锁死优先级
  assert.strictEqual(apihz.seatKeyOf('优选一等座'), 'preferredFirst');
  assert.notStrictEqual(apihz.seatKeyOf('优选一等座'), 'first');
});

/* ══════════════ 完整归一化 ══════════════ */

section('车次归一化');

test('基础字段正确映射', () => {
  const r = apihz.normalizeTrip(trip());
  assert.strictEqual(r.code, 'G3286');
  assert.strictEqual(r.type, 'G');
  assert.strictEqual(r.fromName, '绵阳');
  assert.strictEqual(r.toName, '上海虹桥');
  assert.strictEqual(r.fromCode, 'MYW');
  assert.strictEqual(r.toCode, 'AOH');
  assert.strictEqual(r.departTime, '08:32');
  assert.strictEqual(r.arriveTime, '19:42');
  assert.strictEqual(r.duration, '11:10');
  assert.strictEqual(r.source, 'apihz');
  assert.strictEqual(r.trainNo, '76000G32860A');
});

test('输出结构与内部 parser 同构（快照/变化检测依赖它）', () => {
  const r = apihz.normalizeTrip(trip());
  // seats 必须覆盖全部席位 key，且每项形如 {state,count,text}
  const keys = Object.keys(r.seats);
  assert.strictEqual(keys.length, 11, '实际 ' + keys.length + ' 个: ' + keys.join(','));
  for (const k of keys) {
    const s = r.seats[k];
    assert.ok(typeof s.state === 'string' && 'count' in s && typeof s.text === 'string',
      k + ' 结构不对: ' + JSON.stringify(s));
  }
  // seatList 只含已知状态的席位，且带 key/name/short
  assert.ok(Array.isArray(r.seatList));
  for (const s of r.seatList) {
    assert.ok(s.key && s.name && s.short, 'seatList 项缺字段: ' + JSON.stringify(s));
  }
});

test('seatList 与 seats 保持一致', () => {
  const r = apihz.normalizeTrip(trip());
  for (const s of r.seatList) {
    assert.strictEqual(r.seats[s.key].state, s.state, s.key + ' 两处状态不一致');
  }
});

test('只有出票的席位进入 seatList', () => {
  const r = apihz.normalizeTrip(trip());
  const keys = r.seatList.map((s) => s.key).sort();
  // 造的样本里商务座 0（无票，仍应出现）、一等座 4、二等座 -1
  assert.ok(keys.includes('business'));
  assert.ok(keys.includes('first'));
  assert.ok(keys.includes('second'));
  // 样本里没提到的席位不应出现
  assert.ok(!keys.includes('hardSleeper'), '未提及的席位不该进 seatList');
});

test('同一席位出现多次时取更宽松的结果', () => {
  const r = apihz.normalizeTrip(trip({
    seats: [
      { type: '二等座', stock: 0 },
      { type: '二等座(二等包座)', stock: -1 },
    ],
  }));
  assert.strictEqual(r.seats.second.state, 'available', '应取"有票"而不是"无票"');
});

test('缺 train_number 返回 null', () => {
  assert.strictEqual(apihz.normalizeTrip({}), null);
  assert.strictEqual(apihz.normalizeTrip(null), null);
  assert.strictEqual(apihz.normalizeTrip({ depart_time: '08:00' }), null);
});

test('缺 seats 不崩，全部记为 unknown', () => {
  const r = apihz.normalizeTrip(trip({ seats: undefined }));
  assert.ok(r);
  assert.strictEqual(r.seatList.length, 0);
  assert.strictEqual(r.seats.second.state, 'unknown');
});

test('缺时刻字段不崩，给空串而不是 undefined', () => {
  const r = apihz.normalizeTrip({ train_number: 'K1' });
  assert.strictEqual(r.departTime, '');
  assert.strictEqual(r.arriveTime, '');
  assert.strictEqual(r.duration, '');
  assert.strictEqual(r.fromName, '');
});

test('批次归一化跳过坏数据', () => {
  const rows = apihz.normalizeDatas([trip(), null, {}, trip({ train_number: 'G1' })]);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map((r) => r.code), ['G3286', 'G1']);
});

test('批次为空数组返回空数组', () => {
  assert.deepStrictEqual(apihz.normalizeDatas([]), []);
  assert.deepStrictEqual(apihz.normalizeDatas(null), []);
});

/* ══════════════ 未配置时的行为 ══════════════ */

section('未配置时的行为');

test('未配置 id/key 时 fetchTickets 直接返回失败而不发请求', async () => {
  const r = await apihz.fetchTickets({ date: '2026-01-01', from: '北京南', to: '上海虹桥', cfg: { apihz: {} } });
  assert.strictEqual(r.ok, false);
  assert.ok(/id\/key|未配置/.test(r.error), r.error);
});

/* ══════════════ 日期收敛（重要回归） ══════════════ */

section('日期收敛（预售期 14 天）');

function dateAfter(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('14 天内不改动', () => {
  const s = dateAfter(7);
  const r = apihz.clampDate(s);
  assert.strictEqual(r.clamped, false);
  assert.strictEqual(r.date, s);
});

test('第 14 天仍可用（边界）', () => {
  assert.strictEqual(apihz.clampDate(dateAfter(14)).clamped, false, '14 天应仍在上限内');
});

test('超过 14 天被收敛（回归）', () => {
  // 曾经默认 45 天 —— 平台一律返回"查询失败"，而测试按钮用 7 天却成功，
  // 两者不一致导致"测试通过但看不到余票"
  const s = dateAfter(45);
  const r = apihz.clampDate(s);
  assert.strictEqual(r.clamped, true);
  assert.notStrictEqual(r.date, s);
  assert.strictEqual(r.original, s);
  assert.strictEqual(apihz.offsetOf(r.date), apihz.MAX_DATE_OFFSET_DAYS);
});

test('15 天也会被收敛', () => {
  assert.strictEqual(apihz.clampDate(dateAfter(15)).clamped, true);
});

test('上限常量就是 14', () => {
  assert.strictEqual(apihz.MAX_DATE_OFFSET_DAYS, 14);
});

test('无法解析的日期原样返回，不抛错', () => {
  const r = apihz.clampDate('不是日期');
  assert.strictEqual(r.clamped, false);
  assert.strictEqual(r.date, '不是日期');
});

test('offsetOf 计算正确', () => {
  assert.strictEqual(apihz.offsetOf(dateAfter(3)), 3);
  assert.strictEqual(apihz.offsetOf(dateAfter(0)), 0);
});

/* ══════════════ 占位记录过滤 ══════════════ */

section('占位记录过滤');

test('24:00/99:59 且无票 → 判为占位记录', () => {
  const t = trip({
    train_number: 'G531',
    depart_time: '24:00',
    arrive_time: '24:00',
    duration: '99:59',
    seats: [{ type: '二等座', stock: 0 }, { type: '一等座', stock: 0 }],
  });
  assert.strictEqual(apihz.isPlaceholderTrip(t), true);
});

test('占位记录被 normalizeTrip 丢弃', () => {
  const t = trip({
    train_number: 'G531',
    depart_time: '24:00',
    arrive_time: '24:00',
    duration: '99:59',
    seats: [{ type: '二等座', stock: 0 }],
  });
  assert.strictEqual(apihz.normalizeTrip(t), null);
});

test('时刻正常 → 不是占位记录', () => {
  assert.strictEqual(apihz.isPlaceholderTrip(trip()), false);
});

test('时刻异常但确实有票 → 保留（不误杀）', () => {
  const t = trip({ depart_time: '24:00', arrive_time: '24:00', duration: '99:59' });
  t.seats = [{ type: '二等座', stock: 12 }];
  assert.strictEqual(apihz.isPlaceholderTrip(t), false);
});

test('跨零点车次（23:50-00:30）不被误判', () => {
  assert.strictEqual(apihz.isPlaceholderTrip(trip({ depart_time: '23:50', arrive_time: '00:30', duration: '08:40' })), false);
});

test('批次里占位记录被剔除', () => {
  const rows = apihz.normalizeDatas([
    trip(),
    trip({ train_number: 'G531', depart_time: '24:00', arrive_time: '24:00', duration: '99:59', seats: [{ type: '二等座', stock: 0 }] }),
    trip({ train_number: 'G9' }),
  ]);
  assert.deepStrictEqual(rows.map((r) => r.code), ['G3286', 'G9']);
});

/* ══════════════ 结论 ══════════════ */

(async () => {
  // 异步用例放最后
  section('异步');
  const r = await apihz.fetchTickets({ date: '2026-01-01', from: '北京南', to: '上海虹桥', cfg: { apihz: {} } });
  if (!r.ok) {
    pass++;
    console.log('  ok   未配置时不发起网络请求（返回 ' + r.error + '）');
  } else {
    fail++;
    console.log('  FAIL 未配置时竟然成功了');
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
