'use strict';

/**
 * 第三方数据源节点可用性诊断。
 *
 * 背景：平台文档写明"普通用户采用接口本地线路调用，成功率无保障"。
 * 实测会出现"查询失败，请重试"——说明本地节点在 12306 侧取数失败。
 *
 * 本工具做两件事：
 *   1. 问平台要当前最优节点列表（/getapi.php）
 *   2. 逐个节点试一次，看有几个能真正返回余票
 *
 * 目的是判断"多节点重试"能不能把免费档位的成功率救回来，
 * 以及给用户一个可操作的建议。
 *
 * 用法: node tools/probe_nodes.js <id> <key> [出发站] [到达站]
 */

const https = require('https');
const http = require('http');

const ID = process.argv[2] || '';
const KEY = process.argv[3] || '';
const FROM = process.argv[4] || '北京南';
const TO = process.argv[5] || '上海虹桥';

if (!ID || !KEY) {
  console.error('用法: node tools/probe_nodes.js <开发者ID> <开发者KEY> [出发站] [到达站]');
  process.exit(1);
}

const d = new Date(Date.now() + 7 * 86400000);
const Y = d.getFullYear();
const M = d.getMonth() + 1;
const DAY = d.getDate();

function fetchText(url, timeoutMs) {
  return new Promise((resolve) => {
    let mod;
    try {
      mod = url.startsWith('https') ? https : http;
    } catch (e) {
      return resolve({ error: e.message });
    }
    const t0 = Date.now();
    const req = mod.get(url, { timeout: timeoutMs || 20000, headers: { 'User-Agent': 'ticket-radar/0.1' } }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8'), ms: Date.now() - t0 }));
    });
    req.on('error', (e) => resolve({ error: e.message, ms: Date.now() - t0 }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout', ms: Date.now() - t0 }); });
  });
}

function parseJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

(async () => {
  console.log('');
  console.log(`第三方数据源节点诊断  ${FROM} → ${TO}  ${Y}-${M}-${DAY}`);
  console.log('');

  // 1) 平台推荐节点
  console.log('=== ① 平台推荐节点 (/getapi.php) ===');
  const rec = await fetchText('https://api.apihz.cn/getapi.php');
  if (rec.error) {
    console.log('  获取失败: ' + rec.error);
  } else {
    console.log('  HTTP ' + rec.status + '  ' + rec.ms + 'ms');
    const j = parseJson(rec.body);
    if (j) {
      console.log('  ' + JSON.stringify(j).slice(0, 600));
    } else {
      console.log('  非 JSON，前 300 字: ' + String(rec.body).slice(0, 300).replace(/\s+/g, ' '));
    }
  }

  // 2) 逐个节点实测
  const nodes = [
    'https://cn.apihz.cn/api/12306/api.php',
    'http://101.35.2.25/api/12306/api.php',
    'http://124.222.204.22/api/12306/api.php',
    'http://101.34.207.105/api/12306/api.php',
    'http://43.142.65.209/api/12306/api.php',
    'http://124.222.2.141/api/12306/api.php',
    'http://121.4.64.15/api/12306/api.php',
    'http://49.235.116.180/api/12306/api.php',
    'http://129.211.70.28/api/12306/api.php',
    'http://124.220.236.177/api/12306/api.php',
    'http://81.68.85.14/api/12306/api.php',
  ];

  console.log('');
  console.log('=== ② 逐节点实测（各发一次查询）===');
  const qs =
    `id=${encodeURIComponent(ID)}&key=${encodeURIComponent(KEY)}` +
    `&add=${encodeURIComponent(FROM)}&end=${encodeURIComponent(TO)}&y=${Y}&m=${M}&d=${DAY}`;

  let okCount = 0;
  const succeeded = [];

  for (const base of nodes) {
    const label = base.replace(/\/api\/12306.*/, '').replace(/^https?:\/\//, '');
    const r = await fetchText(`${base}?${qs}`);
    if (r.error) {
      console.log(`  ${label.padEnd(22)} 连接失败: ${r.error}`);
      continue;
    }
    const j = parseJson(r.body);
    if (!j) {
      console.log(`  ${label.padEnd(22)} HTTP ${r.status} 非 JSON: ${String(r.body).slice(0, 70)}`);
      continue;
    }
    if (j.code === 200 && Array.isArray(j.datas)) {
      okCount++;
      succeeded.push(label);
      const withSeats = j.datas.filter((t) => (t.seats || []).some((s) => s && Number(s.stock) !== 0)).length;
      console.log(`  ${label.padEnd(22)} ✅ 成功  ${j.datas.length} 趟车次，其中 ${withSeats} 趟有可购席位  (${r.ms}ms)`);
    } else {
      console.log(`  ${label.padEnd(22)} ✗ code=${j.code}  ${String(j.msg || '').slice(0, 60)}`);
    }
    // 平台限流 10 次/分钟，逐节点串行已经接近上限，留点余量
    await new Promise((res) => setTimeout(res, 1200));
  }

  console.log('');
  console.log('──────────────────────────────────────────');
  console.log(`可用节点: ${okCount} / ${nodes.length}`);
  if (okCount > 0) {
    console.log('成功节点: ' + succeeded.join(', '));
    console.log('');
    console.log('结论: 有节点能取到数据 —— 应该做多节点重试来提高成功率。');
  } else {
    console.log('');
    console.log('结论: 本次所有节点都失败。');
    console.log('  这符合平台对免费档位的说明："成功率无保障"。');
    console.log('  可行做法：');
    console.log('    · 再试几次（节点状态会变）');
    console.log('    · 在平台开通会员档位（文档称会用双通道模式提高成功率）');
    console.log('    · 或改用其它数据源');
  }
  console.log('');
})();
