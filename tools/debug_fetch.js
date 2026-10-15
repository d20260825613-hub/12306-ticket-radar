'use strict';

/**
 * 直接调用项目自己的 apihz provider，复现"测试成功但采集失败"。
 *
 * 对比对象：tools/probe_nodes.js 直接打接口是能成功的。
 * 因此如果是本项目代码的问题，差异必然在这里暴露。
 *
 * 用法: node tools/debug_fetch.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const apihz = require(path.join(ROOT, 'src', 'core', 'providers', 'apihz'));
const stations = require(path.join(ROOT, 'src', 'core', 'stations'));

// 从桌面安装目录读真实配置（运行实例用的是那一份）
function loadConfig() {
  const candidates = [
    'C:/Users/ADMIN/Desktop/\u4F59\u7968\u96F7\u8FBE/data/config.json',
    path.join(ROOT, 'data', 'config.json'),
  ];
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      const a = (cfg.dataSource || {}).apihz || {};
      if (a.id && a.key) return { cfg: cfg.dataSource, from: p };
    } catch {
      /* 下一个 */
    }
  }
  return { cfg: null, from: null };
}

(async () => {
  const { cfg, from } = loadConfig();
  if (!cfg) {
    console.log('找不到含 id/key 的配置');
    process.exit(1);
  }
  console.log('配置来源: ' + from);
  console.log('  provider = ' + cfg.provider);
  console.log('  id = ' + String(cfg.apihz.id).slice(0, 3) + '***');
  console.log('  key = ' + String(cfg.apihz.key).slice(0, 2) + '***');
  console.log('  endpoint = ' + JSON.stringify(cfg.apihz.endpoint));
  console.log('  ready() = ' + apihz.ready(cfg));
  console.log('');

  const fromSt = stations.resolve('北京南');
  const toSt = stations.resolve('上海虹桥');
  const d = new Date(Date.now() + 7 * 86400000);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  console.log('=== 调用 provider.fetchTickets（模拟引擎的调用方式）===');
  console.log('  区间: ' + fromSt.name + ' → ' + toSt.name + '   日期: ' + date);
  console.log('');

  const res = await apihz.fetchTickets({
    date,
    from: fromSt.name,
    to: toSt.name,
    cfg,
  });

  console.log('  返回: ok=' + res.ok);
  if (res.ok) {
    console.log('  ✅ 成功，车次 ' + res.rows.length + ' 条，来源节点 ' + (res.endpoint || '?'));
    const sample = res.rows.slice(0, 3);
    for (const r of sample) {
      const seats = r.seatList.filter((s) => s.state === 'available').map((s) => s.short + s.text).join(' ');
      console.log('     ' + r.code + ' ' + r.departTime + '-' + r.arriveTime + '  ' + (seats || '（无票）'));
    }
  } else {
    console.log('  ✗ 失败: ' + res.error);
  }
  console.log('');

  // 再做一次，确认是否偶发
  console.log('=== 连续 3 次，看是否偶发 ===');
  for (let i = 1; i <= 3; i++) {
    const r = await apihz.fetchTickets({ date, from: fromSt.name, to: toSt.name, cfg });
    console.log(`  第 ${i} 次: ${r.ok ? '成功 ' + r.rows.length + ' 条' : '失败 — ' + r.error}`);
    await new Promise((x) => setTimeout(x, 1500));
  }
  console.log('');
})();
