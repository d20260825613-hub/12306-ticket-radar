'use strict';
/**
 * 复现第二跳：发现了端点名之后，怎样请求才不会被踢到 error.html。
 * 对比 Referer、Cookie 处理、Connection 头的差异。
 */
const https = require('https');

function get(path, headers) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.get({ host: 'kyfw.12306.cn', path, headers, timeout: 20000, agent: false }, (r) => {
      const c = [];
      r.on('data', (d) => c.push(d));
      r.on('end', () =>
        resolve({
          status: r.statusCode,
          loc: r.headers.location || '-',
          len: Buffer.concat(c).length,
          body: Buffer.concat(c).toString('utf8').slice(0, 160).replace(/\s+/g, ' '),
          setCookie: (r.headers['set-cookie'] || []).map((x) => x.split(';')[0]),
          ms: Date.now() - t0,
        })
      );
    });
    req.on('error', (e) => resolve({ err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ err: 'timeout' }); });
  });
}

const QS = 'leftTicketDTO.train_date=2026-11-02&leftTicketDTO.from_station=VNP&leftTicketDTO.to_station=AOH&purpose_codes=ADULT';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function jarFrom(list) {
  const m = new Map();
  for (const raw of list || []) {
    const p = String(raw).split(';')[0].trim();
    const i = p.indexOf('=');
    if (i > 0) m.set(p.slice(0, i), p.slice(i + 1));
  }
  return m;
}
function jarHeader(m) {
  return [...m.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

(async () => {
  const init = await get('/otn/leftTicket/init', { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' });
  const jar = jarFrom(init.setCookie);
  console.log('init cookies:', jarHeader(jar));

  const disc = await get('/otn/leftTicket/query?' + QS, {
    'User-Agent': UA, Accept: '*/*', Referer: 'https://kyfw.12306.cn/otn/leftTicket/init', Cookie: jarHeader(jar),
  });
  // 合并发现阶段可能下发的 cookie
  for (const [k, v] of jarFrom(disc.setCookie)) jar.set(k, v);
  const locPath = disc.loc.startsWith('http') ? new URL(disc.loc).pathname + new URL(disc.loc).search : '/otn/leftTicket/' + disc.loc;
  console.log('发现阶段:', disc.status, '→', locPath);
  console.log('');

  const variants = [
    ['A 仅 Referer=init', { Referer: 'https://kyfw.12306.cn/otn/leftTicket/init' }],
    ['B Referer=query(发现页)', { Referer: 'https://kyfw.12306.cn/otn/leftTicket/query?' + QS }],
    ['C 无 Referer', {}],
    ['D Referer=init + X-Requested-With', { Referer: 'https://kyfw.12306.cn/otn/leftTicket/init', 'X-Requested-With': 'XMLHttpRequest' }],
    ['E 完整浏览器头', {
      Referer: 'https://kyfw.12306.cn/otn/leftTicket/init',
      Origin: 'https://kyfw.12306.cn',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
    }],
  ];

  for (const [label, extra] of variants) {
    const r = await get(locPath, Object.assign({
      'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'gzip, deflate', Connection: 'keep-alive',
      Cookie: jarHeader(jar),
    }, extra));
    let verdict = '?';
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        verdict = Array.isArray(j && j.data && j.data.result) ? `OK 车次=${j.data.result.length}` : 'JSON但无result';
      } catch { verdict = '非JSON'; }
    } else if (/error\.html/.test(r.loc)) verdict = '被踢到 error.html';
    console.log(`${label.padEnd(28)} ${r.status} ${String(r.ms).padStart(4)}ms len=${String(r.len).padStart(6)} ${verdict}`);
    await new Promise((s) => setTimeout(s, 700));
  }
})();
