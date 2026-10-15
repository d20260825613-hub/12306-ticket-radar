'use strict';

/**
 * 通知层：把余票事件推到微信。
 *
 * 通道选型（本机实测约束：PowerShell 网络栈 HTTPS 不可用，故全部走 Node 原生 https）：
 *   pushplus  微信服务号，扫码即用，免费额度足够个人低频提醒  ← 默认
 *   serverchan Server酱³，同样扫码即用，作为备选
 *
 * 隐私：token 只存在本地 data/config.json，不随代码分发、不上传。
 */

const https = require('https');
const querystring = require('querystring');

const CHANNELS = {
  pushplus: {
    name: 'PushPlus',
    host: 'www.pushplus.plus',
    path: '/send',
    // 微信服务号，免费
    build: (cfg, title, content) =>
      JSON.stringify({
        token: cfg.token,
        title,
        content,
        template: cfg.template || 'markdown',
        channel: 'wechat',
      }),
    help: 'https://www.pushplus.plus —— 微信扫码登录后在"一对一推送"页复制 token',
  },
  serverchan: {
    name: 'Server酱³',
    host: 'sctapi.ftqq.com',
    pathFor: (cfg) => `/${cfg.token}.send`,
    build: (cfg, title, content) => querystring.stringify({ title, desp: content }),
    help: 'https://sct.ftqq.com —— 微信扫码登录后复制 SendKey（形如 SCTxxxxx）',
  },
};

function post({ host, path, body, contentType = 'application/json' }) {
  return new Promise((resolve) => {
    const buf = Buffer.from(body, 'utf8');
    const req = https.request(
      {
        host,
        path,
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': buf.length,
          'User-Agent': 'ticket-radar-12306/0.1',
        },
        timeout: 15000,
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('推送超时')));
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end(buf);
  });
}

/** 把事件列表渲染成一条微信消息体。 */
function renderEvents(events) {
  const lines = [];
  for (const e of events) {
    lines.push(`- **${e.trainCode}** ${e.text}`);
  }
  return lines.join('\n');
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** YYYY-MM-DD → “09-26 周六”。手机上看的日期最好直接带星期。 */
function humanDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(s || '');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return String(s || '');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  const md = `${m[2]}-${m[3]}`;
  const wd = WEEKDAYS[d.getDay()];
  if (diff === 0) return `今天 ${wd}`;
  if (diff === 1) return `明天 ${wd}`;
  if (diff === 2) return `后天 ${wd}`;
  return `${md} ${wd}`;
}

/** 到达时刻；跨零点标“次日”，否则用户会以为票错了。 */
function humanArrive(depart, arrive) {
  const t = String(arrive || '').trim();
  if (!t || /^24:00$/.test(t)) return '—';
  const a = String(depart || '').match(/^(\d{1,2}):(\d{2})$/);
  const b = t.match(/^(\d{1,2}):(\d{2})$/);
  if (a && b && Number(b[1]) * 60 + Number(b[2]) < Number(a[1]) * 60 + Number(a[2])) {
    return `次日 ${t}`;
  }
  return t;
}

function renderTicketTable(route, rows) {
  const lines = [`**${route.from} → ${route.to}**  ${humanDate(route.date)}`, ''];
  lines.push('| 车次 | 出发 | 到达 | 可购席位 |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of rows.slice(0, 12)) {
    const seats = r.seatList
      .filter((s) => s.state === 'available' || s.state === 'waitlist')
      .map((s) => `${s.short}${s.text}`)
      .join(' ');
    lines.push(`| ${r.code} | ${r.departTime} | ${humanArrive(r.departTime, r.arriveTime)} | ${seats || '—'} |`);
  }
  return lines.join('\n');
}

/**
 * 发送一条通知。
 * @returns {{ok:boolean, skipped?:boolean, error?:string, channel?:string}}
 */
async function send(cfg, { title, content }) {
  if (!cfg || !cfg.enabled) return { ok: false, skipped: true, error: '微信推送未启用' };
  if (!cfg.token) return { ok: false, skipped: true, error: '未填写推送 token' };

  const ch = CHANNELS[cfg.channel || 'pushplus'];
  if (!ch) return { ok: false, error: `未知推送通道: ${cfg.channel}` };

  const path = ch.pathFor ? ch.pathFor(cfg) : ch.path;
  const body = ch.build(cfg, title, content);
  const contentType = cfg.channel === 'serverchan' ? 'application/x-www-form-urlencoded' : 'application/json';

  const res = await post({ host: ch.host, path, body, contentType });
  if (!res.ok) return { ok: false, channel: ch.name, error: res.error || `HTTP ${res.status}: ${String(res.body).slice(0, 160)}` };

  // 两个通道都是"服务端已接收"语义，需看业务码
  try {
    const j = JSON.parse(res.body);
    const code = j.code !== undefined ? j.code : j.errno;
    if (code !== undefined && Number(code) !== 0 && Number(code) !== 200) {
      return { ok: false, channel: ch.name, error: `业务码 ${code}: ${j.msg || j.message || j.errmsg || ''}` };
    }
  } catch {
    /* 非 JSON 响应（如 Server酱返回 JSON，PushPlus 也返回 JSON），无法解析则按成功处理 */
  }
  return { ok: true, channel: ch.name };
}

async function sendTest(cfg) {
  return send(cfg, {
    title: '12306 余票雷达 · 测试推送',
    content: [
      '这是一条测试消息。',
      '',
      `- 通道：${(CHANNELS[cfg.channel || 'pushplus'] || {}).name || cfg.channel}`,
      `- 时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      '收到即说明微信推送已打通。',
    ].join('\n'),
  });
}

module.exports = { send, sendTest, renderEvents, renderTicketTable, humanDate, humanArrive, CHANNELS };
