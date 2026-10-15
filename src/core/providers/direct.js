'use strict';

/**
 * 直连 12306 的只读查询 provider。
 *
 * 现状（2026-09 实测）：查询端点在"发现"之后的那一跳被加了客户端
 * JS 校验，非浏览器请求一律 302 到 /mormhweb/logFiles/error.html。
 * 因此 ready() 会返回 false，除非显式允许尝试。
 *
 * 保留此实现的原因：该策略随时可能变化，接口恢复后可直接切回，
 * 无需改动上层。也作为 apihz 不可用时的探测探测手段。
 */

const client = require('../client');
const parser = require('../parser');
const stations = require('../stations');

const label = '直连 12306（当前不可用）';
const note = '12306 给查询接口加了客户端校验，非浏览器请求会被拒。保留以备其恢复。';

/**
 * 是否愿意尝试直连。
 *
 * 默认 false：明知会被拦就不要每次都白打一遍请求，
 * 那既浪费时间也增加被风控的概率。用户可在设置里打开"仍然尝试直连"。
 */
function ready(cfg) {
  const sc = cfg || {};
  return sc.provider === 'direct' || sc.tryDirect === true;
}

async function fetchTickets({ date, from, to }) {
  const fromStation = stations.resolve(from);
  const toStation = stations.resolve(to);
  if (!fromStation || !toStation) {
    return { ok: false, error: `站点无法解析: ${from} / ${to}` };
  }

  const session = await client.openSession();
  if (!session.cookie) {
    return { ok: false, error: `会话建立失败: ${session.error || '未知原因'}` };
  }

  const res = await client.queryTickets({
    date,
    fromCode: fromStation.code,
    toCode: toStation.code,
    session,
    minIntervalMs: 1200,
  });

  if (!res.ok) {
    const blocked = /error\.html|风控|端点轮换超过上限|HTTP 302/.test(res.error || '');
    return {
      ok: false,
      blocked,
      error: res.error,
      timing: res.timing,
    };
  }

  return {
    ok: true,
    source: 'direct',
    endpoint: res.endpoint,
    rows: parser.parseRows(res.rows, res.map),
    timing: res.timing,
  };
}

module.exports = { name: 'direct', label, note, ready, fetchTickets };
