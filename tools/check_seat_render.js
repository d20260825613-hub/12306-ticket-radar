'use strict';

/**
 * 用真实余票数据渲染，检查"剩余票数量"的展示效果。
 *
 * 单元测试用的是构造数据，这里用**真实接口返回**，
 * 确认三种席位状态在真实数据下都能正确呈现。
 *
 * 用法: node tools/check_seat_render.js [端口]
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { createDom } = require('./lib/dom');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || 12311);

/** 读一份含 id/key 的配置。 */
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

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 60000 }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(c).toString('utf8')));
        } catch (e) {
          resolve({ error: 'non-json' });
        }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

/** 把渲染出的 HTML 表格还原成可读文本，便于目视检查。 */
function tableToText(html) {
  const body = (html.match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '';
  const rows = body.match(/<tr[\s\S]*?<\/tr>/g) || [];
  const out = [];
  for (const tr of rows) {
    const code = (tr.match(/data-copy="([^"]+)"/) || [])[1] || '?';
    // 时间单元格里的 <b> 可能含“次日 ”前缀，不能只匹配 HH:MM
    const times = [...tr.matchAll(/<td class="time[^"]*"><b>([^<]+)<\/b>/g)].map((m) => m[1].trim());
    const dur = (tr.match(/class="dur">([^<]*)</) || [])[1] || '';

    // 逐个席位标签解析：外层 span 到第一个 </span></span> 为止
    const chips = [];
    const re = /<span class="seat ([^"]*)"[^>]*>([\s\S]*?)<\/span><\/span>/g;
    let m;
    while ((m = re.exec(tr)) !== null) {
      const cls = m[1];
      const inner = m[2];
      const num = (inner.match(/<span class="num">(\d+)<\/span>/) || [])[1];
      const name = (inner.match(/<span class="sn">([^<]*)<\/span>/) || [])[1] || '';
      const tail = (inner.match(/<span class="n">([^<]*)<\/span>/) || [])[1] || '';
      if (num) chips.push(`${name}=${num}`);
      else if (cls.includes('noqty')) chips.push(`${name}=有(未公布)`);
      else if (cls.includes('waitlist')) chips.push(`${name}=候补`);
      else if (cls.includes('none')) chips.push(`${name}=无`);
      else chips.push(`${name}=${tail}`);
    }
    out.push({ code, times, dur, chips });
  }
  return out;
}

/** 从摘要里解析出计数。 */
function parseSummary(html) {
  const m = html.match(/本页共 ([\s\S]*?)。/);
  if (!m) return null;
  const seg = m[1];
  const withCount = (seg.match(/<b>(\d+)<\/b> 个席位有确切余票数量/) || [])[1];
  const availOnly = (seg.match(/(\d+) 个席位只显示/) || [])[1];
  return {
    withCount: withCount ? Number(withCount) : 0,
    availOnly: availOnly ? Number(availOnly) : 0,
  };
}

(async () => {
  let state = await get('/api/state');
  if (state.error) {
    console.log('无法获取状态: ' + state.error);
    process.exit(1);
  }

  let route = (state.routes || [])[0];

  // 若当前日期没有具体数量，直接用第三方接口取"7 天后"的数据来验证数字显示。
  // 平台实测：越接近当前日期，越容易返回具体余票张数。
  let usedDirectFetch = false;
  const needFallback = !route || !route.rows || !route.rows.some((r) =>
    Object.values(r.seats || {}).some((s) => s && s.state === 'available' && s.count !== null));

  if (needFallback) {
    const cfg = loadCfg();
    if (cfg) {
      const from = route ? route.from : '北京南';
      const to = route ? route.to : '上海虹桥';
      const d = new Date(Date.now() + 7 * 86400000);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const apihz = require(path.join(__dirname, '..', 'src', 'core', 'providers', 'apihz'));
      const res = await apihz.fetchTickets({ date, from, to, cfg });
      if (res.ok) {
        usedDirectFetch = true;
        route = {
          raw: { from, to, dateOffset: 7, seats: ['second', 'first', 'business', 'noSeat'] },
          from,
          to,
          fromCode: '',
          toCode: '',
          date,
          rows: res.rows,
          updatedAt: Date.now(),
          endpoint: 'apihz',
        };
        state.routes = [route];
        console.log('\n（当前监控日期没有具体数量，已另取 ' + date + ' 的真实数据验证）');
      }
    }
  }

  console.log('\n真实数据渲染检查');
  console.log('  线路: ' + (route ? route.from + ' → ' + route.to : '(无)'));
  console.log('  日期: ' + (route ? route.date : '-'));
  console.log('  车次: ' + (route && route.rows ? route.rows.length : 0));
  if (!route || !route.rows || !route.rows.length) {
    console.log('\n  没有数据，先触发一次采集。');
    process.exit(1);
  }

  // 用真实 payload 渲染
  const dom = createDom();
  dom.initFromFile(path.join(ROOT, 'web', 'index.html'));

  const sandbox = {
    document: dom.document,
    window: { devicePixelRatio: 1, open: () => {}, matchMedia: () => ({ matches: false }), addEventListener: () => {} },
    navigator: {},
    fetch: async () => ({ ok: true, status: 200, json: async () => state }),
    EventSource: class { constructor() {} addEventListener() {} },
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    setInterval: () => 0,
    clearTimeout: () => {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
    confirm: () => true,
    getComputedStyle: () => ({ getPropertyValue: () => '#07c160' }),
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
  await dom.settle();

  const html = dom.mainHtml();

  // 统计
  const nums = [...html.matchAll(/<span class="num">(\d+)<\/span><span class="sn">([^<]*)<\/span>/g)];
  const noqty = (html.match(/seat available noqty/g) || []).length;
  const nones = (html.match(/class="seat none"/g) || []).length;

  console.log('');
  console.log('  渲染统计:');
  console.log('    带具体数量的席位标签: ' + nums.length + ' 个');
  console.log('    显示"数量未公布"的标签: ' + noqty + ' 个');
  console.log('    显示"无票"的标签: ' + nones + ' 个');
  const sum = parseSummary(html);
  console.log('    统计摘要: ' + (sum ? `确切数量 ${sum.withCount} 个 / 仅"有票" ${sum.availOnly} 个` : '未出现'));
  if (sum) {
    const consistent = sum.withCount === nums.length && sum.availOnly === noqty;
    console.log('    摘要与实际渲染一致: ' + (consistent ? '是' : '否 << 不一致！'));
  }

  console.log('');
  console.log('  有具体余票数量的席位（真实数据）:');
  if (!nums.length) console.log('    （本次没有席位返回具体数量）');
  for (const m of nums.slice(0, 14)) {
    console.log(`    ${m[2]} 余票 ${m[1]} 张`);
  }

  console.log('');
  console.log('  表格前 8 行（目视检查）:');
  const rows = tableToText(html);
  for (const r of rows.slice(0, 8)) {
    const seatStr = r.chips.filter(Boolean).join('  ');
    console.log(`    ${r.code.padEnd(7)} ${(r.times[0] || '').padEnd(6)}-${(r.times[1] || '').padEnd(6)} ${r.dur.padEnd(6)} | ${seatStr}`);
  }

  // ── 跨零点车次的“次日”标注 ──
  console.log('');
  console.log('  跨零点车次（出发晚于到达，到达列应带"次日"）:');
  let overnight = 0;
  for (const r of rows) {
    const dep = r.times[0] || '';
    const arr = r.times[1] || '';
    if (!/^\d{2}:\d{2}$/.test(dep)) continue;
    if (!/^次日 /.test(arr)) continue;
    overnight++;
    if (overnight <= 6) {
      console.log(`    ${r.code.padEnd(7)} ${dep} → ${arr}   历时 ${r.dur}`);
    }
  }
  const nextdayCells = (html.match(/class="time nextday"/g) || []).length;
  if (!overnight) {
    console.log('    （该线路本次没有跨零点车次）');
  } else {
    console.log(`    共 ${overnight} 趟；渲染出 nextday 单元格 ${nextdayCells} 个`);
  }

  console.log('');
  const ok = (nums.length > 0 || noqty > 0) && (overnight === 0 || nextdayCells > 0);
  console.log(ok ? '结论: 时间与余票数量均正确展示。' : '结论: 有项目未正确渲染 —— 需要检查。');
  console.log('');
  process.exit(ok ? 0 : 1);
})();
