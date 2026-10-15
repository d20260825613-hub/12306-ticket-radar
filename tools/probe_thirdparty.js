'use strict';

/**
 * 实测第三方余票数据源（接口盒子 apihz.cn）。
 *
 * 目的：确认这条合法路径是否真的可用，返回结构是否如文档所述。
 *
 * 关于合规：该平台明确说明"不传 ck 则使用平台提供的 cookie"，
 * 即取数行为与合规责任由平台承担；使用者只需注册自己的 id/key。
 * 这里只用公开的演示 id/key 做连通性验证，不涉及任何绕过手段。
 *
 * 用法: node tools/probe_thirdparty.js [出发站] [到达站] [天数]
 */

const http = require('http');
const https = require('https');

const FROM = process.argv[2] || '北京南';
const TO = process.argv[3] || '上海虹桥';
const AHEAD = Number(process.argv[4] || 7);

const d = new Date(Date.now() + AHEAD * 86400000);
const Y = d.getFullYear();
const M = d.getMonth() + 1;
const D = d.getDate();

/** GET 并返回文本，兼容 http / https。 */
function fetchText(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const t0 = Date.now();
    const req = mod.get(url, { timeout: 20000, headers: { 'User-Agent': 'ticket-radar/0.1' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          ms: Date.now() - t0,
        })
      );
    });
    req.on('error', (e) => resolve({ error: e.message, ms: Date.now() - t0 }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout', ms: Date.now() - t0 });
    });
  });
}

/** 座位余票语义：-1 充足 / 0 无票 / >0 具体张数 */
function stockText(n) {
  if (n === -1 || n === '-1') return '有（充足）';
  if (n === 0 || n === '0') return '无票';
  const v = Number(n);
  if (Number.isFinite(v)) return `有 ${v} 张`;
  return String(n);
}

(async () => {
  const qs =
    `id=88888888&key=88888888` +
    `&add=${encodeURIComponent(FROM)}&end=${encodeURIComponent(TO)}` +
    `&y=${Y}&m=${M}&d=${D}`;

  const hosts = [
    'https://cn.apihz.cn/api/12306/api.php',
    'http://101.35.2.25/api/12306/api.php',
    'http://124.222.204.22/api/12306/api.php',
  ];

  console.log('');
  console.log('第三方余票数据源连通性测试');
  console.log(`  平台: 接口盒子 apihz.cn`);
  console.log(`  区间: ${FROM} → ${TO}`);
  console.log(`  日期: ${Y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}（${AHEAD} 天后）`);
  console.log('');

  let worked = false;

  for (const base of hosts) {
    const url = `${base}?${qs}`;
    process.stdout.write(`  ${base.replace(/\/api\/12306.*/, '')} … `);
    const r = await fetchText(url);

    if (r.error) {
      console.log(`连接失败: ${r.error} (${r.ms}ms)`);
      continue;
    }

    let j = null;
    try {
      j = JSON.parse(r.body);
    } catch {
      console.log(`HTTP ${r.status} 非 JSON: ${r.body.slice(0, 120)}`);
      continue;
    }

    console.log(`HTTP ${r.status}  code=${j.code}  msg=${j.msg || ''}  ${r.ms}ms`);

    if (j.code === 200 && Array.isArray(j.datas)) {
      worked = true;
      console.log('');
      console.log(`  ✅ 成功拿到 ${j.datas.length} 趟车次（模式: ${j.td || '未知'}）`);
      console.log('');

      // 打印前 6 趟，验证字段与文档一致
      const head = j.datas.slice(0, 6);
      console.log('  车次     出发      到达      历时    可购席位');
      console.log('  ─────────────────────────────────────────────────────────');
      for (const t of head) {
        const seats = (t.seats || [])
          .filter((s) => s && s.stock !== 0 && s.stock !== '0')
          .map((s) => `${s.type.replace(/\(.*?\)/g, '')}${stockText(s.stock)}`)
          .slice(0, 4)
          .join(' ');
        console.log(
          `  ${String(t.train_number).padEnd(8)} ${String(t.depart_time).padEnd(9)} ` +
            `${String(t.arrive_time).padEnd(9)} ${String(t.duration).padEnd(7)} ${seats || '（全部无票）'}`
        );
      }
      console.log('');
      console.log('  字段自检:');
      const t0 = j.datas[0];
      for (const k of ['train_number', 'train_order', 'depart_index', 'arrive_index',
        'depart_name', 'arrive_name', 'depart_code', 'arrive_code',
        'depart_time', 'arrive_time', 'duration', 'seatcode', 'date', 'seats']) {
        const has = t0[k] !== undefined;
        console.log(`    ${has ? 'ok  ' : 'MISS'} ${k}${has ? ' = ' + JSON.stringify(t0[k]).slice(0, 60) : ''}`);
      }
      break;
    }

    if (j.code === 400) {
      console.log(`    → 参数/鉴权问题: ${j.msg}`);
      console.log('    （演示 key 88888888 可能已限流；注册自己的 id/key 后即可用）');
    }
  }

  console.log('');
  console.log('──────────────────────────────────────────');
  if (worked) {
    console.log('结论: 该数据源可用，返回结构与文档一致。');
    console.log('      接入后本工具即可真正显示余票。');
  } else {
    console.log('结论: 本次未取到数据。');
    console.log('      公开演示 key 通常会被限流 —— 需要用你自己的 id/key 再测。');
    console.log('      注册地址: https://www.apihz.cn/user/ （免费，10 次/分钟，每日无上限）');
  }
  console.log('');
})();
