'use strict';

/**
 * 数据源可达性诊断。
 *
 * 目的：回答一个非常实际的问题 —— "现在还有没有办法拿到 12306 的余票数据？"
 *
 * 逐一探测 12306 的公开只读入口，如实报告哪些还通、哪些被拦，
 * 不做任何绕过尝试（不逆向 JS 校验、不伪造指纹）。
 *
 * 用法: node tools/probe_datasource.js [出发站] [到达站] [日期]
 */

const https = require('https');
const zlib = require('zlib');

const FROM = process.argv[2] || '北京南';
const TO = process.argv[3] || '上海虹桥';
const DATE = process.argv[4] || nextDate(45);

function nextDate(days) {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const stations = require('../src/core/stations');

const from = stations.resolve(FROM);
const to = stations.resolve(TO);

if (!from || !to) {
  console.error(`站点无法解析: ${FROM} / ${TO}`);
  process.exit(1);
}

const QS =
  `leftTicketDTO.train_date=${DATE}` +
  `&leftTicketDTO.from_station=${from.code}` +
  `&leftTicketDTO.to_station=${to.code}` +
  '&purpose_codes=ADULT';

/** 单次 GET，不跟随跳转，便于观察 302 目标。 */
function probe(path, cookie) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.get(
      {
        host: 'kyfw.12306.cn',
        path,
        agent: false,
        timeout: 15000,
        headers: Object.assign(
          {
            'User-Agent': UA,
            Accept: '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate',
            Referer: 'https://kyfw.12306.cn/otn/leftTicket/init',
          },
          cookie ? { Cookie: cookie } : {}
        ),
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          try {
            const enc = String(res.headers['content-encoding'] || '');
            if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
            else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
          } catch {
            /* 用原始字节 */
          }
          resolve({
            status: res.statusCode,
            location: res.headers.location || '',
            setCookie: res.headers['set-cookie'] || [],
            body: buf.toString('utf8'),
            bytes: buf.length,
            ms: Date.now() - t0,
          });
        });
      }
    );
    req.on('error', (e) => resolve({ error: e.message, ms: Date.now() - t0 }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout', ms: Date.now() - t0 });
    });
  });
}

/** 把响应归纳成一句话。 */
function describe(r) {
  if (r.error) return `连接失败: ${r.error}`;
  if (r.status === 302 || r.status === 301 || r.status === 307) {
    const loc = r.location || '';
    if (/error\.html|\/mormhweb\//i.test(loc)) return '被拦（跳到错误页）';
    let endpoint = '';
    try {
      const j = JSON.parse(r.body);
      if (j && j.c_url) endpoint = j.c_url;
    } catch {
      /* 非 JSON */
    }
    if (!endpoint && loc) {
      const m = loc.match(/leftTicket\/(query[A-Z]?)/);
      if (m) endpoint = m[1];
    }
    return `302 端点轮换${endpoint ? ' → ' + endpoint : ''}`;
  }
  if (r.status !== 200) return `HTTP ${r.status}`;
  if (/^\s*[[{]/.test(r.body)) {
    try {
      const j = JSON.parse(r.body);
      if (j && j.data && Array.isArray(j.data.result)) return `JSON ✅ 车次 ${j.data.result.length} 条`;
      if (j && j.c_url) return `JSON 要求换端点 → ${j.c_url}`;
      return 'JSON ' + JSON.stringify(Object.keys(j).slice(0, 5));
    } catch {
      return 'JSON（解析失败）';
    }
  }
  return `文本 ${r.bytes} 字节`;
}

(async () => {
  console.log('');
  console.log('12306 数据源可达性诊断');
  console.log(`  区间: ${from.name}(${from.code}) → ${to.name}(${to.code})`);
  console.log(`  日期: ${DATE}`);
  console.log('');

  // 建立匿名会话
  const init = await probe('/otn/leftTicket/init');
  const cookie = (init.setCookie || []).map((c) => String(c).split(';')[0]).join('; ');
  console.log(`  会话: HTTP ${init.status}  ${cookie ? cookie.slice(0, 50) + '…' : '(无 cookie)'}`);
  console.log('');

  const targets = [
    ['静态·站名表', '/otn/resources/js/framework/station_name.js'],
    ['静态·余票页', '/otn/leftTicket/init'],
    ['① 规范发现入口', `/otn/leftTicket/query?${QS}`],
    ['② queryG', `/otn/leftTicket/queryG?${QS}`],
    ['③ queryZ', `/otn/leftTicket/queryZ?${QS}`],
    ['④ queryA', `/otn/leftTicket/queryA?${QS}`],
    ['⑤ queryT', `/otn/leftTicket/queryT?${QS}`],
    ['⑥ 票价入口', `/otn/leftTicketPrice/queryG?${QS}`],
    ['⑦ lcquery', `/lcquery/queryG?${QS}`],
    ['⑧ 车次时刻', '/otn/queryTrainInfo/query?train_no=240000G1&from_station_no=01&to_station_no=10&train_date=' + DATE],
    ['⑨ 车次清单', '/otn/resources/js/query/train_list.js'],
    ['⑩ 车站时刻', `/otn/czxx/query?train_station_code=${from.code}&train_date=${DATE}`],
  ];

  let anyQuery = false;

  for (const [label, path] of targets) {
    const r = await probe(path, cookie);
    const desc = describe(r);
    if (desc.includes('✅')) anyQuery = true;
    console.log(`  ${label.padEnd(16)} ${String(r.status || '-').padStart(4)} ${String(r.ms).padStart(6)}ms  ${desc}`);
    await new Promise((res) => setTimeout(res, 500));
  }

  console.log('');
  console.log('──────────────────────────────────────────');
  if (anyQuery) {
    console.log('结论: 有余票查询入口可用。');
  } else {
    console.log('结论: 没有可用的余票查询入口。');
    console.log('');
    console.log('  所有查询类端点都被 12306 的客户端校验拦住了。');
    console.log('  本工具不会去逆向该校验，因此无法取得余票数据。');
    console.log('');
    console.log('  现在仍然可用: 网络时延监测、站点库、微信提醒通道、变化检测框架。');
    console.log('  买票请用 12306 官方 App 或官网。');
  }
  console.log('');
})();
