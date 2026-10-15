'use strict';

/**
 * 状态与变化检测。
 *
 * 单一职责：把每次查询结果与上次快照做差，只在"值得打扰用户"时产出事件。
 * 避免"一直无票"这类无效通知刷屏。
 */

const fs = require('fs');
const path = require('path');
const parser = require('./parser');

/**
 * 数据目录。默认在项目下 data/，可用环境变量重定向
 * （测试与多实例部署需要，避免污染真实配置与状态）。
 */
const DATA_DIR = process.env.TICKET_RADAR_DATA
  ? path.resolve(process.env.TICKET_RADAR_DATA)
  : path.join(__dirname, '..', '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/** 同类写入失败只提示一次，避免每个采集周期刷屏。 */
const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn('[state] ' + message);
}

const DEFAULT_CONFIG = {
  /** 监控目标 */
  routes: [
    // { from:'北京南', to:'上海虹桥', dateOffset: 7, seats:['second','first'] }
  ],
  /** 查询间隔（秒）。刻意保持分钟级：余票库本身非实时，秒级只增加风控风险。 */
  intervalSec: 60,
  /**
   * 监控日期的上限（天）。
   * 12306 预售期约 14 天，超出后任何数据源都查不到 ——
   * 默认值与界面选项都必须落在这个范围内。
   */
  maxDateOffsetDays: 14,
  /** 整点放票窗口内提速（8:00-18:00 的每小时前 3 分钟） */
  rushWindowEnabled: true,
  rushIntervalSec: 20,
  /** 只在下列条件成立时推送 */
  notifyOn: {
    becameAvailable: true, // 无票 → 有票
    countIncreased: true, // 有票且数量变多
    newTrain: false, // 出现此前未见的车次
  },
  /** 通知去重：同一(车次,日期,席位)同类事件在该分钟数内只推一次 */
  dedupeWindowMin: 10,
  /** 静默时段（本地时间，24 小时制），不推送但仍采集 */
  quietHours: { start: 23, end: 6 },
  /** 微信推送配置（PushPlus） */
  wechat: {
    enabled: false,
    channel: 'pushplus',
    token: '',
    template: 'markdown',
  },
  /**
   * 数据源配置。
   * 直连 12306 的查询接口被客户端校验挡住（2026-09 实测），
   * 因此实际可用的是第三方合规数据源（接口盒子 apihz.cn）。
   */
  dataSource: {
    /** 'auto' | 'direct' | 'apihz' */
    provider: 'auto',
    apihz: { id: '', key: '', endpoint: '' },
    /** 直连不可用时是否自动改用第三方 */
    fallbackToApihz: true,
    /** auto 模式下是否也尝试直连（默认否：明知会被拦就别白打请求） */
    tryDirect: false,
  },
  /** 页面自动打开 */
  autoOpenBrowser: true,
  httpPort: 12308,
};

let config = null;
let state = { snapshots: {}, events: [], latency: [] };

/**
 * 确保数据目录存在。
 * 建不出来也不抛错 —— 调用方（loadConfig/loadState）随后会用默认值继续，
 * 程序能在只读位置以降级模式运行，而不是启动即崩。
 * @returns {boolean} 目录是否可用
 */
function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return true;
  } catch (e) {
    warnOnce('mkdir', `数据目录不可用 ${DATA_DIR}：${e.message}。将以只读模式运行，配置与历史不会保存。`);
    return false;
  }
}

function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return override;
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

function loadConfig() {
  ensureDir();
  let disk = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      console.error('[state] config.json 解析失败，使用默认配置:', e.message);
    }
  }
  config = deepMerge(DEFAULT_CONFIG, disk);
  return config;
}

/**
 * 保存配置。
 * 写失败（只读目录、权限受限等）绝不能让程序崩溃 ——
 * 最多是设置无法持久化，运行时仍可继续工作。
 * @returns {boolean} 是否写入成功
 */
function saveConfig() {
  try {
    ensureDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (e) {
    warnOnce('config', `配置无法写入 ${CONFIG_FILE}：${e.message}。本次修改只在内存中生效。`);
    return false;
  }
}

function loadState() {
  ensureDir();
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      console.error('[state] state.json 解析失败，重新开始:', e.message);
    }
  }
  state.snapshots = state.snapshots || {};
  state.events = state.events || [];
  state.latency = state.latency || [];
  return state;
}

/**
 * 保存状态。同样不允许因为写失败而崩溃 ——
 * 快照与历史记录丢失可以接受，服务挂掉不行。
 * @returns {boolean} 是否写入成功
 */
function saveState() {
  try {
    ensureDir();
    // 控制文件体积：事件与延迟各留最近若干条
    state.events = state.events.slice(-500);
    state.latency = state.latency.slice(-2880); // 60s 间隔约两天
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
    return true;
  } catch (e) {
    warnOnce('state', `状态无法写入 ${STATE_FILE}：${e.message}。本次采集结果不会持久化。`);
    return false;
  }
}

function routeKey(route) {
  return `${route.from}→${route.to}@${route.date || 'offset' + route.dateOffset}`;
}

/** 记录一次时延采样。 */
function recordLatency(sample) {
  state.latency.push(sample);
  if (state.latency.length > 3000) state.latency = state.latency.slice(-2880);
}

/**
 * 对比新旧快照，产出事件列表。
 *
 * 关于 newTrain：不能因为"上一轮快照里没有这趟车"就报警。
 * 首次采集时 prevRows 是空的，那样会把每一趟可购车次都当成新增，一口气推满屏通知。
 * 因此改用调用方传入的 seenTrains（历史上已提醒过的车次集合）来判断，
 * 它天然覆盖"首次采集"与"车次一度消失后重现"两种情况。
 *
 * @param {Array} prevRows 上一轮快照的行
 * @param {Array} nextRows 本轮解析后的行
 * @param {string[]} seatsOfInterest 关注的席位 key；空/未传表示关注全部
 * @param {Set<string>} [seenTrains] 历史上已提醒过的车次集合
 * @returns {Array<{kind:string, trainCode:string, seatKey:string, seatName:string, text:string}>}
 */
function diffSnapshot(prevRows, nextRows, seatsOfInterest, seenTrains) {
  const events = [];

  // 没有基线快照：本轮只用于建立基线，必须完全静默。
  // 否则 prevByCode 是空 Map，`!prev` 对每一行都成立，
  // 会把当轮所有可购车次都当成"新增"，首次采集即刷屏。
  if (!prevRows || !prevRows.length) return events;

  const prevByCode = new Map(prevRows.map((r) => [r.code, r]));
  const interest = seatsOfInterest && seatsOfInterest.length ? new Set(seatsOfInterest) : null;
  const seen = seenTrains instanceof Set ? seenTrains : new Set();

  for (const row of nextRows || []) {
    const prev = prevByCode.get(row.code);

    // seatList 是解析产物的便利字段；快照里的行没有，从 seats 兜底重建
    const seatList = row.seatList || seatsToSeatList(row.seats);
    // 事件文案里给出完整的"出发→到达"，比只写"06:30开"更有辨识度
    const when = timeRange(row);

    for (const seat of seatList) {
      if (interest && !interest.has(seat.key)) continue;

      const before = prev && prev.seats[seat.key] ? prev.seats[seat.key] : null;
      const beforeState = before ? before.state : 'unknown';
      const beforeCount = before ? before.count : null;

      // 新出现车次：仅当历史上从未提醒过它时才报
      if (!prev && seat.state === 'available' && !seen.has(row.code)) {
        events.push({
          kind: 'newTrain',
          trainCode: row.code,
          seatKey: seat.key,
          seatName: seat.name,
          text: `${row.code} ${when} 新增可购（${seat.name}）`,
        });
        continue;
      }
      if (!prev) continue;

      // 无票 → 有票
      if (beforeState !== 'available' && seat.state === 'available') {
        events.push({
          kind: 'becameAvailable',
          trainCode: row.code,
          seatKey: seat.key,
          seatName: seat.name,
          text: `${row.code} ${when} ${seat.name} 无票 → ${seat.text}`,
        });
        continue;
      }

      // 有票且数量增加
      if (beforeState === 'available' && seat.state === 'available') {
        if (seat.count != null && (beforeCount == null || seat.count > beforeCount)) {
          events.push({
            kind: 'countIncreased',
            trainCode: row.code,
            seatKey: seat.key,
            seatName: seat.name,
            text: `${row.code} ${when} ${seat.name} 余票增加至 ${seat.count}`,
          });
        }
      }
    }
  }

  return events;
}

/** 由 seats 映射重建 seatList（快照行没有 seatList 字段时用）。 */
function seatsToSeatList(seats) {
  if (!seats) return [];
  const out = [];
  for (const [key, avail] of Object.entries(seats)) {
    if (!avail || avail.state === 'unknown') continue;
    const def = parser.SEAT_BY_KEY.get(key);
    out.push({
      key,
      name: def ? def.name : key,
      short: def ? def.short : key,
      state: avail.state,
      count: avail.count,
      text: avail.text,
    });
  }
  return out;
}

/** 从已有事件里收集"历史上提醒过哪些车次"，用于 newTrain 判定。 */
function seenTrainsFrom(events) {
  const s = new Set();
  for (const e of events || []) {
    if (e && e.trainCode) s.add(e.trainCode);
  }
  return s;
}

/** 去重：同 key 在窗口内只保留一次。 */
function dedupe(events, existingEvents, windowMin) {
  const cutoff = Date.now() - windowMin * 60000;
  const seen = new Set();
  for (const e of existingEvents) {
    if (e.ts >= cutoff) seen.add(`${e.trainCode}|${e.seatKey}|${e.kind}`);
  }
  return events.filter((e) => {
    const k = `${e.trainCode}|${e.seatKey}|${e.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 事件文案里的时间范围，如 "06:30→11:24"；跨零点标"次日"。
 * 只给出发时间的话，用户还得回列表里对是哪一趟。
 */
function timeRange(row) {
  const dep = String((row && row.departTime) || '').trim();
  const arr = String((row && row.arriveTime) || '').trim();
  if (!dep) return '';
  if (!arr || /^24:00$/.test(arr) || /^24:00$/.test(dep)) return `${dep} 开`;

  const a = dep.match(/^(\d{1,2}):(\d{2})$/);
  const b = arr.match(/^(\d{1,2}):(\d{2})$/);
  const nextDay = a && b && Number(b[1]) * 60 + Number(b[2]) < Number(a[1]) * 60 + Number(a[2]);
  return nextDay ? `${dep}→次日 ${arr}` : `${dep}→${arr}`;
}

function addEvents(events, context) {
  const stamped = events.map((e) =>
    Object.assign({ ts: Date.now(), read: false, route: context.route, date: context.date }, e)
  );
  state.events = state.events.concat(stamped).slice(-500);
  return stamped;
}

/**
 * 是否处于静默时段。
 * 注意：config 在 loadConfig() 之前是 null，这里必须有兜底 ——
 * 否则任何提前调用都会 TypeError（曾因此抛异常）。
 */
function isQuietNow() {
  const hours = (config || DEFAULT_CONFIG).quietHours;
  const h = new Date().getHours();
  const start = hours.start;
  const end = hours.end;
  if (start === end) return false; // 起止相同表示不启用静默
  return start < end ? h >= start && h < end : h >= start || h < end;
}

/** 当前是否处于整点放票窗口（用于临时提速）。 */
function isRushWindow() {
  const cfg = config || DEFAULT_CONFIG;
  if (!cfg.rushWindowEnabled) return false;
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  return h >= 8 && h < 18 && m < 3;
}

/**
 * 轮询间隔的合理闭区间（秒）。
 * 低于 10 秒对余票库没有意义，只会抬高风控风险；超过一天等于没在监控。
 */
const MIN_INTERVAL_SEC = 10;
const MAX_INTERVAL_SEC = 86400;
/** 通知去重窗口的上限（分钟）。 */
const MAX_DEDUPE_WINDOW_MIN = 1440;

/**
 * 把任意来源的间隔值收敛到可用范围。
 *
 * 必须在读侧再兜一道：intervalSec 会被直接乘 1000 交给 setTimeout，而
 * 1e21 这类值会让延时溢出成 32 位整数、被 Node 折算成 1ms —— 引擎于是以
 * 约 70 次/秒的频率猛打上游。非有限值一律回落到默认间隔。
 */
function clampIntervalSec(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.intervalSec;
  return Math.min(Math.max(Math.round(n), MIN_INTERVAL_SEC), MAX_INTERVAL_SEC);
}

function currentIntervalSec() {
  const cfg = config || DEFAULT_CONFIG;
  return isRushWindow() ? clampIntervalSec(cfg.rushIntervalSec) : clampIntervalSec(cfg.intervalSec);
}

module.exports = {
  DATA_DIR,
  STATE_FILE,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  MIN_INTERVAL_SEC,
  MAX_INTERVAL_SEC,
  MAX_DEDUPE_WINDOW_MIN,
  clampIntervalSec,
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  getConfig: () => config,
  getState: () => state,
  routeKey,
  recordLatency,
  diffSnapshot,
  seatsToSeatList,
  seenTrainsFrom,
  timeRange,
  dedupe,
  addEvents,
  isQuietNow,
  isRushWindow,
  currentIntervalSec,
};
