'use strict';

/**
 * 席位字段映射实证工具（开发用，不参与运行时）。
 *
 * 目的：验证 parser.js 里 SEAT_FIELDS 的下标是否正确。
 *
 * 方法：利用一个硬约束 —— 同一趟车在"全程区间"和"短区间"上，
 * 各席位的余票状态必然不同（短区间通常有票、全程通常无票）。
 * 如果某个下标在短区间有票、全程无票，它就是真实存在的席别字段；
 * 再把它的取值和已知的铁路常识对照，即可定位席位名。
 *
 * 用法: node tools/verify_seats.js
 */

const client = require('../src/core/client');
const parser = require('../src/core/parser');
const stations = require('../src/core/stations');

const INDEX_MIN = 20;
const INDEX_MAX = 34;

function pad(s, n) {
  const str = String(s);
  // 中文按 2 宽度粗略对齐
  const width = [...str].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, n - width));
}

async function fetchRoute(date, fromInput, toInput) {
  const from = stations.resolve(fromInput);
  const to = stations.resolve(toInput);
  if (!from || !to) return { error: `站点无法解析: ${fromInput} / ${toInput}` };

  const session = await client.openSession();
  if (!session.cookie) return { error: `会话建立失败: ${session.error}` };

  const res = await client.queryTickets({
    date,
    fromCode: from.code,
    toCode: to.code,
    session,
    minIntervalMs: 1200,
  });
  if (!res.ok) return { error: res.error };

  return { from, to, rows: parser.parseRows(res.rows, res.map), map: res.map, endpoint: res.endpoint, timing: res.timing };
}

async function main() {
  const date = process.argv[2] || nextDate(45);

  // 京沪高铁全程 + 短区间：同车次状态差异可定位席别字段
  const cases = [
    ['京沪全程', '北京南', '上海虹桥'],
    ['京沪短区间', '北京南', '济南西'],
    ['京沪中途', '北京南', '南京南'],
    ['普速长途', '北京', '广州'],
    ['普速短途', '北京', '石家庄'],
  ];

  console.log(`日期: ${date}\n`);

  const byCode = new Map();

  for (const [label, from, to] of cases) {
    let r;
    try {
      r = await fetchRoute(date, from, to);
    } catch (e) {
      console.log(`[${label}] 异常: ${e.message}`);
      continue;
    }
    if (r.error) {
      console.log(`[${label}] 失败: ${r.error}`);
      continue;
    }

    console.log(`===== ${label}  ${r.from.name}→${r.to.name}  端点=${r.endpoint}  车次=${r.rows.length}  =====`);
    for (const row of r.rows) {
      if (!byCode.has(row.code)) byCode.set(row.code, []);
      byCode.get(row.code).push({ label, row });
    }
    // 打印前 6 趟车的原始下标取值
    for (const row of r.rows.slice(0, 6)) {
      const cells = [];
      for (let i = INDEX_MIN; i <= INDEX_MAX; i++) {
        const v = row.raw[i];
        if (v === '' || v === undefined) continue;
        cells.push(`${i}=${v}`);
      }
      console.log(`  ${pad(row.code, 7)} ${row.departTime}-${row.arriveTime}  ${cells.join('  ')}`);
    }
    console.log('');
    await new Promise((res) => setTimeout(res, 1200));
  }

  // 交叉比对：同一车次在长/短区间上的差异
  console.log('===== 同车次跨区间差异（用于定位席别） =====');
  let shown = 0;
  for (const [code, entries] of byCode) {
    if (entries.length < 2 || shown >= 8) continue;
    const row = entries[0].row;
    const line = [];
    for (let i = INDEX_MIN; i <= INDEX_MAX; i++) {
      const vals = entries.map((e) => (e.row.raw[i] === '' ? '·' : e.row.raw[i]));
      const uniq = [...new Set(vals)];
      if (uniq.length > 1 || (uniq[0] !== '·' && uniq[0] !== '无')) {
        line.push(`${i}[${entries.map((e) => e.label.slice(0, 4)).join('/')}]=${vals.join('/')}`);
      }
    }
    if (!line.length) continue;
    console.log(`  ${pad(code, 7)} ${line.join('  ')}`);
    shown++;
  }

  console.log('\n===== 当前 parser.js 的映射（需与上面实证结果核对） =====');
  for (const def of parser.SEAT_FIELDS) {
    console.log(`  idx ${String(def.idx).padStart(2)}  ${pad(def.name, 12)} ${def.key}`);
  }
}

function nextDate(days) {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

main().catch((e) => {
  console.error('诊断失败:', e);
  process.exit(1);
});
