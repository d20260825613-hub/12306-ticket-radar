'use strict';
/**
 * 枚举 12306 的公开只读数据入口，判断哪些在"纯 HTTP、不执行 JS"条件下仍可访问。
 * 目的是如实界定本工具的能力边界，而非寻找绕过手段。
 */
const https = require('https');
const zlib = require('zlib');

function get(path, headers) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.get({ host: 'kyfw.12306.cn', path, headers, timeout: 20000, agent: false }, (r) => {
      const c = [];
      r.on('data', (d) => c.push(d));
      r.on('end', () => {
        let buf = Buffer.concat(c);
        try {
          if (String(r.headers['content-encoding'] || '').includes('gzip')) buf = zlib.gunzipSync(buf);
        } catch { /* ignore */ }
        resolve({
          status: r.statusCode,
          loc: r.headers.location || '-',
          len: buf.length,
          body: buf.toString('utf8').slice(0, 150).replace(/\s+/g, ' '),
          setCookie: (r.headers['set-cookie'] || []).map((x) => x.split(';')[0]),
          ms: Date.now() - t0,
        });
      });
    });
    req.on('error', (e) => resolve({ err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ err: 'timeout' }); });
  });
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' };

(async () => {
  const init = await get('/otn/leftTicket/init', H);
  const ck = (init.setCookie || []).join('; ');
  const H2 = Object.assign({}, H, { Cookie: ck, Referer: 'https://kyfw.12306.cn/otn/leftTicket/init' });

  const targets = [
    ['静态:站名表', '/otn/resources/js/framework/station_name.js', H],
    ['静态:余票页', '/otn/leftTicket/init', H],
    ['查询地图(城市/车站)', '/otn/resources/js/framework/station_name.js', H],
    ['票价查询', '/otn/resources/js/query/ticket/price.js', H],
    ['query 发现入口', '/otn/leftTicket/query?leftTicketDTO.train_date=2026-11-02&leftTicketDTO.from_station=VNP&leftTicketDTO.to_station=AOH&purpose_codes=ADULT', H2],
    ['queryG 直连', '/otn/leftTicket/queryG?leftTicketDTO.train_date=2026-11-02&leftTicketDTO.from_station=VNP&leftTicketDTO.to_station=AOH&purpose_codes=ADULT', H2],
    ['queryO 直连', '/otn/leftTicket/queryO?leftTicketDTO.train_date=2026-11-02&leftTicketDTO.from_station=VNP&leftTicketDTO.to_station=AOH&purpose_codes=ADULT', H2],
    ['queryZ 直连', '/otn/leftTicket/queryZ?leftTicketDTO.train_date=2026-11-02&leftTicketDTO.from_station=VNP&leftTicketDTO.to_station=AOH&purpose_codes=ADULT', H2],
    ['queryA 直连', '/otn/leftTicket/queryA?leftTicketDTO.train_date=2026-11-02&leftTicketDTO.from_station=VNP&leftTicketDTO.to_station=AOH&purpose_codes=ADULT', H2],
    ['queryT 直连', '/otn/leftTicket/queryT?leftTicketDTO.train_date=2026-11-02&leftTicketDTO.from_station=VNP&leftTicketDTO.to_station=AOH&purpose_codes=ADULT', H2],
    ['queryX 直连', '/otn/leftTicket/queryX?leftTicketDTO.train_date=2026-11-02&leftTicketDTO.from_station=VNP&leftTicketDTO.to_station=AOH&purpose_codes=ADULT', H2],
    ['车次时刻表', '/otn/resources/js/query/TrainList.js', H],
    ['车站列表JSON', '/otn/resources/js/framework/station_name.js?v=1', H],
  ];

  for (const [label, path, headers] of targets) {
    const r = await get(path, headers);
    let note = '';
    if (r.err) note = 'ERR ' + r.err;
    else if (/error\.html/.test(r.loc)) note = '→ error.html 被拦';
    else if (r.status === 200) {
      try { const j = JSON.parse(r.body); note = 'JSON ' + JSON.stringify(Object.keys(j).slice(0, 6)); }
      catch { note = '非JSON文本'; }
    } else note = '→ ' + r.loc;
    console.log(`${label.padEnd(22)} ${String(r.status || '-').padStart(4)} ${String(r.ms || '-').padStart(5)}ms len=${String(r.len || 0).padStart(6)}  ${note}`);
    await new Promise((s) => setTimeout(s, 600));
  }
})();
