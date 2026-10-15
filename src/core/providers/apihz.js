'use strict';

/**
 * 第三方合规数据源 provider：接口盒子 apihz.cn
 *
 * 为什么用它：12306 的直连查询接口被客户端校验挡住，而这个平台
 * 自行维护取数通道（含平台侧 cookie），把合规责任留在平台侧；
 * 使用者只需注册自己的 id/key。免费额度 10 次/分钟、每日无上限。
 *
 * 接口：GET {base}?id=&key=&add=出发站&end=到达站&y=&m=&d=
 * 返回：{ code, msg, td, datas:[{ train_number, train_order, depart_index,
 *         arrive_index, depart_name, arrive_code, depart_time, arrive_time,
 *         duration, seatcode, date, seats:[{type, stock}] }] }
 *
 * 座位余票语义（文档明确）：-1 = 有票且充足，0 = 无票，>0 = 余票张数。
 */

const SEAT_MAP = {
  '商务座': 'business',
  '特等座': 'business',
  '一等座': 'first',
  '优选一等座': 'preferredFirst',
  '二等座': 'second',
  '二等包座': 'second',
  '高级软卧': 'topGrade',
  '软卧': 'softSleeper',
  '动卧': 'deluxeSleeper',
  '一等卧': 'deluxeSleeper',
  '硬卧': 'hardSleeper',
  '二等卧': 'hardSleeper',
  '软座': 'softSeat',
  '硬座': 'hardSeat',
  '无座': 'noSeat',
};

const label = '第三方数据源（接口盒子 apihz.cn）';
const note = '免费 10 次/分钟、每日无上限。需注册自己的 id/key。仅支持 14 天内。';

/**
 * 平台支持的日期上限（天）。
 *
 * 实测断崖：14 天内全部成功，15 天起一律返回
 * "查询失败，请重试…"（连付费档也一样）。
 * 这与 12306 的预售期一致 —— 超出预售期本来也查不到。
 *
 * 因此超限时必须**提前拦下并说明**，而不是把平台的模糊错误
 * 原样抛给用户（本项目默认曾是 45 天，导致采集一直失败而
 * 测试按钮却成功 —— 因为两者用的日期不同）。
 */
const MAX_DATE_OFFSET_DAYS = 14;

/** 日期字符串 → 距今天数；无法解析返回 null。 */
function offsetOf(date) {
  const d = new Date(String(date) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}

/** 把超出预售期的日期收敛到上限。 */
function clampDate(date) {
  const off = offsetOf(date);
  if (off === null || off <= MAX_DATE_OFFSET_DAYS) return { date, clamped: false, offset: off };

  const d = new Date();
  d.setDate(d.getDate() + MAX_DATE_OFFSET_DAYS);
  const fixed =
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { date: fixed, clamped: true, offset: off, original: date };
}

/** 精简座位名：「二等座(二等包座)」→「二等座」 */
function seatKeyOf(typeText) {
  const clean = String(typeText || '').replace(/[（(].*?[)）]/g, '').trim();
  if (SEAT_MAP[clean]) return SEAT_MAP[clean];
  // 退化为包含匹配，兼容平台后续微调命名
  for (const [k, v] of Object.entries(SEAT_MAP)) {
    if (clean.includes(k)) return v;
  }
  return null;
}

/** 把 stock 转成内部的席位状态对象。 */
function normalizeStock(stock) {
  // 先排除"没有数据"的情况。
  // 注意：Number(null) === 0、Number('') === 0，若不先判空，
  // 缺失的 stock 会被当成"确认无票"，从而在变化检测里误报。
  if (stock === null || stock === undefined || stock === '') {
    return { state: 'unknown', count: null, text: '' };
  }

  const n = Number(stock);
  if (!Number.isFinite(n)) {
    const s = String(stock).trim();
    if (s === '有') return { state: 'available', count: null, text: '有' };
    if (s === '无' || s === '--') return { state: 'none', count: 0, text: '无' };
    return { state: 'unknown', count: null, text: '' };
  }
  if (n < 0) return { state: 'available', count: null, text: '有' };
  if (n === 0) return { state: 'none', count: 0, text: '无' };
  return { state: 'available', count: n, text: `有(${n})` };
}

const ALL_SEAT_KEYS = [
  'business', 'first', 'second', 'topGrade', 'softSleeper',
  'deluxeSleeper', 'hardSleeper', 'softSeat', 'hardSeat', 'noSeat', 'preferredFirst',
];

/**
 * 判断是否是平台的"占位记录"。
 *
 * 实测：当日不开行的车次会返回一条时刻为 24:00/24:00、历时 99:59、
 * 且所有席位为 0 的记录（例如北京南→上海虹桥里的 G531）。
 * 这类记录既查不到票、时刻又是乱码，展示出来只会让人困惑。
 */
function isPlaceholderTrip(t) {
  if (!t) return true;
  const dep = String(t.depart_time || '');
  const arr = String(t.arrive_time || '');
  const dur = String(t.duration || '');
  const weirdTime = /^24:00$/.test(dep) || /^24:00$/.test(arr) || /^99:/.test(dur);
  if (!weirdTime) return false;

  // 时刻异常 + 完全没有余票 → 视为占位记录丢弃
  const hasTicket = (t.seats || []).some((s) => {
    if (!s) return false;
    const n = Number(s.stock);
    return Number.isFinite(n) ? n !== 0 : String(s.stock).trim() === '有';
  });
  return !hasTicket;
}

/**
 * 把平台返回的一条车次归一化成内部结构（与 parser.js 的输出同构）。
 * @returns {object|null}
 */
function normalizeTrip(t) {
  if (!t || !t.train_number) return null;
  if (isPlaceholderTrip(t)) return null;

  const seats = {};
  for (const k of ALL_SEAT_KEYS) seats[k] = { state: 'unknown', count: null, text: '' };

  for (const s of t.seats || []) {
    if (!s) continue;
    const key = seatKeyOf(s.type);
    if (!key) continue;
    const norm = normalizeStock(s.stock);
    // 同一席位出现多次（如「二等座」与「二等包座」）时取更宽松的结果
    const prev = seats[key];
    if (prev.state === 'available' && norm.state !== 'available') continue;
    seats[key] = norm;
  }

  const seatList = Object.entries(seats)
    .filter(([, v]) => v.state !== 'unknown')
    .map(([key, v]) => {
      const def = require('../parser').SEAT_BY_KEY.get(key);
      return {
        key,
        name: def ? def.name : key,
        short: def ? def.short : key,
        state: v.state,
        count: v.count,
        text: v.text,
      };
    });

  const code = String(t.train_number);
  const departName = t.depart_name || '';
  const arriveName = t.arrive_name || '';

  return {
    trainNo: t.train_order || '',
    code,
    type: code[0] || '?',
    fromCode: t.depart_code || '',
    toCode: t.arrive_code || '',
    fromName: departName,
    toName: arriveName,
    boardCode: t.depart_code || '',
    boardName: departName,
    alightName: arriveName,
    departTime: t.depart_time || '',
    arriveTime: t.arrive_time || '',
    duration: t.duration || '',
    canBook: true,
    date: t.date || '',
    seats,
    seatList,
    source: 'apihz',
  };
}

function normalizeDatas(datas) {
  const out = [];
  for (const t of datas || []) {
    const row = normalizeTrip(t);
    if (row) out.push(row);
  }
  return out;
}

/** 可用接入点。域名接口会自动调度；IP 作为兜底。 */
const ENDPOINTS = [
  'https://cn.apihz.cn/api/12306/api.php',
  'http://101.35.2.25/api/12306/api.php',
  'http://124.222.204.22/api/12306/api.php',
  'http://101.34.207.105/api/12306/api.php',
];

function ready(cfg) {
  const a = (cfg && cfg.apihz) || {};
  return !!(a.id && a.key);
}

/** 组装请求 URL。 */
function buildUrl(cfg, { from, to, date }) {
  const a = cfg.apihz || {};
  const [y, m, d] = String(date).split('-');
  const base = a.endpoint || ENDPOINTS[0];
  const qs =
    `id=${encodeURIComponent(a.id)}&key=${encodeURIComponent(a.key)}` +
    `&add=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}` +
    `&y=${Number(y)}&m=${Number(m)}&d=${Number(d)}`;
  return `${base}?${qs}`;
}

/** 带超时的 GET JSON。 */
async function getJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'ticket-radar/0.1' },
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: `返回非 JSON: ${text.slice(0, 120)}`, status: res.status };
    }
    return { ok: true, json, status: res.status };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '请求超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 平台错误码 → 可读提示。 */
function describeError(json) {
  const msg = String((json && json.msg) || '');
  if (/频次|过快|限流/.test(msg)) {
    return '调用过于频繁（共享 key 或超出 10 次/分钟）。请稍后重试，或确认用的是自己的 id/key。';
  }
  if (/秘钥|密钥|key/i.test(msg) && /错误|无效/.test(msg)) {
    return 'id 或 key 不正确，请在设置里核对。';
  }
  if (/cookie/i.test(msg)) {
    return '平台侧会话失效，请稍后重试（或按平台说明提供自己的 cookie）。';
  }
  if (/封禁|不存在/.test(msg)) {
    return '平台提示账号不存在或已被封禁，请到接口盒子后台确认账号状态。';
  }
  if (/查询失败|请重试|失败/.test(msg)) {
    // 最常见的成因是日期超出预售期（平台与 12306 一致，只支持约 14 天内）。
    // 也可能是平台本地节点临时波动，所以两种可能都说清楚。
    return '平台节点本次取数失败。最常见原因是查询日期超出 14 天预售期；'
      + '若日期在 14 天内，则可能是平台节点临时波动，稍后会自动重试。';
  }
  return msg || '平台返回未知错误';
}

/**
 * 取余票。
 *
 * 日期会被收敛到平台支持的范围内（约 14 天预售期），
 * 并在返回值里用 clamped 标记，便于上层提示用户。
 *
 * @returns {{ok:boolean, rows?:Array, source?:string, error?:string, clamped?:boolean}}
 */
async function fetchTickets({ date, from, to, cfg }) {
  if (!ready(cfg)) {
    return { ok: false, error: '尚未配置第三方数据源的 id/key' };
  }

  const clampedInfo = clampDate(date);
  const useDate = clampedInfo.date;

  const endpoints = cfg.apihz.endpoint ? [cfg.apihz.endpoint] : ENDPOINTS;
  let lastError = '未尝试任何接入点';

  for (const base of endpoints) {
    const url = buildUrl(Object.assign({}, cfg, { apihz: Object.assign({}, cfg.apihz, { endpoint: base }) }), {
      from,
      to,
      date: useDate,
    });
    const r = await getJson(url);

    if (!r.ok) {
      lastError = `${base.replace(/\/api\/.*/, '')}: ${r.error}`;
      // 单节点网络问题 → 换下一个节点（免费档位成功率无保障，多试有用）
      continue;
    }

    const j = r.json;
    if (j && j.code === 200 && Array.isArray(j.datas)) {
      return {
        ok: true,
        source: 'apihz',
        endpoint: base,
        mode: j.td || '',
        date: useDate,
        clamped: clampedInfo.clamped,
        originalDate: clampedInfo.original,
        rows: normalizeDatas(j.datas),
      };
    }

    const described = describeError(j);
    lastError = described;

    // 鉴权类错误换节点没用，立即停止
    if (/id 或 key|账号不存在|封禁/.test(described)) break;

    // 其余情况（含"查询失败"）继续试下一个节点：
    // 免费档位是本地线路，节点间状态不同，多试能提高成功率。
  }

  return {
    ok: false,
    error: lastError,
    date: useDate,
    clamped: clampedInfo.clamped,
    originalDate: clampedInfo.original,
  };
}

/**
 * 配置自检：用一次真实查询验证 id/key 是否可用。
 * 供设置页的「测试连接」使用。
 *
 * 日期固定用 7 天后 —— 必须在平台支持的预售期内，
 * 否则会把"日期超限"误报成"key 有问题"。
 */
async function testConnection(cfg, sample) {
  const probe = sample || (() => {
    const d = new Date(Date.now() + 7 * 86400000);
    return {
      from: '北京南',
      to: '上海虹桥',
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    };
  })();

  const res = await fetchTickets({
    date: probe.date,
    from: probe.from,
    to: probe.to,
    cfg: Object.assign({}, cfg, { apihz: Object.assign({}, cfg.apihz, { endpoint: '' }) }),
  });

  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    count: res.rows.length,
    mode: res.mode || '',
    endpoint: (res.endpoint || '').replace(/\/api\/.*/, ''),
    sample: probe,
  };
}

module.exports = {
  name: 'apihz',
  label,
  note,
  ready,
  fetchTickets,
  testConnection,
  normalizeTrip,
  normalizeDatas,
  normalizeStock,
  seatKeyOf,
  isPlaceholderTrip,
  clampDate,
  offsetOf,
  MAX_DATE_OFFSET_DAYS,
  SEAT_MAP,
  ENDPOINTS,
};
