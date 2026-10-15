'use strict';

/**
 * 站点解析。
 *
 * 12306 公开的 station_name.js 每条记录形如：
 *   bjb|北京北|VAP|beijingbei|bjb|0|0357|北京|||
 * 字段：简拼|中文名|电报码|全拼|简拼|序号|城市码|所属城市|||
 *
 * 本模块只做本地查表，不产生任何网络请求。
 */

const fs = require('fs');
const path = require('path');

const STATION_FILE = path.join(__dirname, '..', '..', 'data', 'station_name.js');

let stations = null; // [{ short, name, code, pinyin, cityCode, city }]
let byCode = null; // Map<telecode, station>
let byName = null; // Map<chineseName, station[]>

function parseStationFile(text) {
  const m = text.match(/'([^']*)'/);
  if (!m) throw new Error('station_name.js 格式无法识别（未找到引号包裹的站点表）');

  const list = [];
  for (const chunk of m[1].split('@')) {
    if (!chunk) continue;
    const c = chunk.split('|');
    if (c.length < 3) continue;
    const name = (c[1] || '').trim();
    const code = (c[2] || '').trim().toUpperCase();
    if (!name || !code) continue;
    list.push({
      short: (c[0] || '').trim(),
      name,
      code,
      pinyin: (c[3] || '').trim(),
      cityCode: (c[6] || '').trim(),
      city: (c[7] || '').trim(),
    });
  }
  return list;
}

function load(force) {
  if (stations && !force) return stations;

  if (!fs.existsSync(STATION_FILE)) {
    throw new Error(
      `站点表缺失: ${STATION_FILE}\n` +
        '请先运行: node tools/fetch_stations.js'
    );
  }
  const text = fs.readFileSync(STATION_FILE, 'utf8');
  stations = parseStationFile(text);

  byCode = new Map();
  byName = new Map();
  for (const s of stations) {
    if (!byCode.has(s.code)) byCode.set(s.code, s);
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  return stations;
}

/** 解析用户输入：支持中文名 / 电报码 / 全拼 / 简拼。返回 {code,name} 或 null。 */
function resolve(input) {
  load();
  const q = String(input == null ? '' : input).trim();
  if (!q) return null;

  const upper = q.toUpperCase();
  if (byCode.has(upper)) {
    const s = byCode.get(upper);
    return { code: s.code, name: s.name };
  }

  if (byName.has(q)) {
    const list = byName.get(q);
    // 同名车站取第一个（12306 站名基本唯一，同名极罕见）
    return { code: list[0].code, name: list[0].name };
  }

  const lower = q.toLowerCase();
  const hits = stations.filter((s) => s.pinyin === lower || s.short === lower);
  if (hits.length) return { code: hits[0].code, name: hits[0].name };

  // 退化为前缀匹配，方便"北京"→"北京南"这类模糊输入
  const prefix = stations.filter((s) => s.name.startsWith(q));
  if (prefix.length) return { code: prefix[0].code, name: prefix[0].name };

  return null;
}

/** 电报码 → 中文名；查不到时原样返回。 */
function nameOf(code) {
  load();
  const s = byCode.get(String(code || '').toUpperCase());
  return s ? s.name : String(code || '');
}

/** 城市名 → 该城市所有车站，用于"邻站出发"分流建议。 */
function stationsInCity(city) {
  load();
  return stations.filter((s) => s.city === city || s.name.startsWith(city));
}

function count() {
  load();
  return stations.length;
}

module.exports = { load, resolve, nameOf, stationsInCity, count, STATION_FILE };
