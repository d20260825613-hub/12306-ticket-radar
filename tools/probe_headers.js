'use strict';
/**
 * 最小复现：对比不同请求头组合下 /otn/leftTicket/query 的返回。
 * 用于定位 12306 的拦截条件（不要在生产路径里使用本文件的写法）。
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
          body: Buffer.concat(c).toString('utf8').slice(0, 130).replace(/\s+/g, ' '),
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

(async () => {
  // 场景 1：与最早成功探针完全一致 —— 无 Cookie，头部极简，跟着 302 走
  console.log('--- 场景1: 极简头 + 无 Cookie ---');
  const init = await get('/otn/leftTicket/init', { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' });
  console.log('init:', init.status, 'cookies=', (init.setCookie || []).join(' ; '));
  const ck = (init.setCookie || []).join('; ');

  const t1 = await get('/otn/leftTicket/query?' + QS, {
    'User-Agent': UA, Accept: '*/*', Referer: 'https://kyfw.12306.cn/otn/leftTicket/init', Cookie: ck,
  });
  console.log('query:', t1.status, t1.ms + 'ms', 'loc=', t1.loc, 'len=', t1.len);
  console.log('  body:', t1.body);

  // 场景 2：带 RAIL_DEVICEID 等浏览器指纹头
  console.log('\n--- 场景2: 补充浏览器指纹头 ---');
  const dev = 'x'.repeat(40);
  const t2 = await get('/otn/leftTicket/query?' + QS, {
    'User-Agent': UA, Accept: '*/*', Referer: 'https://kyfw.12306.cn/otn/leftTicket/init', Cookie: ck,
    'RAIL_DEVICEID': dev, 'RAIL_EXPIRATION': String(Date.now() + 86400000),
  });
  console.log('query:', t2.status, t2.ms + 'ms', 'loc=', t2.loc, 'len=', t2.len);
  console.log('  body:', t2.body);

  // 场景 3：直接打 queryG
  console.log('\n--- 场景3: 直接打 queryG ---');
  const t3 = await get('/otn/leftTicket/queryG?' + QS, {
    'User-Agent': UA, Accept: '*/*', Referer: 'https://kyfw.12306.cn/otn/leftTicket/init', Cookie: ck,
  });
  console.log('queryG:', t3.status, t3.ms + 'ms', 'loc=', t3.loc, 'len=', t3.len);
  console.log('  body:', t3.body);

  // 场景 4：完全无 Cookie
  console.log('\n--- 场景4: 无 Cookie ---');
  const t4 = await get('/otn/leftTicket/query?' + QS, {
    'User-Agent': UA, Accept: '*/*', Referer: 'https://kyfw.12306.cn/otn/leftTicket/init',
  });
  console.log('query:', t4.status, t4.ms + 'ms', 'loc=', t4.loc, 'len=', t4.len);
  console.log('  body:', t4.body);
})();
