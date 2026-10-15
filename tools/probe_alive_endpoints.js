'use strict';

/**
 * 深挖还活着的两个 JSON 入口，判断能否支撑有用的功能。
 *
 * ⑦ /lcquery/queryG     —— 看起来是"列车查询"，实测 200
 * ⑧ /otn/queryTrainInfo —— 车次经停时刻，实测 200
 *
 * 用法: node tools/probe_alive_endpoints.js
 */

const https = require('https');
const zlib = require('zlib');
const stations = require('../src/core/stations');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function get(path, cookie) {
  return new Promise((resolve) => {
    const req = https.get(
      {
        host: 'kyfw.12306.cn',
        path,
        agent: false,
        timeout: 20000,
        headers: Object.assign(
          {
            'User-Agent': UA,
            Accept: '*/*',
            'Accept-Encoding': 'gzip, deflate',
            Referer: 'https://kyfw.12306.cn/otn/leftTicket/init',
          },
          cookie ? { Cookie: cookie } : {}
        ),
      },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => {
          let b = Buffer.concat(c);
          try {
            if (String(res.headers['content-encoding'] || '').includes('gzip')) b = zlib.gunzipSync(b);
          } catch { /* 原始字节 */ }
          resolve({ status: res.statusCode, body: b.toString('utf8'), bytes: b.length, setCookie: res.headers['set-cookie'] || [] });
        });
      }
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

function nextDate(days) {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 递归找出对象里的全部键名，用于理解未知结构。 */
function shape(obj, depth, maxDepth) {
  if (depth > maxDepth || obj === null || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    return `[${obj.length}]` + (obj.length ? ' ' + JSON.stringify(shape(obj[0], depth + 1, maxDepth)) : '');
  }
  const out = {};
  for (const k of Object.keys(obj).slice(0, 25)) {
    const v = obj[k];
    out[k] = v !== null && typeof v === 'object' ? shape(v, depth + 1, maxDepth) : typeof v;
  }
  return out;
}

(async () => {
  const init = await get('/otn/leftTicket/init');
  const cookie = (init.setCookie || []).map((c) => String(c).split(';')[0]).join('; ');
  const date = nextDate(45);

  console.log('\n══════ ⑦ /lcquery/queryG ══════');
  const qs = `leftTicketDTO.train_date=${date}&leftTicketDTO.from_station=VNP&leftTicketDTO.to_station=AOH&purpose_codes=ADULT`;
  const a = await get(`/lcquery/queryG?${qs}`, cookie);
  console.log('HTTP ' + a.status + '  ' + a.bytes + ' 字节');
  if (a.body) {
    try {
      const j = JSON.parse(a.body);
      console.log('顶层键: ' + JSON.stringify(Object.keys(j)));
      console.log('结构:');
      console.log(JSON.stringify(shape(j, 0, 3), null, 2).slice(0, 1800));
      if (j.data !== undefined && !Array.isArray(j.data) && typeof j.data === 'object') {
        console.log('\n data 内容预览:');
        console.log(JSON.stringify(j.data).slice(0, 700));
      }
      if (Array.isArray(j.data)) {
        console.log('\n data 是数组，长度 ' + j.data.length + '，首项:');
        console.log(String(j.data[0]).slice(0, 500));
      }
    } catch (e) {
      console.log('非 JSON: ' + a.body.slice(0, 300));
    }
  }

  await new Promise((r) => setTimeout(r, 600));

  console.log('\n══════ ⑧ /otn/queryTrainInfo/query ══════');
  // 用一趟京沪高铁试：G1 的内部编号需要先知道，先用常见格式试探
  const tries = [
    '/otn/queryTrainInfo/query?train_no=240000G1&from_station_no=01&to_station_no=10&train_date=' + date,
    '/otn/queryTrainInfo/query?train_no=240000G102&from_station_no=01&to_station_no=10&train_date=' + date,
  ];
  for (const p of tries) {
    const b = await get(p, cookie);
    console.log('\n路径: ' + p.split('?')[0] + '  HTTP ' + b.status + '  ' + b.bytes + ' 字节');
    try {
      const j = JSON.parse(b.body);
      console.log('  顶层键: ' + JSON.stringify(Object.keys(j)));
      console.log('  status=' + j.status + ' httpstatus=' + j.httpstatus);
      if (j.messages) console.log('  messages=' + JSON.stringify(j.messages).slice(0, 200));
      if (j.data) {
        console.log('  data 结构: ' + JSON.stringify(shape(j.data, 0, 2)).slice(0, 900));
        const arr = j.data.data || j.data;
        if (Array.isArray(arr) && arr.length) {
          console.log('  第一条: ' + JSON.stringify(arr[0]).slice(0, 600));
        }
      }
    } catch {
      console.log('  非 JSON: ' + b.body.slice(0, 200));
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('\n══════ ⑨ 车次清单 train_list.js 抽样 ══════');
  const tl = await get('/otn/resources/js/query/train_list.js', cookie);
  console.log('HTTP ' + tl.status + '  ' + tl.bytes + ' 字节');
  if (tl.body) {
    const head = tl.body.slice(0, 400);
    console.log('开头: ' + head.replace(/\s+/g, ' '));
    // 找日期键
    const dates = tl.body.match(/"(20\d\d-\d\d-\d\d)"/g);
    if (dates) {
      const uniq = [...new Set(dates.map((d) => d.replace(/"/g, '')))];
      console.log('包含日期: ' + uniq.length + ' 天，最早 ' + uniq[0] + ' 最晚 ' + uniq[uniq.length - 1]);
    }
  }
  console.log('');
})();
