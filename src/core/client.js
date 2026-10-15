'use strict';

/**
 * 12306 只读客户端。
 *
 * 设计边界（刻意为之，请勿扩展）：
 *   - 仅匿名会话，不登录、不带账号 Cookie、不碰验证码
 *   - 仅调用余票查询类只读接口，不提交订单、不支付
 *   - 内置最小请求间隔，避免高频轮询
 */

const https = require('https');
const zlib = require('zlib');

const HOST = 'kyfw.12306.cn';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 兜底试探用的端点名。12306 会轮换这些名字，故仅作最后手段。 */
const KNOWN_ENDPOINTS = ['queryG', 'queryO', 'queryZ', 'queryA'];
const ENDPOINT_RE = /^query[A-Z]$/;

/** 上次请求时间戳，用于强制全局最小间隔。 */
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 解析 Set-Cookie 数组为 Cookie 请求头。 */
function cookieHeaderFrom(setCookie) {
  if (!setCookie || !setCookie.length) return '';
  const jar = new Map();
  for (const raw of setCookie) {
    const pair = String(raw).split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * 单次 HTTPS GET，采集分段时延（单位毫秒）：
 *   dns   域名解析   tcp  TCP 建连   tls  TLS 握手
 *   ttfb  首字节到达  total 响应体收完
 */
function httpGet({ path: reqPath, cookie, minIntervalMs = 0 }) {
  return new Promise((resolve) => {
    const wait = Math.max(0, lastRequestAt + minIntervalMs - Date.now());
    if (wait > 0) {
      return sleep(wait)
        .then(() => httpGet({ path: reqPath, cookie, minIntervalMs: 0 }))
        .then(resolve);
    }

    lastRequestAt = Date.now();
    const t0 = Date.now();
    const timing = { dns: null, tcp: null, tls: null, ttfb: null, total: null };
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      timing.total = Date.now() - t0;
      resolve(Object.assign({ timing, at: t0 }, result));
    };

    const req = https.request(
      {
        host: HOST,
        path: reqPath,
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Accept-Encoding': 'gzip, deflate',
          Connection: 'keep-alive',
          Referer: `https://${HOST}/otn/leftTicket/init`,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        timeout: 15000,
        // 不复用连接：keep-alive 会让 socket 上的 lookup/connect 监听器逐次累积而泄漏
        agent: false,
      },
      (res) => {
        timing.ttfb = Date.now() - t0;
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] || '');
          try {
            if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
            else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
          } catch {
            /* 解压失败则用原始字节 */
          }
          done({
            ok: true,
            status: res.statusCode,
            headers: res.headers,
            body: buf.toString('utf8'),
            setCookie: res.headers['set-cookie'],
          });
        });
      }
    );

    req.on('socket', (socket) => {
      socket.on('lookup', () => {
        timing.dns = Date.now() - t0;
      });
      socket.on('connect', () => {
        timing.tcp = Date.now() - t0;
      });
      socket.on('secureConnect', () => {
        timing.tls = Date.now() - t0;
      });
    });

    req.on('timeout', () => req.destroy(new Error('请求超时 (15s)')));
    req.on('error', (err) => done({ ok: false, error: err.message, code: err.code }));

    req.end();
  });
}

/** 从路径中提取端点名，如 /otn/leftTicket/queryG → queryG */
function endpointFrom(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const direct = s.replace(/^leftTicket\//, '').trim();
  if (ENDPOINT_RE.test(direct)) return direct;
  const m = s.match(/leftTicket\/(query[A-Z])\b/);
  return m ? m[1] : '';
}

/**
 * 从响应推导下一跳完整路径（含查询串）。
 *
 * 12306 的 302 有两种形态：
 *   a) Location / body.c_url 给出端点名（"leftTicket/queryG" 或 "queryG?..."）
 *   b) Location 指向错误页（/mormhweb/logFiles/error.html），此时无端点可用
 */
function nextQueryPath(res, currentEndpoint, qs) {
  const candidates = [];

  const loc = String((res.headers && res.headers.location) || '').trim();
  if (loc) candidates.push(loc);

  if (res.body) {
    try {
      const j = JSON.parse(res.body);
      if (j && typeof j.c_url === 'string') candidates.push(j.c_url);
    } catch {
      /* body 可能为空或非 JSON */
    }
  }

  for (const raw of candidates) {
    if (!raw) continue;
    if (/error\.html|\/mormhweb\//i.test(raw)) continue; // 风控/错误页
    if (/^https?:\/\//i.test(raw) && !raw.includes(HOST)) continue; // 站外跳转

    let pathname = raw;
    let search = '';
    if (/^https?:\/\//i.test(raw)) {
      try {
        const u = new URL(raw);
        pathname = u.pathname;
        search = u.search;
      } catch {
        continue;
      }
    } else if (raw.includes('?')) {
      const i = raw.indexOf('?');
      pathname = raw.slice(0, i);
      search = raw.slice(i);
    }

    const name = endpointFrom(pathname);
    if (!name) continue;
    if (name === currentEndpoint && !search) continue; // 指回自身且无参数，无意义
    return `/otn/leftTicket/${name}${search || '?' + qs}`;
  }

  return '';
}

/** 建立匿名会话，返回 Cookie 头与该请求时延。 */
async function openSession() {
  const res = await httpGet({ path: '/otn/leftTicket/init' });
  if (!res.ok) return { cookie: '', error: res.error, timing: res.timing };
  return { cookie: cookieHeaderFrom(res.setCookie), timing: res.timing, status: res.status };
}

/** 把一次 JSON 响应归一化为查询结果。 */
function normalizePayload(body, endpoint, timing) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return { kind: 'error', error: `${endpoint}: 返回非 JSON，可能被风控拦截` };
  }

  if (json && typeof json.c_url === 'string') {
    return { kind: 'redirect', error: `${endpoint}: 要求改用 ${json.c_url}` };
  }

  const result = json && json.data ? json.data.result : undefined;
  if (Array.isArray(result) || result === '') {
    return {
      kind: 'ok',
      value: {
        ok: true,
        endpoint,
        rows: Array.isArray(result) ? result : [],
        map: (json.data && json.data.map) || {},
        timing,
        status: 200,
      },
    };
  }

  return {
    kind: 'error',
    error: `${endpoint}: 响应结构异常 ${JSON.stringify((json && json.messages) || Object.keys(json || {}))}`,
  };
}

/**
 * 从指定端点出发查询，自动跟随 12306 的端点轮换（最多 3 跳）。
 */
async function queryFromEndpoint({ startEndpoint, qs, cookie, minIntervalMs }) {
  let endpoint = startEndpoint;
  let timing = null;
  let lastError = '未收到有效响应';

  for (let hop = 0; hop <= 3; hop++) {
    const res = await httpGet({
      path: `/otn/leftTicket/${endpoint}?${qs}`,
      cookie,
      minIntervalMs: hop === 0 ? minIntervalMs : 400,
    });
    timing = res.timing;

    if (!res.ok) return { ok: false, error: `${endpoint}: ${res.error}`, timing };

    if (res.status !== 200) {
      const next = nextQueryPath(res, endpoint, qs);
      if (!next) {
        return {
          ok: false,
          error: `${endpoint}: HTTP ${res.status}（无可跟随的端点，可能为风控页）`,
          timing,
        };
      }
      lastError = `${endpoint}: HTTP ${res.status} → ${next.split('?')[0]}`;
      endpoint = next.replace(/^\/otn\/leftTicket\//, '').split('?')[0];
      continue;
    }

    const norm = normalizePayload(res.body, endpoint, res.timing);
    if (norm.kind === 'ok') return norm.value;
    if (norm.kind === 'redirect') {
      const next = nextQueryPath(res, endpoint, qs);
      if (!next) return { ok: false, error: norm.error, timing };
      lastError = norm.error;
      endpoint = next.replace(/^\/otn\/leftTicket\//, '').split('?')[0];
      continue;
    }
    return { ok: false, error: norm.error, timing };
  }

  return { ok: false, error: `端点轮换超过上限：${lastError}`, timing };
}

/**
 * 查询余票。
 *
 * 12306 会轮换查询端点名，且具体名字随时间变化（queryG/queryO/queryZ/queryA…），
 * 硬编码端点名会随轮换失效（实测 queryG 一度有效、后失效）。因此主路径是"发现"：
 *   GET /otn/leftTicket/query?<参数> → 302 告知真实端点 → GET 该端点 → 200 JSON
 * 兜底再依次试已知端点名。
 */
async function queryTickets({ date, fromCode, toCode, session, minIntervalMs = 1500 }) {
  const qs =
    `leftTicketDTO.train_date=${encodeURIComponent(date)}` +
    `&leftTicketDTO.from_station=${encodeURIComponent(fromCode)}` +
    `&leftTicketDTO.to_station=${encodeURIComponent(toCode)}` +
    '&purpose_codes=ADULT';

  const cookie = session && session.cookie ? session.cookie : '';

  // 主路径：规范入口发现真实端点
  const primary = await queryFromEndpoint({ startEndpoint: 'query', qs, cookie, minIntervalMs });
  if (primary.ok) return primary;

  // 兜底：依次试已知端点名
  let lastError = primary.error;
  let timing = primary.timing;
  for (const ep of KNOWN_ENDPOINTS) {
    const r = await queryFromEndpoint({ startEndpoint: ep, qs, cookie, minIntervalMs: 400 });
    if (r.ok) return r;
    lastError = r.error;
    timing = r.timing || timing;
  }

  return { ok: false, error: lastError, timing };
}

/**
 * 轻量连通性/时延探测：只打静态资源，不消耗查询配额。
 */
async function probeLatency() {
  const res = await httpGet({ path: '/otn/resources/js/framework/station_name.js', minIntervalMs: 0 });
  if (!res.ok) return { ok: false, error: res.error, timing: res.timing };
  return { ok: res.status === 200, status: res.status, bytes: res.body.length, timing: res.timing };
}

module.exports = {
  openSession,
  queryTickets,
  probeLatency,
  httpGet,
  cookieHeaderFrom,
  KNOWN_ENDPOINTS,
  HOST,
};
