'use strict';

/**
 * 12306 余票响应解析。
 *
 * 原始行是 URL 编码的、竖线分隔的 58 段字符串，形如：
 *   <secret>|预订|240000G53106|G531|VNP|AOH|VNP|AOH|06:08|12:04|05:56|Y|...
 *
 * 关键：必须先 decodeURIComponent 再 split('|')。
 * 前 12 段含有 %0A 换行与 %2F 等转义，直接 split 会导致字段错位。
 *
 * 席位字段的取值有三种形态：
 *   有 / 无      —— 有票 / 无票（数量未知）
 *   "12"         —— 余票数量
 *   "候补" / 其他 —— 需候补
 */

const SEAT_FIELDS = [
  { idx: 32, key: 'business', name: '商务座', short: '商务' },
  { idx: 31, key: 'first', name: '一等座', short: '一等' },
  { idx: 30, key: 'second', name: '二等座', short: '二等' },
  { idx: 21, key: 'topGrade', name: '高级软卧', short: '高软' },
  { idx: 23, key: 'softSleeper', name: '软卧', short: '软卧' },
  { idx: 33, key: 'deluxeSleeper', name: '动卧', short: '动卧' },
  { idx: 28, key: 'hardSleeper', name: '硬卧', short: '硬卧' },
  { idx: 24, key: 'softSeat', name: '软座', short: '软座' },
  { idx: 29, key: 'hardSeat', name: '硬座', short: '硬座' },
  { idx: 26, key: 'noSeat', name: '无座', short: '无座' },
  { idx: 34, key: 'preferredFirst', name: '优选一等座', short: '优选一等' },
];

const SEAT_BY_KEY = new Map(SEAT_FIELDS.map((s) => [s.key, s]));

/** 把单个席位的原始文本归一化成状态对象。 */
function normalizeAvailability(raw) {
  const v = raw == null ? '' : String(raw).trim();
  if (v === '') return { state: 'unknown', count: null, text: '' };
  if (v === '有') return { state: 'available', count: null, text: '有' };
  if (v === '无') return { state: 'none', count: 0, text: '无' };
  if (v === '候补') return { state: 'waitlist', count: null, text: '候补' };
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return { state: n > 0 ? 'available' : 'none', count: n, text: n > 0 ? `有(${n})` : '无' };
  }
  return { state: 'other', count: null, text: v };
}

/** 解析一行原始记录。解析失败返回 null。 */
function parseRow(rawLine, stationMap) {
  let line = String(rawLine || '');
  if (!line) return null;
  // 先去掉换行转义，再整体解码，避免 %0A 混进字段
  line = line.replace(/%0A/gi, '');
  try {
    line = decodeURIComponent(line);
  } catch {
    /* 极端情况下保留原串继续尝试 */
  }

  const f = line.split('|');
  if (f.length < 35) return null;

  const trainCode = (f[3] || '').trim();
  if (!trainCode) return null;

  const fromCode = (f[6] || '').trim();
  const toCode = (f[7] || '').trim();
  const map = stationMap || {};

  const seats = {};
  const seatList = [];
  for (const def of SEAT_FIELDS) {
    const avail = normalizeAvailability(f[def.idx]);
    seats[def.key] = avail;
    if (avail.state !== 'unknown') {
      seatList.push({ key: def.key, name: def.name, short: def.short, ...avail, raw: f[def.idx] });
    }
  }

  return {
    trainNo: (f[2] || '').trim(), // 内部编号，如 240000G53106
    code: trainCode, // 车次，如 G531
    type: trainCode[0] || '?', // G/D/C/Z/T/K/...
    fromCode,
    toCode,
    fromName: (f[4] || '').trim() || map[fromCode] || fromCode, // 出发站（可能是始发站）
    toName: (f[5] || '').trim() || map[toCode] || toCode, // 到达站（可能是终到站）
    boardCode: fromCode, // 实际乘车站
    boardName: map[fromCode] || fromCode,
    alightName: map[toCode] || toCode,
    departTime: (f[8] || '').trim(),
    arriveTime: (f[9] || '').trim(),
    duration: (f[10] || '').trim(),
    canBook: (f[11] || '').trim() === 'Y',
    date: (f[13] || '').trim(),
    seats,
    seatList,
    raw: f,
  };
}

/** 解析整个 result 数组。 */
function parseRows(rawRows, stationMap) {
  const out = [];
  for (const r of rawRows || []) {
    const row = parseRow(r, stationMap);
    if (row) out.push(row);
  }
  return out;
}

/** 该车次是否存在任何"可买"的席位。 */
function hasAnyTicket(row) {
  return row.seatList.some((s) => s.state === 'available');
}

/** 取得指定席位集合里最优的可买状态，用于变化检测。 */
function seatSignature(row) {
  const parts = [];
  for (const def of SEAT_FIELDS) {
    const a = row.seats[def.key];
    if (!a || a.state === 'unknown') continue;
    parts.push(`${def.key}:${a.state}${a.count == null ? '' : ':' + a.count}`);
  }
  return parts.join('|');
}

module.exports = {
  SEAT_FIELDS,
  SEAT_BY_KEY,
  parseRow,
  parseRows,
  normalizeAvailability,
  hasAnyTicket,
  seatSignature,
};
