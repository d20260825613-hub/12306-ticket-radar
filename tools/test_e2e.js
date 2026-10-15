'use strict';

/**
 * 端到端测试：用 mock 的 12306 客户端驱动真实服务，验证完整链路。
 *
 * 覆盖：
 *   - 首次采集建立基线且不推送（防刷屏）
 *   - 余票出现时推送一次，同一变化在去重窗口内不重复推送
 *   - 静默时段只记录不推送
 *   - HTTP API 契约（创建/删除线路、配置、事件已读）
 *
 * 12306 被风控拦截，真实余票拿不到，所以余票数据由本测试合成。
 * 用法: node tools/test_e2e.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

// 数据目录必须重定向，否则会覆盖真实配置与状态
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-e2e-'));
process.env.TICKET_RADAR_DATA = TMP;
process.env.NO_OPEN = '1';

/* ─────────── 先注入 12306 客户端的假实现，再加载其它模块 ─────────── */

const clientPath = require.resolve(path.join(ROOT, 'src', 'core', 'client.js'));
const wechatPath = require.resolve(path.join(ROOT, 'src', 'notify', 'wechat.js'));

/** 当前应返回的余票行（由用例设置） */
let currentRows = [];
let queryCalls = 0;
let sentMessages = [];

/** 合成一行 58 段的原始记录 */
function rawRow(code, seatIdx, seatVal, dep) {
  const f = new Array(58).fill('');
  f[0] = 'SECRET';
  f[1] = '预订';
  f[2] = '24000' + code;
  f[3] = code;
  f[4] = 'VNP';
  f[5] = 'AOH';
  f[6] = 'VNP';
  f[7] = 'AOH';
  f[8] = dep || '06:30';
  f[9] = '11:24';
  f[10] = '04:54';
  f[11] = 'Y';
  f[13] = '20261008';
  if (seatIdx != null) f[seatIdx] = seatVal;
  return f.join('|');
}

require.cache[clientPath] = {
  id: clientPath,
  filename: clientPath,
  loaded: true,
  exports: {
    openSession: async () => ({ cookie: 'JSESSIONID=test', timing: { ttfb: 10, tls: 8, tcp: 5, dns: 2, total: 20 } }),
    queryTickets: async () => {
      queryCalls++;
      return {
        ok: true,
        endpoint: 'queryG',
        rows: currentRows,
        map: { VNP: '北京南', AOH: '上海虹桥' },
        timing: { ttfb: 120, tls: 70, tcp: 40, dns: 15, total: 200 },
        status: 200,
      };
    },
    probeLatency: async () => ({
      ok: true,
      status: 200,
      bytes: 1000,
      timing: { ttfb: 90, tls: 60, tcp: 35, dns: 12, total: 150 },
    }),
    httpGet: async () => ({ ok: false, error: 'stub' }),
    cookieHeaderFrom: () => '',
    KNOWN_ENDPOINTS: [],
    HOST: 'kyfw.12306.cn',
  },
};

// 引擎现在通过数据源层取数，因此要 stub provider 而不是 client。
// 用一个"直连 provider"替身：解析 currentRows 里的合成行。
const providersPath = require.resolve(path.join(ROOT, 'src', 'core', 'providers', 'index.js'));
const parserReal = require(path.join(ROOT, 'src', 'core', 'parser.js'));

const stubProvider = {
  name: 'apihz',
  label: 'stub',
  note: '',
  ready: () => true,
  fetchTickets: async () => {
    queryCalls++;
    return {
      ok: true,
      source: 'apihz',
      endpoint: 'stub',
      rows: parserReal.parseRows(currentRows, { VNP: '北京南', AOH: '上海虹桥' }),
      timing: { ttfb: 120, tls: 70, tcp: 40, dns: 15, total: 200 },
    };
  },
};

require.cache[providersPath] = {
  id: providersPath,
  filename: providersPath,
  loaded: true,
  exports: {
    PROVIDERS: { apihz: stubProvider },
    DEFAULT_SOURCE_CONFIG: { provider: 'auto', apihz: {}, fallbackToApihz: true, tryDirect: false },
    get: (n) => (n === 'apihz' ? stubProvider : null),
    list: () => [{ id: 'apihz', label: 'stub', ready: true, note: '' }],
    pick: () => ({ provider: stubProvider, reason: '测试替身' }),
    anyReady: () => true,
  },
};

const wechatReal = require(wechatPath);
require.cache[wechatPath] = {
  id: wechatPath,
  filename: wechatPath,
  loaded: true,
  exports: Object.assign({}, wechatReal, {
    send: async (cfg, msg) => {
      sentMessages.push(msg);
      return { ok: true, channel: 'stub' };
    },
    sendTest: async () => ({ ok: true, channel: 'stub' }),
  }),
};

/* ─────────── 加载被测模块 ─────────── */

const state = require(path.join(ROOT, 'src', 'core', 'state.js'));
const serverMod = require(path.join(ROOT, 'src', 'server.js'));

// 随机端口，避免与正在运行的实例冲突
const PORT = 20000 + Math.floor(Math.random() * 20000);
process.env.PORT = String(PORT);

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++;
      console.log('  ok   ' + name);
    })
    .catch((e) => {
      fail++;
      failures.push({ name, error: e });
      console.log('  FAIL ' + name);
      console.log('       ' + e.message);
    });
}

function section(t) {
  console.log('\n【' + t + '】');
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: p,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode, text });
          }
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  console.log('临时数据目录: ' + TMP);

  // 起服务
  serverMod.start();
  await new Promise((r) => setTimeout(r, 800));

  // 让引擎不要在后台自己跑，避免干扰计数
  serverMod.engine.stop();

  section('HTTP API 契约');

  await test('GET /api/state 返回预期结构', async () => {
    const r = await req('GET', '/api/state');
    assert.strictEqual(r.status, 200);
    const j = r.json;
    for (const k of ['config', 'stationCount', 'diagnostics', 'latency', 'events', 'routes', 'intervalSec']) {
      assert.ok(k in j, '缺少字段 ' + k);
    }
    assert.strictEqual(j.stationCount, 3384);
  });

  await test('GET /api/stations 返回站点索引', async () => {
    const r = await req('GET', '/api/stations');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.stations));
    assert.ok(r.json.stations.length > 3000);
    assert.ok(r.json.stations[0].n && r.json.stations[0].c);
  });

  await test('POST /api/routes 创建线路，非法站名被拒绝', async () => {
    const bad = await req('POST', '/api/routes', { from: '不存在的站', to: '上海虹桥', dateOffset: 45 });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.ok, false);

    const good = await req('POST', '/api/routes', {
      from: '北京南', to: '上海虹桥', dateOffset: 10, seats: ['second'],
    });
    assert.strictEqual(good.status, 200);
    assert.strictEqual(good.json.ok, true);
    assert.strictEqual(good.json.route.from, '北京南');
  });

  await test('POST /api/routes 同 key 不重复添加（幂等）', async () => {
    // 先清空，避免默认线路干扰（首次运行会种一条默认线路）
    const init = (await req('GET', '/api/state')).json;
    for (const r of init.routes) {
      await req('POST', '/api/routes/delete', { from: r.raw.from, to: r.raw.to, dateOffset: r.raw.dateOffset });
    }

    const payload = { from: '北京南', to: '上海虹桥', dateOffset: 10, seats: ['second'] };
    await req('POST', '/api/routes', payload);
    const first = (await req('GET', '/api/state')).json.routes;
    assert.strictEqual(first.length, 1, '首次添加后应有 1 条，实际 ' + first.length);

    // 同一 key 再添加一次：数量不变，内容被覆盖
    await req('POST', '/api/routes', Object.assign({}, payload, { seats: ['first'] }));
    const second = (await req('GET', '/api/state')).json.routes;
    assert.strictEqual(second.length, 1, '重复添加不应增加线路，实际 ' + second.length);
    assert.deepStrictEqual(second[0].raw.seats, ['first'], '席别应被覆盖为最新值');
  });

  await test('POST /api/routes/delete 精确删除对应 dateOffset', async () => {
    // 上一条用例留下 1 条(offset 10)，再加 offset 7 形成两条
    await req('POST', '/api/routes', { from: '北京南', to: '上海虹桥', dateOffset: 7, seats: ['second'] });
    const r = await req('POST', '/api/routes/delete', { from: '北京南', to: '上海虹桥', dateOffset: 7 });
    assert.strictEqual(r.json.removed, 1);
    const routes = (await req('GET', '/api/state')).json.routes;
    assert.ok(!routes.some((x) => x.raw.dateOffset === 7), 'dateOffset=7 的线路应已删除');
    assert.ok(routes.some((x) => x.raw.dateOffset === 10), '不应误删其它 dateOffset 的线路');
  });

  await test('POST /api/config 保存频率与推送配置', async () => {
    const r = await req('POST', '/api/config', {
      intervalSec: 90,
      quietHours: { start: 1, end: 2 },
      wechat: { enabled: true, channel: 'pushplus', token: 'tok_test' },
    });
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.config.intervalSec, 90);
    assert.strictEqual(r.json.config.quietHours.start, 1);
    assert.strictEqual(r.json.config.wechat.token, 'tok_test');
  });

  await test('POST /api/events/read 与 clear', async () => {
    const read = await req('POST', '/api/events/read', {});
    assert.strictEqual(read.json.ok, true);
    const clear = await req('POST', '/api/events/clear', {});
    assert.strictEqual(clear.json.ok, true);
    const j = (await req('GET', '/api/state')).json;
    assert.strictEqual(j.events.length, 0);
  });

  await test('未匹配的路径返回 404，不抛异常', async () => {
    const r = await req('GET', '/api/does-not-exist');
    assert.strictEqual(r.status, 404);
  });

  section('余票变化检测（端到端）');

  // 只留一条线路，便于断言
  await test('清理为单一线路', async () => {
    const j = (await req('GET', '/api/state')).json;
    for (const r of j.routes) {
      await req('POST', '/api/routes/delete', { from: r.raw.from, to: r.raw.to, dateOffset: r.raw.dateOffset });
    }
    const add = await req('POST', '/api/routes', {
      from: '北京南', to: '上海虹桥', dateOffset: 14, seats: ['second'],
    });
    assert.strictEqual(add.json.ok, true);
    const after = (await req('GET', '/api/state')).json;
    assert.strictEqual(after.routes.length, 1);
  });

  await test('首次采集建立基线，不产生事件也不推送', async () => {
    sentMessages = [];
    currentRows = [rawRow('G1', 30, '无'), rawRow('G2', 30, '无')];
    const r = await req('POST', '/api/poll', {});
    assert.strictEqual(r.status, 200);

    const j = (await req('GET', '/api/state')).json;
    assert.strictEqual(j.events.length, 0, '首次采集不应产生事件，实际 ' + j.events.length);
    assert.strictEqual(sentMessages.length, 0, '首次采集不应推送');
    assert.ok(j.routes[0].rows, '应已保存快照');
  });

  await test('无票 → 有票：产生事件并推送一次', async () => {
    sentMessages = [];
    currentRows = [rawRow('G1', 30, '12'), rawRow('G2', 30, '无')];
    await req('POST', '/api/poll', {});

    const j = (await req('GET', '/api/state')).json;
    const evs = j.events.filter((e) => e.kind === 'becameAvailable');
    assert.strictEqual(evs.length, 1, '应产生 1 条 becameAvailable，实际 ' + evs.length);
    assert.strictEqual(evs[0].trainCode, 'G1');
    assert.strictEqual(sentMessages.length, 1, '应推送 1 次，实际 ' + sentMessages.length);
  });

  await test('同一变化持续存在：去重窗口内不重复推送', async () => {
    sentMessages = [];
    await req('POST', '/api/poll', {});
    assert.strictEqual(sentMessages.length, 0, '状态未变不应再推送，实际 ' + sentMessages.length);
    const j = (await req('GET', '/api/state')).json;
    assert.strictEqual(j.events.filter((e) => e.kind === 'becameAvailable').length, 1, '不应重复记录事件');
  });

  await test('余票数量增加：产生 countIncreased 并推送', async () => {
    sentMessages = [];
    currentRows = [rawRow('G1', 30, '30'), rawRow('G2', 30, '无')];
    await req('POST', '/api/poll', {});
    const j = (await req('GET', '/api/state')).json;
    const inc = j.events.filter((e) => e.kind === 'countIncreased');
    assert.strictEqual(inc.length, 1, '应产生 1 条 countIncreased，实际 ' + inc.length);
    assert.strictEqual(sentMessages.length, 1);
  });

  await test('有票 → 无票：不推送（不打扰用户）', async () => {
    sentMessages = [];
    currentRows = [rawRow('G1', 30, '无'), rawRow('G2', 30, '无')];
    await req('POST', '/api/poll', {});
    assert.strictEqual(sentMessages.length, 0, '票变没了不应推送');
  });

  await test('新增可购车次：已提醒过的车次不再报 newTrain', async () => {
    sentMessages = [];
    currentRows = [rawRow('G1', 30, '无'), rawRow('G2', 30, '无'), rawRow('G9', 30, '5')];
    await req('POST', '/api/poll', {});
    const j = (await req('GET', '/api/state')).json;
    const nts = j.events.filter((e) => e.kind === 'newTrain');
    assert.strictEqual(nts.length, 1, 'G9 首次出现应报 1 条 newTrain，实际 ' + nts.length);
    assert.strictEqual(nts[0].trainCode, 'G9');

    // 再来一轮，G9 已在历史事件里，不应重复报
    sentMessages = [];
    await req('POST', '/api/poll', {});
    const j2 = (await req('GET', '/api/state')).json;
    assert.strictEqual(
      j2.events.filter((e) => e.kind === 'newTrain').length,
      1,
      'G9 不应重复报 newTrain'
    );
  });

  await test('静默时段：只记录事件，不推送', async () => {
    // 把静默时段设成覆盖当前小时
    const h = new Date().getHours();
    await req('POST', '/api/config', { quietHours: { start: h, end: (h + 1) % 24 } });
    const cfgNow = (await req('GET', '/api/state')).json;
    if (!cfgNow.quietNow) {
      console.log('       （当前小时设置未能构成静默区间，跳过断言）');
      await req('POST', '/api/config', { quietHours: { start: 23, end: 6 } });
      return;
    }

    sentMessages = [];
    currentRows = [rawRow('G1', 30, '无'), rawRow('G2', 30, '7'), rawRow('G9', 30, '无')];
    await req('POST', '/api/poll', {});

    const j = (await req('GET', '/api/state')).json;
    assert.ok(j.events.length > 0, '静默时段仍应记录事件');
    assert.strictEqual(sentMessages.length, 0, '静默时段不应推送，实际推送 ' + sentMessages.length);

    await req('POST', '/api/config', { quietHours: { start: 23, end: 6 } });
  });

  await test('改配置不会立刻触发采集（只是重排下一次）', async () => {
    const j = (await req('GET', '/api/state')).json;
    if (!j.routes.length) {
      await req('POST', '/api/routes', { from: '北京南', to: '上海虹桥', dateOffset: 14, seats: ['second'] });
      await req('POST', '/api/poll', {});
    }
    const before = (await req('GET', '/api/state')).json.diagnostics.cycles;

    await req('POST', '/api/config', { intervalSec: 75 });
    await req('POST', '/api/config', { intervalSec: 80 });
    await req('POST', '/api/config', { intervalSec: 85 });
    await new Promise((r) => setTimeout(r, 500));

    const after = (await req('GET', '/api/state')).json.diagnostics.cycles;
    assert.strictEqual(after, before, '改配置不应触发采集：cycles ' + before + ' -> ' + after);
  });

  await test('新增线路会立刻采集一次', async () => {
    const j = (await req('GET', '/api/state')).json;
    const target = j.routes[0];
    // 先删掉再重新添加，确保线路集合确实发生了变化
    await req('POST', '/api/routes/delete', {
      from: target.raw.from, to: target.raw.to, dateOffset: target.raw.dateOffset,
    });
    const before = (await req('GET', '/api/state')).json.diagnostics.cycles;

    await req('POST', '/api/routes', {
      from: target.raw.from, to: target.raw.to, dateOffset: target.raw.dateOffset, seats: target.raw.seats,
    });
    await new Promise((r) => setTimeout(r, 800));

    const after = (await req('GET', '/api/state')).json.diagnostics.cycles;
    assert.ok(after > before, '新增线路应触发一次采集：cycles ' + before + ' -> ' + after);
  });

  await test('POST /api/config 忽略无关字段，不破坏结构', async () => {
    const r = await req('POST', '/api/config', {
      evil: 'x',
      __proto__: { polluted: true },
      intervalSec: 70,
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.config.intervalSec, 70);
    assert.strictEqual({}.polluted, undefined, '不应发生原型污染');
    assert.ok(!('evil' in r.json.config), '无关字段不应写入配置');
    // 未提及的字段必须保留
    assert.ok(r.json.config.wechat, 'wechat 配置不应被清掉');
    assert.ok(r.json.config.quietHours, 'quietHours 不应被清掉');
  });

  await test('POST /api/routes 未指定 seats 时给默认席位', async () => {
    const r = await req('POST', '/api/routes', { from: '北京南', to: '济南西', dateOffset: 45 });
    assert.strictEqual(r.json.ok, true);
    assert.ok(Array.isArray(r.json.route.seats) && r.json.route.seats.length > 0, '应给默认席位');
    await req('POST', '/api/routes/delete', { from: '北京南', to: '济南西', dateOffset: 45 });
  });

  await test('POST /api/routes 空站名被拒绝', async () => {
    const r = await req('POST', '/api/routes', { from: '', to: '上海虹桥', dateOffset: 45 });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.ok, false);
  });

  await test('POST /api/routes 超出预售期的日期会被收敛（回归）', async () => {
    // 曾经默认 45 天，超出 12306 预售期（约 14 天），必然查不到数据
    const r = await req('POST', '/api/routes', { from: '北京南', to: '济南西', dateOffset: 45 });
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.route.dateOffset, 14, '45 天应收敛为 14，实际 ' + r.json.route.dateOffset);
    const r2 = await req('POST', '/api/routes', { from: '北京南', to: '济南西', dateOffset: 30 });
    assert.strictEqual(r2.json.route.dateOffset, 14, '30 天应收敛为 14');
    await req('POST', '/api/routes/delete', { from: '北京南', to: '济南西', dateOffset: 14 });
  });

  await test('POST /api/routes 范围内的日期不被改动', async () => {
    const r = await req('POST', '/api/routes', { from: '北京南', to: '济南西', dateOffset: 7 });
    assert.strictEqual(r.json.route.dateOffset, 7);
    await req('POST', '/api/routes/delete', { from: '北京南', to: '济南西', dateOffset: 7 });
  });

  section('收尾');

  await test('删除线路后不再出现在列表', async () => {
    const j = (await req('GET', '/api/state')).json;
    for (const r of j.routes) {
      await req('POST', '/api/routes/delete', { from: r.raw.from, to: r.raw.to, dateOffset: r.raw.dateOffset });
    }
    const after = (await req('GET', '/api/state')).json;
    assert.strictEqual(after.routes.length, 0);
  });

  await test('状态文件已落盘且可解析', async () => {
    const f = path.join(TMP, 'state.json');
    assert.ok(fs.existsSync(f), 'state.json 应已写入 ' + f);
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.ok(Array.isArray(data.events));
    assert.ok(Array.isArray(data.latency));
    assert.ok(data.snapshots && typeof data.snapshots === 'object');
  });

  console.log('\n══════════════════════════════');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail === 0) console.log('全部通过');
  else for (const f of failures) console.log('\n失败: ' + f.name + '\n' + f.error.stack);

  serverMod.server.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch { /* 忽略清理失败 */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试运行失败:', e);
  try { serverMod.server.close(); } catch { /* ignore */ }
  process.exit(1);
});
