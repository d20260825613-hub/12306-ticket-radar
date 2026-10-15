'use strict';

/**
 * 数据源层：把"从哪里拿余票"与"拿到后怎么用"解耦。
 *
 * 存在两种 provider：
 *
 *   direct   —— 直连 12306 的只读查询接口。
 *               2026-09 起该接口加了客户端 JS 校验，非浏览器请求会被
 *               重定向到错误页，因此实际上拿不到数据。保留它是为了
 *               12306 若恢复可用时能直接切换回去。
 *
 *   apihz    —— 第三方合规数据服务（接口盒子 apihz.cn）。
 *               平台自行承担取数与合规责任，使用者只需注册自己的
 *               id/key（免费，10 次/分钟，每日无上限）。这是目前
 *               真正可用的路径。
 *
 * provider 统一契约：
 *   { name, label, ready(cfg), fetchTickets({date, from, to, cfg}) }
 *   fetchTickets 返回 { ok, rows, source, error }
 *   rows 是与 src/core/parser.js 解析结果同构的车次数组。
 */

const direct = require('./direct');
const apihz = require('./apihz');

const PROVIDERS = { direct, apihz };

/** 默认数据源配置。 */
const DEFAULT_SOURCE_CONFIG = {
  /** 'auto' | 'direct' | 'apihz' */
  provider: 'auto',
  apihz: {
    id: '',
    key: '',
    /** 优先使用哪个接入域名，空表示自动挑选 */
    endpoint: '',
  },
  /** 直连失败时是否自动改用第三方 */
  fallbackToApihz: true,
};

/** 按名字取 provider。 */
function get(name) {
  return PROVIDERS[name] || null;
}

/** 列出全部 provider（供界面展示）。 */
function list() {
  return Object.keys(PROVIDERS).map((k) => ({
    id: k,
    label: PROVIDERS[k].label,
    ready: false, // 需结合配置判断
    note: PROVIDERS[k].note || '',
  }));
}

/**
 * 依据配置与可用性挑选 provider。
 *
 * auto 的语义：优先直连（数据最一手、无第三方依赖），
 * 直连不可用时自动改用第三方 —— 前提是第三方已配置。
 *
 * @returns {{provider:object, reason:string}|{provider:null, reason:string}}
 */
function pick(cfg) {
  const sc = Object.assign({}, DEFAULT_SOURCE_CONFIG, cfg || {});
  const directReady = direct.ready(sc);
  const apihzReady = apihz.ready(sc);

  if (sc.provider === 'direct') {
    return directReady
      ? { provider: direct, reason: '按配置使用直连 12306' }
      : { provider: null, reason: '配置要求直连 12306，但该通道当前不可用' };
  }

  if (sc.provider === 'apihz') {
    return apihzReady
      ? { provider: apihz, reason: '按配置使用第三方数据源' }
      : { provider: null, reason: '配置要求使用第三方数据源，但尚未填写 id/key' };
  }

  // auto：先直连，失败再退到第三方
  if (directReady) return { provider: direct, reason: '自动选择：直连 12306' };
  if (sc.fallbackToApihz && apihzReady) {
    return { provider: apihz, reason: '直连 12306 不可用，已自动改用第三方数据源' };
  }
  return {
    provider: null,
    reason: directReady
      ? '无可用的数据源'
      : '直连 12306 不可用，且第三方数据源未配置（请在设置里填写 id/key）',
  };
}

/** 当前是否存在任何可用数据源。 */
function anyReady(cfg) {
  return !!pick(cfg).provider;
}

module.exports = {
  PROVIDERS,
  DEFAULT_SOURCE_CONFIG,
  get,
  list,
  pick,
  anyReady,
};
