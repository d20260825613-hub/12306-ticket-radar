'use strict';

/**
 * 真实数据源端到端验证。
 *
 * 与 test_e2e.js 的区别：那个用 stub 数据源验证逻辑，
 * 这个**真的调用第三方接口**，验证"用户刷新后能看到余票"这条链路。
 *
 * 会消耗平台额度（10 次/分钟），因此只跑少量请求。
 * 配置缺失时自动跳过。
 *
 * 用法: node tools/test_reallive.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

/** 找一份含 id/key 的配置。 */
function loadRealConfig() {
  const candidates = [
    'C:/Users/ADMIN/Desktop/\u4F59\u7968\u96F7\u8FBE/data/config.json',
    path.join(ROOT, 'data', 'config.json'),
  ];
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      const a = (cfg.dataSource || {}).apihz || {};
      if (a.id && a.key) return { cfg, from: p };
    } catch {
      /* 下一个 */
    }
  }
  return { cfg: null, from: null };
}

const { cfg: realCfg, from: cfgPath } = loadRealConfig();

if (!realCfg) {
  console.log('\n未找到含 id/key 的配置，跳过真实数据源测试。');
  console.log('（在设置里填入第三方数据源的 id/key 后会自动启用）\n');
  process.exit(0);
}

// 用一个临时数据目录起服务，不碰真实配置
const os = require('os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-real-'));
process.env.TICKET_RADAR_DATA = TMP;
process.env.NO_OPEN = '1';
process.env.PORT = String(42000 + Math.floor(Math.random() * 10000));
const PORT = Number(process.env.PORT);

// 写入我们的测试配置（真实数据源 + 一条 14 天内的线路）
const days = new Date(Date.now() + 10 * 86400000);
const date = `${days.getFullYear()}-${String(days.getMonth() + 1).padStart(2, '0')}-${String(days.getDate()).padStart(2, '0')}`;
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(
  path.join(TMP, 'config.json'),
  JSON.stringify({
    routes: [{ from: '北京南', to: '上海虹桥', dateOffset: 10, seats: ['second', 'first'] }],
    intervalSec: 300,
    dataSource: {
      provider: 'apihz',
      apihz: { id: realCfg.dataSource.apihz.id, key: realCfg.dataSource.apihz.key },
      fallbackToApihz: true,
      tryDirect: false,
    },
    autoOpenBrowser: false,
    httpPort: PORT,
  }, null, 2),
  'utf8'
);

const appSource = require(path.join(ROOT, 'src', 'core', 'providers', 'apihz.js'));
const stations = require(path.join(ROOT, 'src', 'core', 'stations.js'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

function get(p, method) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method || 'GET', timeout: 60000 }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        const t = Buffer.concat(c).toString('utf8');
        let j = null;
        try { j = JSON.parse(t); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: j, body: t });
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

(async () => {
  console.log('\n真实数据源端到端验证');
  console.log('  配置来源: ' + cfgPath);
  console.log('  测试数据: ' + TMP);
  console.log('  查询区间: 北京南 → 上海虹桥   日期: ' + date + '（10 天后）');
  console.log('');

  // ① 先确认 provider 层能拿到数据
  console.log('【① 直接调 provider】');
  const fromSt = stations.resolve('北京南');
  const toSt = stations.resolve('上海虹桥');
  const direct = await appSource.fetchTickets({
    date,
    from: fromSt.name,
    to: toSt.name,
    cfg: { apihz: { id: realCfg.dataSource.apihz.id, key: realCfg.dataSource.apihz.key } },
  });
  check('provider 取到余票数据', direct.ok, direct.error || '');
  if (direct.ok) {
    const withSeats = direct.rows.filter((r) =>
      Object.values(r.seats).some((s) => s && s.state === 'available')
    ).length;
    console.log(`       车次 ${direct.rows.length} 条，其中 ${withSeats} 条至少一个席位有票`);
  }

  // ② 再确认经服务端 /api/poll 能把数据落到快照
  console.log('\n【② 经服务端采集（模拟界面点「立即刷新」）】');
  const serverMod = require(path.join(ROOT, 'src', 'server.js'));
  serverMod.start();
  await new Promise((r) => setTimeout(r, 900));
  serverMod.engine.stop();

  const poll = await get('/api/poll', 'POST');
  check('/api/poll 成功', poll.status === 200, 'HTTP ' + poll.status);

  const state = await get('/api/state');
  check('/api/state 可读', !!state.json, state.error || '');

  if (state.json) {
    const r0 = state.json.routes[0];
    check('线路快照里有车次数据（这是"刷新能看到余票"的关键）',
      !!(r0 && r0.rows && r0.rows.length > 0),
      r0 ? ('rows=' + (r0.rows ? r0.rows.length : 'null')) : 'no route');

    if (r0 && r0.rows) {
      const hits = r0.rows.filter((x) =>
        Object.values(x.seats || {}).some((s) => s && s.state === 'available')
      ).length;
      check('有可购席位的车次 > 0', hits > 0, 'hits=' + hits);
      console.log(`       ${r0.rows.length} 趟车次，${hits} 趟有票`);
      const sample = r0.rows.slice(0, 3);
      for (const s of sample) {
        const seats = Object.entries(s.seats || {})
          .filter(([, v]) => v && v.state === 'available')
          .map(([k, v]) => k + v.text)
          .slice(0, 3)
          .join(' ');
        console.log(`         ${s.code} ${s.departTime}-${s.arriveTime}  ${seats}`);
      }
    }

    check('数据源判定为 apihz', state.json.dataSource && state.json.dataSource.active === 'apihz',
      state.json.dataSource ? String(state.json.dataSource.active) : 'n/a');
    check('诊断无残留错误', !state.json.diagnostics.lastError,
      String(state.json.diagnostics.lastError));
  }

  // ③ 日期超限必须被提前拦下并给可读提示
  console.log('\n【③ 日期超出预售期时的行为】');
  const far = new Date(Date.now() + 40 * 86400000);
  const farDate = `${far.getFullYear()}-${String(far.getMonth() + 1).padStart(2, '0')}-${String(far.getDate()).padStart(2, '0')}`;
  const clamped = appSource.clampDate(farDate);
  check('超限日期被收敛到 14 天内', clamped.clamped && clamped.date !== farDate,
    JSON.stringify(clamped));

  const farRes = await appSource.fetchTickets({
    date: farDate,
    from: fromSt.name,
    to: toSt.name,
    cfg: { apihz: { id: realCfg.dataSource.apihz.id, key: realCfg.dataSource.apihz.key } },
  });
  check('超限日期仍能取到数据（因为已自动收敛）', farRes.ok, farRes.error || '');
  if (farRes.ok) {
    console.log('       收敛后日期: ' + farRes.date + '，返回 ' + farRes.rows.length + ' 趟车次');
  }

  try { serverMod.server.close(); } catch { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('\n══════════════════════════════');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常:', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
