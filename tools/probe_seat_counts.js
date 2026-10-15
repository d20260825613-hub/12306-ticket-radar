'use strict';

/**
 * 检查第三方数据源是否返回"具体余票数量"。
 *
 * 背景：平台文档说 stock 语义是 -1 有票充足 / 0 无票 / >0 余票张数。
 * 如果实际总是返回 -1，那界面就只能显示"有"，无法显示"有(12)"——
 * 这决定了"显示剩余票数量"这个需求能做到什么程度。
 *
 * 用法: node tools/probe_seat_counts.js
 */

const fs = require('fs');
const path = require('path');

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

function dateAfter(n) {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

(async () => {
  const cfg = loadCfg();
  if (!cfg) {
    console.log('未找到含 id/key 的配置');
    process.exit(1);
  }

  const routes = [
    ['北京南', '上海虹桥'],
    ['长沙', '成都'],
  ];

  for (const [from, to] of routes) {
    const r = await apihz.fetchTickets({ date: dateAfter(10), from, to, cfg });
    console.log('');
    if (!r.ok) {
      console.log(`=== ${from} → ${to} 失败: ${r.error}`);
      continue;
    }

    console.log(`=== ${from} → ${to}  共 ${r.rows.length} 趟 ===`);

    // 席位取值分布
    const dist = new Map();
    let numeric = 0;
    let unknown = 0;
    for (const row of r.rows) {
      for (const s of Object.values(row.seats)) {
        if (s.state === 'unknown') continue;
        if (s.state === 'available' && s.count === null) unknown++;
        if (s.state === 'available' && s.count !== null) numeric++;
        const label = s.state === 'available' ? (s.count === null ? '有（数量未知）' : `有(${s.count})`) : s.state;
        dist.set(label, (dist.get(label) || 0) + 1);
      }
    }

    console.log('  席位取值分布:');
    for (const [k, v] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
      console.log('    ' + k.padEnd(18) + v + ' 次');
    }

    console.log('');
    console.log(`  带具体数量的席位: ${numeric} 个`);
    console.log(`  只知"有票"无数量: ${unknown} 个`);

    console.log('');
    console.log('  样例（有具体数量的车次）:');
    let shown = 0;
    for (const row of r.rows) {
      const nums = Object.entries(row.seats).filter(([, s]) => s.state === 'available' && s.count !== null);
      if (!nums.length || shown >= 6) continue;
      console.log('    ' + row.code.padEnd(7) + nums.map(([k, s]) => `${k}=${s.count}`).join('  '));
      shown++;
    }
    if (!shown) console.log('    （无）');
  }

  console.log('');
})();
