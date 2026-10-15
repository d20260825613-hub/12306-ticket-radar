'use strict';

/* ══════════════════════════════════════════════════════════
   12306 余票雷达 — 前端
   无框架、无构建。数据经 /api/state 与 SSE 获取。
   ══════════════════════════════════════════════════════════ */

const SEAT_FIELDS = [
  { key: 'business', name: '商务座', short: '商务' },
  { key: 'first', name: '一等座', short: '一等' },
  { key: 'second', name: '二等座', short: '二等' },
  { key: 'topGrade', name: '高级软卧', short: '高软' },
  { key: 'softSleeper', name: '软卧', short: '软卧' },
  { key: 'deluxeSleeper', name: '动卧', short: '动卧' },
  { key: 'hardSleeper', name: '硬卧', short: '硬卧' },
  { key: 'softSeat', name: '软座', short: '软座' },
  { key: 'hardSeat', name: '硬座', short: '硬座' },
  { key: 'noSeat', name: '无座', short: '无座' },
  { key: 'preferredFirst', name: '优选一等座', short: '优选一等' },
];

/**
 * 监控日期选项。
 *
 * 上限 14 天：12306 预售期约 14 天，超出后任何数据源都查不到。
 * 曾经提供 30/45 天选项且默认 45 —— 选中必然拿不到数据，
 * 而"测试连接"用的是 7 天所以能成功，两者不一致极具误导性。已移除。
 */
const DATE_PRESETS = [
  { v: 1, label: '明天' },
  { v: 2, label: '后天' },
  { v: 3, label: '3 天后' },
  { v: 7, label: '7 天后' },
  { v: 10, label: '10 天后' },
  { v: 14, label: '14 天后（预售上限）' },
];

const S = {
  view: 'radar',
  data: null,
  routeIdx: 0,
  busy: false,
  filters: { q: '', onlyAvail: false, sort: 'depart', type: 'all' },
  stations: null,
  acIdx: -1,
  acList: [],
  acTarget: null,
  liveTimer: null,
};

const $ = (id) => document.getElementById(id);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (ts) => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const hhmmss = (ts) => { const d = new Date(ts); return `${hhmm(ts)}:${pad2(d.getSeconds())}`; };

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 把 YYYY-MM-DD 解析为本地日期对象（避免时区把日期挪一天）。 */
function parseDateStr(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 人性化日期：今天 / 明天 / 后天 / 09-26 周六。
 * 用户看"2026-09-26"要在脑子里换算星期几，直接给出来更省事。
 */
function fmtDate(s, opts) {
  const d = parseDateStr(s);
  if (!d) return String(s || '');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  const wd = WEEKDAYS[d.getDay()];
  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  if (!opts || !opts.short) {
    if (diff === 0) return `今天 ${wd}`;
    if (diff === 1) return `明天 ${wd}`;
    if (diff === 2) return `后天 ${wd}`;
  }
  return `${md} ${wd}`;
}

/** 距今天数，用于列表上的"3 天后"。 */
function daysFromToday(s) {
  const d = parseDateStr(s);
  if (!d) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}

/** 该时刻是否为无效占位值（平台上"当日不开行"会出现 24:00）。 */
function isPlaceholderTime(t) {
  return /^24:00$/.test(String(t || '').trim());
}

/**
 * 判断到达是否在**次日**。
 *
 * 实测大量车次（Z/T/D 字头）出发 19:10、到达 08:44 ——
 * 到达时间数字上比出发小。不标"次日"的话用户会以为票错了。
 */
function isNextDay(depart, arrive) {
  const a = String(depart || '').match(/^(\d{1,2}):(\d{2})$/);
  const b = String(arrive || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!a || !b) return false;
  if (isPlaceholderTime(depart) || isPlaceholderTime(arrive)) return false;
  const dep = Number(a[1]) * 60 + Number(a[2]);
  const arr = Number(b[1]) * 60 + Number(b[2]);
  return arr < dep;
}

/**
 * 人性化到达时刻：跨零点时加"次日"并给出相对天数的通俗写法。
 * 例：19:10 出发、08:44 到达 → “次日 08:44”
 */
function fmtArriveTime(depart, arrive) {
  const t = String(arrive || '').trim();
  if (!t) return '—';
  if (isPlaceholderTime(t)) return '—';
  return isNextDay(depart, arrive) ? `次日 ${t}` : t;
}

/** 「05:56」原样；「99:59」这类占位值显示为 —。 */
function fmtDuration(dur) {
  const s = String(dur || '').trim();
  if (!s) return '—';
  if (/^9\d:\d{2}$/.test(s)) return '—'; // 平台占位值
  return s;
}

function ago(ts) {
  if (!ts) return '未采集';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
function dayLabel(ts) {
  const k = dayKey(ts);
  if (k === dayKey(Date.now())) return '今天';
  if (k === dayKey(Date.now() - 86400000)) return '昨天';
  return `${k} ${WEEKDAYS[new Date(ts).getDay()]}`;
}

/* ══════════════ Toast ══════════════ */

function toast(title, sub, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.innerHTML = `<b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}`;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 260);
  }, 3600);
}

/* ══════════════ API ══════════════ */

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    return await res.json();
  } catch {
    return { ok: false, error: `HTTP ${res.status}` };
  }
}

async function refresh() {
  const d = await api('/api/state');
  if (d && d.config) { S.data = d; render(); }
}

/* ══════════════ 派生数据 ══════════════ */

function curRoute() {
  const d = S.data;
  if (!d || !d.routes || !d.routes.length) return null;
  if (S.routeIdx >= d.routes.length) S.routeIdx = 0;
  return d.routes[S.routeIdx];
}

/** 统计一条线路里"至少有一个可购席位"的车次数。 */
function hitCount(rows) {
  if (!rows) return null;
  let n = 0;
  for (const r of rows) {
    if (Object.values(r.seats || {}).some((s) => s && s.state === 'available')) n++;
  }
  return n;
}

/** 按关注席位筛选 + 排序 + 过滤。 */
function applyFilters(rows, route) {
  const want = (route && route.raw && route.raw.seats) || [];
  const f = S.filters;
  let out = rows.slice();

  if (f.q) {
    const q = f.q.trim().toUpperCase();
    out = out.filter((r) => r.code.toUpperCase().includes(q));
  }
  if (f.type !== 'all') {
    out = out.filter((r) => r.type === f.type);
  }
  if (f.onlyAvail) {
    out = out.filter((r) =>
      Object.entries(r.seats || {}).some(
        ([k, s]) => s && s.state === 'available' && (!want.length || want.includes(k))
      )
    );
  }

  const score = (r) => {
    const order = want.length ? want : ['second', 'first', 'business'];
    let best = 99;
    for (const k of order) {
      const s = r.seats[k];
      if (s && s.state === 'available') best = Math.min(best, order.indexOf(k));
    }
    return best;
  };

  if (f.sort === 'depart') out.sort((a, b) => a.departTime.localeCompare(b.departTime));
  else if (f.sort === 'arrive') out.sort((a, b) => a.arriveTime.localeCompare(b.arriveTime));
  else if (f.sort === 'duration') out.sort((a, b) => String(a.duration).localeCompare(String(b.duration)));
  else if (f.sort === 'seats') out.sort((a, b) => score(a) - score(b) || a.departTime.localeCompare(b.departTime));

  return out;
}

function seatColumns(route) {
  const want = (route && route.raw && route.raw.seats) || [];
  if (want.length) return SEAT_FIELDS.filter((s) => want.includes(s.key));
  return SEAT_FIELDS.filter((s) => ['second', 'first', 'business', 'noSeat'].includes(s.key));
}

/**
 * 官方查询页深链。
 * 注意：fs / ts 的格式是「站名,电报码」，中间的**逗号必须是字面逗号**，
 * 不能用 encodeURIComponent 整体编码（会变成 %2C 导致 12306 无法识别）。
 * 只对站名单独编码。
 */
function bookUrl(route, row) {
  const fs = `${encodeURIComponent(route.from)},${route.fromCode || ''}`;
  const ts = `${encodeURIComponent(route.to)},${route.toCode || ''}`;
  return (
    'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc' +
    `&fs=${fs}&ts=${ts}` +
    `&date=${encodeURIComponent(route.date)}&flag=N,N,Y`
  );
}

/* ══════════════ 渲染入口 ══════════════ */

function render() {
  const d = S.data;
  if (!d) return;
  renderRail(d);
  renderList(d);
  renderMain(d);
}

function renderRail(d) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));

  $('pillRoutes').textContent = String((d.routes || []).length);

  const lat = (d.latency || []).slice().reverse().find((x) => x.ttfb != null);
  $('pillLatency').textContent = lat ? `${lat.ttfb}ms` : '—';

  const unread = d.unread || 0;
  const pe = $('pillEvents');
  pe.hidden = unread === 0;
  pe.textContent = String(unread);

  $('brandVer').textContent = d.version ? 'v' + d.version : '12306';

  const diag = d.diagnostics || {};
  const ds = d.dataSource || {};
  const card = $('statusCard');
  card.className = 'status-card';
  let text = '待命', sub = '尚无采集记录';

  if (!ds.anyReady) {
    card.classList.add('off');
    text = '未接数据源';
    sub = '去设置里填写，即可看到余票';
  } else if (diag.lastOkAt) {
    card.classList.add('on');
    text = '运行中';
    sub = `${sourceLabel(ds.active)} · ${d.intervalSec}s · ${hhmmss(diag.lastRunAt)}`;
  } else if (diag.consecutiveFailures > 0) {
    card.classList.add('warn');
    text = '采集失败';
    sub = `连续 ${diag.consecutiveFailures} 次 · 稍后自动重试`;
  } else {
    card.classList.add('warn');
    text = '准备中';
    sub = '等待首次采集';
  }
  $('statusText').textContent = text;
  $('statusSub').textContent = sub;
}

function renderList(d) {
  const titles = {
    radar: '余票雷达', latency: '网络延迟', events: '提醒记录',
    help: '怎么抢到票', settings: '设置',
  };
  $('listTitle').textContent = titles[S.view] || '余票雷达';

  const body = $('listBody');
  const search = $('listSearchWrap');
  search.hidden = S.view !== 'radar';

  if (S.view === 'radar') {
    const routes = d.routes || [];
    $('listSub').textContent = `${routes.length} 条监控`;
    if (!routes.length) {
      body.innerHTML = emptyState('还没有监控区间', '点右上角 ＋ 添加一个出发站和到达站');
      return;
    }
    const q = ($('listSearch').value || '').trim();
    const shown = routes
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => !q || `${r.from}${r.to}`.includes(q));

    body.innerHTML = shown.length
      ? shown
          .map(({ r, i }) => {
            const hits = hitCount(r.rows);
            const meta =
              hits === null
                ? '<span class="muted">尚未采集</span>'
                : hits > 0
                ? `<span class="hit">${hits} 趟有票</span>`
                : '暂无可购';
            return `<div class="route ${i === S.routeIdx ? 'active' : ''}" data-idx="${i}">
        <div class="route-top">
          <div class="route-name">${esc(r.from)}<span class="arrow">→</span>${esc(r.to)}</div>
          <div class="route-date">${esc(fmtDate(r.date, { short: true }))}</div>
        </div>
        <div class="route-meta">${meta}<span>·</span><span>${esc(ago(r.updatedAt))}</span></div>
        <button class="route-del" data-del="${i}" title="删除该监控">
          <svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 12H7L6 9zm3 2v8h2v-8H9zm4 0v8h2v-8h-2z"/></svg>
        </button>
      </div>`;
          })
          .join('')
      : emptyState('没有匹配的区间', '换个关键词试试');

    body.querySelectorAll('.route').forEach((el) => {
      el.onclick = (ev) => {
        if (ev.target.closest('[data-del]')) return;
        S.routeIdx = Number(el.dataset.idx);
        render();
      };
    });
    body.querySelectorAll('[data-del]').forEach((btn) => {
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        const i = Number(btn.dataset.del);
        const r = d.routes[i];
        if (!confirm(`删除监控「${r.from} → ${r.to}」？`)) return;
        await api('/api/routes/delete', { from: r.raw.from, to: r.raw.to, dateOffset: r.raw.dateOffset });
        S.routeIdx = 0;
        await refresh();
        toast('已删除监控区间');
      };
    });
  } else if (S.view === 'latency') {
    const lat = d.latency || [];
    $('listSub').textContent = `${lat.length} 个采样点`;
    const st = lat.filter((x) => x.kind === 'static');
    const qu = lat.filter((x) => x.kind === 'query');
    body.innerHTML = `<div class="card-body">
      ${miniStat('静态资源', st.length ? st[st.length - 1].ttfb : null, st.length)}
      ${miniStat('查询端点', qu.length ? qu[qu.length - 1].ttfb : null, qu.length)}
      ${miniStat('TLS 握手', st.length ? st[st.length - 1].tls : null, st.length)}
    </div>`;
  } else if (S.view === 'events') {
    const evs = d.events || [];
    $('listSub').textContent = `${evs.length} 条记录`;
    body.innerHTML = evs.length
      ? evs
          .slice(0, 40)
          .map(
            (e) => `<div class="route" data-ev="${e.ts}">
        <div class="route-top">
          <div class="route-name">${esc(e.trainCode)} · ${esc(e.seatName || '')}</div>
          <div class="route-date">${hhmm(e.ts)}</div>
        </div>
        <div class="route-meta"><span>${esc(e.route || '')}</span></div>
      </div>`
          )
          .join('')
      : emptyState('还没有提醒', '余票出现变化时会记录在这里');
  } else {
    const c = d.config || { wechat: {} };
    $('listSub').textContent = c.wechat && c.wechat.enabled ? '微信推送已启用' : '微信推送未启用';
    body.innerHTML = `<div class="card-body">
      ${miniText('配置文件', 'data/config.json')}
      ${miniText('推送通道', (c.wechat && c.wechat.channel) || '—')}
      ${miniText('站点库', `${d.stationCount} 站`)}
      ${miniText('采集间隔', `${d.intervalSec}s`)}
    </div>`;
  }

  const foot = $('footNote');
  foot.textContent = d.rushNow ? '整点放票窗口 · 已提速' : `${d.stationCount} 站 · ${d.intervalSec}s 间隔`;
}

function emptyState(title, sub) {
  return `<div class="empty">
    <svg viewBox="0 0 24 24"><path d="M12 2c-5 0-9 4-9 9v6a2 2 0 0 0 2 2h2v-7H5v-1a7 7 0 1 1 14 0v1h-2v7h2a2 2 0 0 0 2-2v-6c0-5-4-9-9-9z"/></svg>
    <b>${esc(title)}</b><p>${esc(sub)}</p></div>`;
}

function miniStat(k, v, n) {
  return `<div class="stat" style="box-shadow:none;padding:10px 0">
    <div class="k">${esc(k)}</div>
    <div class="v" style="font-size:20px">${v != null ? v : '—'}<small>ms</small></div>
    <div class="f">${n} 个采样点</div>
  </div>`;
}
function miniText(k, v) {
  return `<div class="stat" style="box-shadow:none;padding:9px 0">
    <div class="k">${esc(k)}</div>
    <div style="font-size:13px;margin-top:3px">${esc(v)}</div>
  </div>`;
}

/* ══════════════ 主区 ══════════════ */

function renderMain(d) {
  if (S.view === 'radar') return viewRadar(d);
  if (S.view === 'latency') return viewLatency(d);
  if (S.view === 'events') return viewEvents(d);
  if (S.view === 'help') return viewHelp(d);
  return viewSettings(d);
}

function setActions(html) {
  $('mainActions').innerHTML = html;
}

/** 设置主区内容。抽出来是为了让"每处渲染都走同一条路"。 */
function setMainHtml(html) {
  $('mainBody').innerHTML = html;
}

/** 复制到剪贴板，返回是否成功。 */
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 需要安全上下文或用户手势，退回 execCommand */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 绑定所有 .copyable 元素的点击复制。 */
function bindCopyable(root) {
  (root || document).querySelectorAll('.copyable').forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const text = el.dataset.copy || el.textContent.trim();
      const ok = await copyText(text);
      if (ok) {
        el.classList.add('done');
        setTimeout(() => el.classList.remove('done'), 1400);
      } else {
        toast('复制失败', '请手动选中车次号', 'err');
      }
    };
  });
}

/* ══════════════ 通用确认弹层 ══════════════ */

let confirmResolve = null;

function askConfirm(opts) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('confirmTitle').textContent = opts.title || '确认';
    $('confirmText').innerHTML = opts.html || '';
    $('confirmYes').textContent = opts.yes || '确定';
    $('confirmNo').textContent = opts.no || '取消';
    $('confirmMask').hidden = false;
  });
}

function closeConfirm(result) {
  $('confirmMask').hidden = true;
  if (confirmResolve) {
    const r = confirmResolve;
    confirmResolve = null;
    r(result);
  }
}

/* ---------- 余票雷达 ---------- */

/** 余票雷达主标题下方的摘要行（实时刷新时复用，避免字符串拼接出错）。 */
function updateRadarSub(route) {
  const rows = route.rows;
  const hits = hitCount(rows);
  const days = daysFromToday(route.date);
  const dayHint = days === null ? '' : days === 0 ? '（今天）' : days > 0 ? `（${days} 天后）` : `（${-days} 天前）`;

  $('mainTitle').textContent = `${route.from} → ${route.to}`;
  $('mainSub').textContent =
    `${fmtDate(route.date)}${dayHint} · ${rows ? rows.length + ' 趟车次' : '尚无数据'}` +
    (hits ? ` · ${hits} 趟有票` : '') +
    ` · ${ago(route.updatedAt)}`;
}

function viewRadar(d) {
  const route = curRoute();
  const body = $('mainBody');

  if (!route) {
    $('mainTitle').textContent = '余票雷达';
    $('mainSub').textContent = '尚未配置监控区间';
    setActions('');

    // 新用户常常先去配数据源，所以这里也必须提供入口 ——
    // 曾经这张卡只有「添加监控区间」，导致没有线路时无处可点、进不了设置填 KEY。
    const dsReady = (d.dataSource || {}).anyReady;
    const dsBtn = dsReady
      ? ''
      : '<button class="btn-ghost" id="btnOnboardDs">先去配置数据源（填 KEY）</button>';

    setMainHtml(`<div class="onboard">
      <h2>先加一个监控区间</h2>
      <p>
        告诉它你要坐哪条线，它就会替你盯着余票，有变化时通过微信叫你 ——
        你就不用一直刷新页面了。
      </p>
      <div class="row">
        <button class="btn-primary" id="btnOnboardAdd">添加监控区间</button>
        ${dsBtn}
        <button class="btn-ghost" id="btnOnboardHelp">为什么这样最有效</button>
      </div>
      ${
        dsReady
          ? ''
          : `<p style="margin:14px 0 0;font-size:12.5px;color:var(--text-3)">
               提示：还得先接一个数据源才能看到余票，否则加完线路也是空的。
             </p>`
      }
    </div>`);
    $('btnOnboardAdd').onclick = openModal;
    $('btnOnboardHelp').onclick = async () => { S.view = 'help'; await refresh(); };
    const onDs = $('btnOnboardDs');
    if (onDs) onDs.onclick = async () => { S.view = 'settings'; await refresh(); };
    return;
  }

  const rows = route.rows;
  updateRadarSub(route);
  setActions(radarActions());

  let html = guidance(d);

  if (!rows) {
    html += emptyState('还没有采集到数据', '点左下角「立即刷新」，或等待下一个采集周期');
    setMainHtml(html);
    bindGuidanceActions();
    return;
  }
  if (!rows.length) {
    html += emptyState('该区间该日期没有车次', '可能超出预售期（通常 15 天），或该区间没有直达车');
    setMainHtml(html);
    bindGuidanceActions();
    return;
  }

  const cols = seatColumns(route);
  const list = applyFilters(rows, route);

  const types = [...new Set(rows.map((r) => r.type))].sort();
  const availCount = hitCount(rows);

  html += `<div class="toolbar">
    <svg viewBox="0 0 24 24" style="width:15px;height:15px;fill:var(--text-3)"><path d="M10 2a8 8 0 1 0 4.9 14.3l4.4 4.4 1.4-1.4-4.4-4.4A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z"/></svg>
    <input class="tb-input" id="fQ" placeholder="筛选车次" value="${esc(S.filters.q)}">
    <span class="tb-label">车型</span>
    <select class="tb-select" id="fType">
      <option value="all">全部</option>
      ${types.map((t) => `<option value="${esc(t)}" ${S.filters.type === t ? 'selected' : ''}>${esc(t)} 字头</option>`).join('')}
    </select>
    <span class="tb-label">排序</span>
    <select class="tb-select" id="fSort">
      <option value="depart" ${S.filters.sort === 'depart' ? 'selected' : ''}>出发时间</option>
      <option value="arrive" ${S.filters.sort === 'arrive' ? 'selected' : ''}>到达时间</option>
      <option value="duration" ${S.filters.sort === 'duration' ? 'selected' : ''}>历时最短</option>
      <option value="seats" ${S.filters.sort === 'seats' ? 'selected' : ''}>关注席位优先</option>
    </select>
    <label class="switch">
      <input type="checkbox" id="fAvail" ${S.filters.onlyAvail ? 'checked' : ''}>
      <span class="track"></span><span>只看有票</span>
    </label>
    <div class="grow"></div>
    <span class="tb-label">${list.length} / ${rows.length} 趟${availCount ? ` · ${availCount} 趟有票` : ''}</span>
  </div>`;

  const tbody = list.length
    ? list.map((row) => renderTicketRow(row, cols, route)).join('')
    : `<tr><td colspan="6" style="padding:0">${emptyState('没有符合筛选条件的车次', '试试关掉「只看有票」或清空筛选词')}</td></tr>`;

  html += seatSummary(list, cols);

  html += `<div class="card">
    <div class="card-head">
      <h3>余票明细</h3>
      <span class="sub">${hhmmss(route.updatedAt)} 更新 · 端点 ${esc(route.endpoint || '—')}</span>
    </div>
    <div class="card-body tight table-wrap">
      <table class="grid">
        <thead><tr>
          <th>车次</th><th>出发</th><th>到达</th><th>历时</th><th>席位（余票）</th><th></th>
        </tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>
  </div>`;

  html += orderHint();
  setMainHtml(html);

  bindCopyable($('mainBody'));
  bindGuidanceActions();

  $('fQ').oninput = (e) => { S.filters.q = e.target.value; renderPreserveFocus('fQ'); };
  $('fType').onchange = (e) => { S.filters.type = e.target.value; render(); };
  $('fSort').onchange = (e) => { S.filters.sort = e.target.value; render(); };
  $('fAvail').onchange = (e) => { S.filters.onlyAvail = e.target.checked; render(); };
}

/**
 * 绑定引导卡里的跳转按钮。
 *
 * 必须抽成函数并在**每个渲染分支**都调用 —— 之前只在函数末尾绑定，
 * 而"还没有采集到数据 / 没有车次"这两个分支会提前 return，
 * 导致引导卡渲染出来了、按钮却没人处理，点了毫无反应
 * （用户报的"连 key 窗口都打不开"就是这个）。
 */
function bindGuidanceActions() {
  const goDs = $('btnGoDs');
  if (goDs) goDs.onclick = async () => { S.view = 'settings'; await refresh(); };

  const goWx = $('btnGoWx');
  if (goWx) goWx.onclick = async (e) => { e.preventDefault(); S.view = 'settings'; await refresh(); };

  const gHelp = $('btnGuidesHelp');
  if (gHelp) gHelp.onclick = async () => { S.view = 'help'; await refresh(); };

  const retry = $('btnRetryHelp');
  if (retry) retry.onclick = () => poll();
}

/** 余票雷达视图右上角的操作按钮。 */
function radarActions() {
  return `
    <button class="btn-mini" id="btnOpenOfficial">
      <svg viewBox="0 0 24 24" style="width:13px;height:13px"><path d="M14 3v2h3.6l-9.3 9.3 1.4 1.4L19 6.4V10h2V3h-7zM5 5h5V3H3v18h18v-7h-2v5H5V5z"/></svg>
      官方查询页
    </button>
    <button class="btn-mini" id="btnHelp">怎么抢到票</button>
    <button class="btn-mini danger" id="btnStop" title="停止程序">停止程序</button>`;
}

/**
 * 渲染一个席位标签。
 *
 * 余票数量有且只有三种情况，必须区分清楚，否则极易误读：
 *   - 明确无票           → “无”
 *   - 有票且有具体数量    → “有 12”
 *   - 有票但平台未公布数量 → “有 · 数量未公布”
 *
 * 第三种最容易被当成"没有数据"或"没票"，所以显式写出"未公布"。
 * 平台实测：京沪高铁的二等座多数只给"有"，而普速/部分车次会给具体数字。
 */
function renderSeatChip(name, s) {
  const label = `<span class="sn">${esc(name)}</span>`;

  if (s.state === 'none') {
    return `<span class="seat none" title="${esc(name)}：无票">${label}<span class="n">无</span></span>`;
  }
  if (s.state === 'waitlist') {
    return `<span class="seat waitlist" title="${esc(name)}：需候补">${label}<span class="n">候补</span></span>`;
  }
  if (s.state === 'available' && s.count !== null && s.count !== undefined) {
    return `<span class="seat available" title="${esc(name)}：余票 ${s.count} 张"><span class="num">${s.count}</span><span class="sn">${esc(name)}</span></span>`;
  }
  if (s.state === 'available') {
    return `<span class="seat available noqty" title="${esc(name)}：有票，平台未公布具体数量">${label}<span class="n">数量未公布</span></span>`;
  }
  return `<span class="seat other" title="${esc(name)}：${esc(s.text || '')}">${label}<span class="n">${esc(s.text)}</span></span>`;
}

/** 该席位是否给出了具体余票数量。 */
function hasCount(s) {
  return !!(s && s.state === 'available' && s.count !== null && s.count !== undefined);
}

/** 表格里的一行。 */
function renderTicketRow(row, cols, route) {
  const anyAvail = cols.some((c) => row.seats[c.key] && row.seats[c.key].state === 'available');
  // 有余票数量信息的席位排前面，方便先看到确切数字
  const ordered = cols.slice().sort((a, b) => {
    const ca = hasCount(row.seats[a.key]) ? 0 : 1;
    const cb = hasCount(row.seats[b.key]) ? 0 : 1;
    return ca - cb;
  });
  const seats = ordered.map((c) => {
    const s = row.seats[c.key];
    if (!s || s.state === 'unknown') return '';
    return renderSeatChip(c.short, s);
  }).join('');

  // 跨零点的车次必须标"次日"，否则"19:10 开、08:44 到"会让人以为票错了
  const nextDay = isNextDay(row.departTime, row.arriveTime);
  const arriveText = fmtArriveTime(row.departTime, row.arriveTime);
  const durText = fmtDuration(row.duration);

  return `<tr class="${anyAvail ? 'hit' : ''}">
    <td><div class="train">
      <button class="copyable" data-copy="${esc(row.code)}" title="点击复制车次号"><b>${esc(row.code)}</b></button>
      <small>${esc(row.fromName)}→${esc(row.toName)}</small>
    </div></td>
    <td class="time"><b>${esc(row.departTime)}</b><small>${esc(row.fromName)}</small></td>
    <td class="time${nextDay ? ' nextday' : ''}"><b>${esc(arriveText)}</b><small>${esc(row.toName)}${nextDay ? ' · 跨日' : ''}</small></td>
    <td class="dur">${esc(durText)}</td>
    <td><div class="seat-cell">${seats || '<span style="color:var(--text-3)">—</span>'}</div></td>
    <td>${anyAvail ? `<a class="book" href="${bookUrl(route, row)}" target="_blank" rel="noopener">去下单<svg viewBox="0 0 24 24"><path d="M14 3v2h3.6l-9.3 9.3 1.4 1.4L19 6.4V10h2V3h-7zM5 5h5V3H3v18h18v-7h-2v5H5V5z"/></svg></a>` : ''}</td>
  </tr>`;
}

/**
 * 列表上方的余票统计摘要。
 * 让用户一眼知道"有几趟能买、其中几张有确切数量"。
 */
function seatSummary(rows, cols) {
  let withCount = 0;
  let availOnly = 0;
  for (const row of rows) {
    for (const c of cols) {
      const s = row.seats[c.key];
      if (!s || s.state !== 'available') continue;
      if (hasCount(s)) withCount++;
      else availOnly++;
    }
  }
  if (!withCount && !availOnly) return '';

  const parts = [];
  if (withCount) parts.push(`<b>${withCount}</b> 个席位有确切余票数量`);
  if (availOnly) parts.push(`${availOnly} 个席位只显示"有票"`);

  return `<div class="notice info" style="margin-bottom:12px">
    <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
    <div>
      本页共 ${parts.join('、')}。
      12306 对部分席位只公布"有票/无票"、不给具体张数，所以会看到"数量未公布"——
      <b>它表示有余票，只是不知道剩几张</b>，不等于没票。
    </div>
  </div>`;
}

/** 下单提醒。 */
function orderHint() {
  return `<div class="notice info">
    <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
    <div>
      绿底车次有可购席位，点「去下单」跳到 12306 官方查询页，<b>下单在官方完成</b>。
      直接点车次号可以复制，方便切到手机 App 里搜。
    </div>
  </div>`;
}

/** 重渲染但保留输入框焦点与光标位置（筛选输入时用）。 */
function renderPreserveFocus(id) {
  const el = $(id);
  const pos = el ? el.selectionStart : null;
  render();
  const next = $(id);
  if (next) {
    next.focus();
    if (pos != null) next.setSelectionRange(pos, pos);
  }
}

/**
 * 顶部提示。
 *
 * 设计取舍：用户打开这个页面是想买票，不是来读技术报告的。
 * 所以优先回答"我现在该做什么"，技术细节折叠起来备查。
 *
 * 两种状态：
 *   - 没配数据源  → 直接给开通步骤（这是唯一能让他看到余票的动作）
 *   - 配了但失败  → 说清失败原因与重试方式
 */
function guidance(d) {
  const diag = d.diagnostics || {};
  const ds = d.dataSource || {};
  const wx = (d.config && d.config.wechat) || {};

  // 还没有可用的数据源：最重要的事就是引导配置
  if (!ds.anyReady) {
    return `<div class="action-card">
      <div class="action-head">
        <h3>
          <svg viewBox="0 0 24 24" style="fill:var(--green)"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
          还差一步就能看到余票
        </h3>
        <p>
          12306 给查询接口加了客户端校验，程序没法直接查。
          接一个<b>第三方合规数据源</b>就能正常显示余票 —— 免费，注册后填两个参数即可。
        </p>
      </div>
      <div class="steps">
        <div class="step">
          <div class="step-n">1</div>
          <div class="step-b">
            <b>去接口盒子注册一个免费账号</b>
            <p>
              打开 <a href="https://www.apihz.cn/user/" target="_blank" rel="noopener">apihz.cn/user</a> 注册（免费）。
              额度：<span class="hl">10 次/分钟、每日无上限</span>，个人盯票完全够用。
            </p>
          </div>
        </div>
        <div class="step">
          <div class="step-n">2</div>
          <div class="step-b">
            <b>在「个人资料」里复制 开发者ID 和 开发者KEY</b>
            <p>两个都是数字/字母串，复制过来即可。</p>
          </div>
        </div>
        <div class="step">
          <div class="step-n">3</div>
          <div class="step-b">
            <b>填到下面的设置里，点「测试连接」</b>
            <p>测试通过后，余票就会自动显示，有变化还会推到你微信。</p>
          </div>
        </div>
      </div>
      <div class="action-foot">
        <button class="btn-primary" id="btnGoDs">
          <svg viewBox="0 0 24 24"><path d="M19.1 12.9a7.6 7.6 0 0 0 0-1.8l2-1.6a.5.5 0 0 0 .1-.6l-1.9-3.3a.5.5 0 0 0-.6-.2l-2.4 1a7.3 7.3 0 0 0-1.6-.9l-.4-2.6a.5.5 0 0 0-.5-.4h-3.8a.5.5 0 0 0-.5.4l-.4 2.6c-.6.2-1.1.6-1.6.9l-2.4-1a.5.5 0 0 0-.6.2L2.7 8.9a.5.5 0 0 0 .1.6l2 1.6a7.6 7.6 0 0 0 0 1.8l-2 1.6a.5.5 0 0 0-.1.6l1.9 3.3c.1.2.4.3.6.2l2.4-1c.5.4 1 .7 1.6.9l.4 2.6c0 .2.2.4.5.4h3.8c.2 0 .4-.2.5-.4l.4-2.6c.6-.2 1.1-.6 1.6-.9l2.4 1c.2.1.5 0 .6-.2l1.9-3.3a.5.5 0 0 0-.1-.6l-2-1.6zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>
          去填写数据源
        </button>
        <button class="btn-ghost" id="btnGuidesHelp">没有余票时怎么买</button>
      </div>
    </div>`;
  }

  // 有数据源但这次采集失败
  if (diag.lastError) {
    const hint = diag.blocked
      ? '直连 12306 被拦，可在设置里改用第三方数据源。'
      : '可能是网络波动或额度用尽，稍后会自动重试。';
    return `<div class="notice warn">
      <svg viewBox="0 0 24 24"><path d="M12 2 1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V9h2v4z"/></svg>
      <div>
        <b>上次采集没成功。</b> ${esc(hint)}
        <div style="margin-top:4px">
          <details style="font-size:12px"><summary style="cursor:pointer">错误详情</summary>
            <p><code>${esc(String(diag.lastError).slice(0, 240))}</code></p>
          </details>
        </div>
      </div>
    </div>`;
  }

  // 数据源正常但微信没配 —— 顺手提一句
  if (!wx.enabled) {
    return `<div class="notice info">
      <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
      <div>
        已接入数据源（${esc(sourceLabel(ds.active))}）。想在有票时收到微信提醒，
        去 <a href="#" id="btnGoWx">设置</a> 里配置推送 —— 这样就不用一直盯着这个页面。
      </div>
    </div>`;
  }

  return '';
}

/** 数据源显示名。 */
function sourceLabel(name) {
  return { apihz: '第三方数据源', direct: '直连 12306' }[name] || (name ? String(name) : '未接入');
}

/** 购票操作步骤（复用于提示卡与"怎么抢到票"页）。 */
function helpSteps() {
  return `<div class="steps">
    <div class="step">
      <div class="step-n">1</div>
      <div class="step-b">
        <b>优先提交候补订单 —— 这是最有效的一步</b>
        <p>
          在 12306 官方 App 里点「候补购票」，把能接受的
          <span class="hl">车次、席别、日期都选上</span>（可以多选）。
          候补是官方排队机制，<b>优先级高于任何手动抢票</b>，有人退票就按排队顺序自动补给你。
        </p>
      </div>
    </div>
    <div class="step">
      <div class="step-n">2</div>
      <div class="step-b">
        <b>盯住两个放票时间点</b>
        <p>
          每天 <span class="hl">8:00–18:00 的整点</span>分批放票；
          开车前 <span class="hl">15 天、48 小时、24 小时</span>是退票回流高峰。
          这两个时段手动去官方查，命中率最高。
        </p>
      </div>
    </div>
    <div class="step">
      <div class="step-n">3</div>
      <div class="step-b">
        <b>直达没票时换思路</b>
        <p>
          依次试：<b>多买一站</b>（买到更远的站，提前下车）、
          <b>少买一站</b>（买到中途站，上车补票）、
          <b>分段接驳</b>（拆成 A→B、B→C 两段各买）、
          <b>换站出发</b>（同城其它车站）。
        </p>
      </div>
    </div>
    <div class="step">
      <div class="step-n">4</div>
      <div class="step-b">
        <b>让本工具替你盯着</b>
        <p>
          配置微信提醒后（「设置」页），余票出现变化会推到你手机，
          你<b>不必一直刷新页面</b>，收到提醒再动手。日常让它后台跑着就行。
        </p>
      </div>
    </div>
  </div>`;
}

/* ---------- 怎么抢到票 ---------- */

function viewHelp(d) {
  $('mainTitle').textContent = '怎么抢到票';
  $('mainSub').textContent = '按效果排序，先做第 1 步';
  setActions(`<button class="btn-mini" id="btnBackRadar">返回余票雷达</button>
              <button class="btn-mini danger" id="btnStopHelp">停止程序</button>`);

  setMainHtml(`
    <div class="action-card">
      <div class="action-head">
        <h3>
          <svg viewBox="0 0 24 24" style="fill:var(--green)"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 15-5-5 1.4-1.4L11 14.2l6.6-6.6L19 9l-8 8z"/></svg>
          先说一句实话
        </h3>
        <p>
          第三方软件在 12306 的放票队列里<b>没有任何优先级</b>。
          12306 是服务端排队放票，谁先到服务器谁先得 —— 所谓"加速包"在技术上不成立。
          真正管用的是下面的官方能力。
        </p>
      </div>
      ${helpSteps()}
      <div class="action-foot">
        <a class="btn-primary" href="https://kyfw.12306.cn/otn/leftTicket/init" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24"><path d="M14 3v2h3.6l-9.3 9.3 1.4 1.4L19 6.4V10h2V3h-7zM5 5h5V3H3v18h18v-7h-2v5H5V5z"/></svg>
          打开 12306 官方
        </a>
        <button class="btn-ghost" id="btnGoSettings">去配置微信提醒</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>这个工具做什么、不做什么</h3></div>
      <div class="card-body" style="font-size:13px;line-height:1.9;color:var(--text-2)">
        <p style="margin:0 0 10px"><b style="color:var(--text)">会做</b>：只读查询余票 · 监测余票变化 · 微信提醒 · 采集 12306 网络时延 · 本地站点库（${d.stationCount} 站）</p>
        <p style="margin:0 0 10px"><b style="color:var(--text)">不会做</b>：不登录你的账号 · 不识别或绕过验证码 · 不自动下单 · 不自动支付 · 不做多账号 · 不做代理 IP 池</p>
        <p style="margin:0"><b style="color:var(--text)">原因</b>：前一组是信息聚合；后一组违反 12306 用户协议，
        而且真做了也不会更快 —— 队列优先级不由客户端决定。</p>
      </div>
    </div>

    <div class="notice warn">
      <svg viewBox="0 0 24 24"><path d="M12 2 1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V9h2v4z"/></svg>
      <div>
        官方渠道只有两个：<b>12306 官方 App</b> 和 <b>12306 官网</b>。
        任何要求你提供账号密码或验证码的第三方工具都不要用。
      </div>
    </div>`);

  $('btnGoSettings').onclick = async () => {
    S.view = 'settings';
    await refresh();
  };
}

/* ---------- 网络延迟 ---------- */

function viewLatency(d) {
  $('mainTitle').textContent = '网络延迟';
  $('mainSub').textContent = `最近采集 ${ago(d.diagnostics && d.diagnostics.lastRunAt)}`;

  setActions(`<button class="btn-mini" id="btnProbe">立即探测</button>
              <button class="btn-mini danger" id="btnStop">停止程序</button>`);
  $('btnProbe').onclick = () => poll();

  const lat = d.latency || [];
  const st = lat.filter((x) => x.kind === 'static');
  const qu = lat.filter((x) => x.kind === 'query');
  const last = (arr) => (arr.length ? arr[arr.length - 1] : null);
  const avg = (arr, k) => {
    const v = arr.map((x) => x[k]).filter((n) => typeof n === 'number');
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const cls = (v, good, mid) => (v == null ? '' : v <= good ? 'good' : v <= mid ? 'mid' : 'bad');

  const ls = last(st);
  const lq = last(qu);

  const body = $('mainBody');
  body.innerHTML = `
  <div class="stat-grid">
    <div class="stat ${cls(ls && ls.ttfb, 150, 400)}">
      <div class="k">静态资源 TTFB</div>
      <div class="v">${ls && ls.ttfb != null ? ls.ttfb : '—'}<small>ms</small></div>
      <div class="f">均值 ${avg(st.slice(-30), 'ttfb') ?? '—'} ms · ${st.length} 采样</div>
    </div>
    <div class="stat ${cls(ls && ls.tls, 200, 500)}">
      <div class="k">TLS 握手</div>
      <div class="v">${ls && ls.tls != null ? ls.tls : '—'}<small>ms</small></div>
      <div class="f">均值 ${avg(st.slice(-30), 'tls') ?? '—'} ms</div>
    </div>
    <div class="stat ${cls(lq && lq.ttfb, 300, 700)}">
      <div class="k">查询端点 TTFB</div>
      <div class="v">${lq && lq.ttfb != null ? lq.ttfb : '—'}<small>ms</small></div>
      <div class="f">均值 ${avg(qu.slice(-30), 'ttfb') ?? '—'} ms · ${qu.length} 采样</div>
    </div>
    <div class="stat">
      <div class="k">采样总数</div>
      <div class="v">${lat.length}<small>次</small></div>
      <div class="f">静态 ${st.length} / 查询 ${qu.length}</div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3>时延趋势</h3><span class="sub">最近 ${Math.min(lat.length, 120)} 次采样</span></div>
    <div class="card-body">
      <div class="chart-wrap"><canvas class="chart" id="chart"></canvas></div>
      <div class="chart-legend">
        <span><i style="background:var(--green)"></i>静态资源 TTFB</span>
        <span><i style="background:var(--warn)"></i>查询端点 TTFB</span>
        ${lat.some((x) => !x.ok) ? `<span><i style="background:var(--danger)"></i>失败（贴底显示）</span>` : ''}
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3>单次请求分解</h3><span class="sub">最近一次静态探测</span></div>
    <div class="card-body">
      <div class="phase-list">
        ${phaseRow('DNS 解析', ls && ls.dns, ls && ls.total, 'var(--info)')}
        ${phaseRow('TCP 建连', ls && ls.tcp, ls && ls.total, 'var(--info)')}
        ${phaseRow('TLS 握手', ls && ls.tls, ls && ls.total, 'var(--warn)')}
        ${phaseRow('首字节 TTFB', ls && ls.ttfb, ls && ls.total, 'var(--green)')}
        ${phaseRow('完整响应', ls && ls.total, ls && ls.total, 'var(--text-3)')}
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3>这些数字说明什么</h3></div>
    <div class="card-body" style="color:var(--text-2);font-size:13px;line-height:1.85">
      <p style="margin:0 0 8px"><b>TTFB</b>（首字节时间）＝ 你点查询到 12306 开始返回数据的时间，决定"结果多久出现"。</p>
      <p style="margin:0 0 8px"><b>TLS 握手</b>是建连开销；连接复用后这块成本会消失，所以它高不代表查询慢。</p>
      <p style="margin:0"><b>关键</b>：这些数字只影响你<b>看到</b>余票的快慢，<b>不影响你能否抢到票</b> ——
      12306 是服务端排队放票，第三方软件在队列里没有任何优先级。</p>
    </div>
  </div>`;

  requestAnimationFrame(() => drawChart($('chart'), lat.slice(-120)));
}

function phaseRow(name, v, total, color) {
  const pct = v != null && total ? Math.max(2, Math.round((v / total) * 100)) : 0;
  return `<div class="phase">
    <div class="name">${esc(name)}</div>
    <div class="bar"><i style="width:${pct}%;background:${color}"></i></div>
    <div class="val">${v != null ? v + ' ms' : '—'}</div>
  </div>`;
}

function drawChart(canvas, lat) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = 168;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const css = getComputedStyle(document.documentElement);
  const cGreen = css.getPropertyValue('--green').trim() || '#07c160';
  const cWarn = css.getPropertyValue('--warn').trim() || '#f59f00';
  const cDanger = css.getPropertyValue('--danger').trim() || '#e5484d';
  const cLine = css.getPropertyValue('--line').trim() || '#e6e8eb';
  const cText3 = css.getPropertyValue('--text-3').trim() || '#9aa0ad';

  const pad = { l: 42, r: 12, t: 12, b: 22 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;

  const vals = lat.map((x) => x.ttfb).filter((v) => typeof v === 'number');
  if (!vals.length) {
    ctx.fillStyle = cText3;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('暂无采样数据', pad.l, h / 2);
    return;
  }
  const rawMax = Math.max(...vals);
  const max = Math.max(50, Math.ceil(rawMax / 50) * 50);

  // 网格与 Y 轴
  ctx.strokeStyle = cLine;
  ctx.fillStyle = cText3;
  ctx.font = '10px system-ui, sans-serif';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ih * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y + 0.5);
    ctx.lineTo(w - pad.r, y + 0.5);
    ctx.stroke();
    const v = Math.round(max - (max * i) / 4);
    ctx.textAlign = 'right';
    ctx.fillText(`${v}`, pad.l - 7, y + 3);
  }
  ctx.textAlign = 'left';

  // X 轴时间标签
  if (lat.length > 1) {
    ctx.fillStyle = cText3;
    for (const frac of [0, 0.5, 1]) {
      const i = Math.round((lat.length - 1) * frac);
      const x = pad.l + iw * frac;
      ctx.textAlign = frac === 0 ? 'left' : frac === 1 ? 'right' : 'center';
      ctx.fillText(hhmm(lat[i].ts), x, h - 6);
    }
    ctx.textAlign = 'left';
  }

  // 折线
  const lines = [
    { color: cGreen, pick: (x) => (x.kind === 'static' ? x.ttfb : null) },
    { color: cWarn, pick: (x) => (x.kind === 'query' ? x.ttfb : null) },
  ];
  const n = lat.length;
  for (const ln of lines) {
    ctx.strokeStyle = ln.color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    lat.forEach((x, i) => {
      const v = ln.pick(x);
      if (typeof v !== 'number') { started = false; return; }
      const px = pad.l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
      const py = pad.t + ih - (Math.min(v, max) / max) * ih;
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  // 失败点贴底
  ctx.fillStyle = cDanger;
  lat.forEach((x, i) => {
    if (x.ok) return;
    const px = pad.l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
    ctx.beginPath();
    ctx.arc(px, pad.t + ih, 2.4, 0, Math.PI * 2);
    ctx.fill();
  });
}

/* ---------- 提醒记录 ---------- */

function viewEvents(d) {
  $('mainTitle').textContent = '提醒记录';
  const evs = (d.events || []).slice();
  $('mainSub').textContent = `${evs.length} 条 · 按时间倒序`;

  setActions(`<button class="btn-mini danger" id="btnClearEv">清空记录</button>
              <button class="btn-mini danger" id="btnStop">停止程序</button>`);
  $('btnClearEv').onclick = async () => {
    if (!evs.length) return toast('没有可清空的记录');
    if (!confirm('清空全部提醒记录？')) return;
    await api('/api/events/clear', {});
    await refresh();
    toast('已清空提醒记录');
  };

  const body = $('mainBody');
  if (!evs.length) {
    body.innerHTML = emptyState(
      '还没有提醒',
      '当某趟车从无票变为有票、或余票数量增加时，这里会出现一条记录'
    );
    return;
  }

  let html = '<div class="stream">';
  let lastDay = null;
  for (const e of evs) {
    const day = dayLabel(e.ts);
    if (day !== lastDay) {
      html += `<div class="day-sep">${esc(day)}</div>`;
      lastDay = day;
    }
    const kind = e.kind === 'becameAvailable' ? '' : e.kind === 'newTrain' ? 'info' : 'warn';
    const icon = e.kind === 'becameAvailable' ? '有票' : e.kind === 'newTrain' ? '新增' : '变化';
    html += `<div class="msg">
      <div class="msg-ico ${kind}">${esc(icon)}</div>
      <div class="msg-bubble">
        <div class="msg-title">${esc(e.route || '')} · <span class="hl">${esc(e.trainCode)}</span> ${esc(e.seatName || '')}</div>
        <div class="msg-body">${esc(e.text)}</div>
        <div class="msg-meta">${hhmmss(e.ts)} · ${esc(e.date ? fmtDate(e.date, { short: true }) : '')}</div>
      </div>
    </div>`;
  }
  html += '</div>';

  html += `<div class="banner info" style="margin-top:16px">
    <h4>收到提醒后怎么做</h4>
    <ul>
      <li>立刻打开 12306 官方 App 或网站，找到对应车次下单。</li>
      <li>如果又没了，说明被别人抢先 —— 继续等下一次回流，或补一个候补订单。</li>
    </ul>
  </div>`;

  body.innerHTML = html;
}

/* ---------- 设置 ---------- */

function viewSettings(d) {
  const c = d.config;
  const wx = c.wechat || {};
  $('mainTitle').textContent = '设置';
  $('mainSub').textContent = '配置保存在本地 data/config.json';

  setActions(`<button class="btn-primary" id="btnSaveCfg">保存设置</button>
              <button class="btn-mini danger" id="btnStop">停止程序</button>`);

  const body = $('mainBody');
  const ds = d.dataSource || {};
  const dsCfg = c.dataSource || { apihz: {} };

  body.innerHTML = `
  <div class="card">
    <div class="card-head">
      <h3>数据源（决定能不能看到余票）</h3>
      <span class="sub">${ds.anyReady ? '已接入：' + esc(sourceLabel(ds.active)) : '未接入'}</span>
    </div>
    <div class="card-body">
      <div class="notice ${ds.anyReady ? 'info' : 'warn'}" style="margin-bottom:14px">
        <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
        <div>
          12306 给查询接口加了客户端校验，<b>直连拿不到余票</b>。
          接第三方合规数据源即可正常查票 ——
          <a href="https://www.apihz.cn/user/" target="_blank" rel="noopener">注册免费账号</a>，
          然后把「个人资料」里的开发者ID与KEY填到下面。
        </div>
      </div>

      <div class="set-row">
        <div class="label">数据源模式</div>
        <div class="control">
          <select id="dsProvider">
            <option value="auto" ${dsCfg.provider === 'auto' ? 'selected' : ''}>自动（推荐：能用哪个用哪个）</option>
            <option value="apihz" ${dsCfg.provider === 'apihz' ? 'selected' : ''}>只用第三方数据源</option>
            <option value="direct" ${dsCfg.provider === 'direct' ? 'selected' : ''}>只用直连 12306</option>
          </select>
          <div class="tip">当前判定：${esc(ds.reason || '—')}</div>
        </div>
      </div>

      <div class="set-row">
        <div class="label">开发者 ID</div>
        <div class="control">
          <div class="set-inline">
            <input type="text" id="dsId" placeholder="接口盒子用户中心的数字ID" value="${esc((dsCfg.apihz && dsCfg.apihz.id) || '')}">
          </div>
        </div>
      </div>

      <div class="set-row">
        <div class="label">开发者 KEY</div>
        <div class="control">
          <div class="set-inline">
            <input type="text" id="dsKey" placeholder="接口盒子用户中心的通讯秘钥" value="${esc((dsCfg.apihz && dsCfg.apihz.key) || '')}">
            <button class="btn-mini" id="btnDsTest">测试连接</button>
          </div>
          <div class="tip">只保存在本机 data/config.json，不会上传。</div>
          <div class="tip" id="dsResult"></div>
        </div>
      </div>

      <div class="set-row">
        <div class="label">仍然尝试直连</div>
        <div class="control">
          <label class="switch">
            <input type="checkbox" id="dsTryDirect" ${dsCfg.tryDirect ? 'checked' : ''}>
            <span class="track"></span><span>即使大概率被拦也试一试</span>
          </label>
          <div class="tip">默认关闭。直连成功的话数据最一手；但 12306 目前会拒绝，每次都会白打一个请求。</div>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3>微信推送</h3><span class="sub">${wx.enabled ? '已启用' : '未启用'}</span></div>
    <div class="card-body">
      <div class="set-row">
        <div class="label">启用推送</div>
        <div class="control">
          <label class="switch">
            <input type="checkbox" id="wxEnabled" ${wx.enabled ? 'checked' : ''}>
            <span class="track"></span><span>有票变化时推送到微信</span>
          </label>
        </div>
      </div>

      <div class="set-row">
        <div class="label">推送通道</div>
        <div class="control">
          <select id="wxChannel">
            <option value="pushplus" ${wx.channel === 'pushplus' ? 'selected' : ''}>PushPlus（微信服务号）</option>
            <option value="serverchan" ${wx.channel === 'serverchan' ? 'selected' : ''}>Server酱³</option>
          </select>
          <div class="tip" id="wxHelp"></div>
        </div>
      </div>

      <div class="set-row">
        <div class="label">推送 token</div>
        <div class="control">
          <div class="set-inline">
            <input type="text" id="wxToken" placeholder="粘贴 token / SendKey" value="${esc(wx.token || '')}">
            <button class="btn-mini" id="btnWxTest">发送测试</button>
          </div>
          <div class="tip">token 只保存在本机 <code>data/config.json</code>，不会随代码分发、不会上传。</div>
          <div class="tip" id="wxResult"></div>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3>采集频率</h3><span class="sub">当前 ${d.intervalSec}s${d.rushNow ? '（放票窗口提速中）' : ''}</span></div>
    <div class="card-body">
      <div class="set-row">
        <div class="label">常态间隔</div>
        <div class="control">
          <div class="set-inline"><input type="number" id="cfgInterval" min="20" max="3600" value="${c.intervalSec}"><span class="sep">秒</span></div>
          <div class="tip">建议 ≥60 秒。余票库不是实时推送的，秒级轮询不提升中票率，只提高被风控的概率。</div>
        </div>
      </div>
      <div class="set-row">
        <div class="label">放票窗口间隔</div>
        <div class="control">
          <div class="set-inline"><input type="number" id="cfgRush" min="10" max="600" value="${c.rushIntervalSec}"><span class="sep">秒</span></div>
          <div class="tip">8:00–18:00 每个整点的前 3 分钟自动提速。</div>
        </div>
      </div>
      <div class="set-row">
        <div class="label">提醒去重窗口</div>
        <div class="control">
          <div class="set-inline"><input type="number" id="cfgDedupe" min="1" max="720" value="${c.dedupeWindowMin}"><span class="sep">分钟</span></div>
          <div class="tip">同一车次、同一席别的同类变化，在该窗口内只提醒一次，避免放票瞬间刷屏。</div>
        </div>
      </div>
      <div class="set-row">
        <div class="label">静默时段</div>
        <div class="control">
          <div class="set-inline">
            <input type="number" id="cfgQuietS" min="0" max="23" value="${c.quietHours.start}"><span class="sep">时至</span>
            <input type="number" id="cfgQuietE" min="0" max="23" value="${c.quietHours.end}"><span class="sep">时</span>
          </div>
          <div class="tip">${d.quietNow ? '<b style="color:var(--warn)">当前处于静默时段，只记录不推送</b>' : '当前不在静默时段，会正常推送'}。静默期间仍会照常采集。</div>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3>这个工具做什么、不做什么</h3></div>
    <div class="card-body" style="font-size:13px;line-height:1.9;color:var(--text-2)">
      <p style="margin:0 0 10px"><b style="color:var(--text)">会做</b>：只读查询余票 · 监测余票变化 · 微信提醒 · 采集 12306 网络时延 · 本地站点库（${d.stationCount} 站）</p>
      <p style="margin:0 0 10px"><b style="color:var(--text)">不会做</b>：不登录你的账号 · 不识别或绕过验证码 · 不自动下单 · 不自动支付 · 不做多账号 · 不做代理 IP 池</p>
      <p style="margin:0"><b style="color:var(--text)">原因</b>：前一组是信息聚合；后一组违反 12306 用户协议，且第三方在 12306 的放票队列里<b>没有优先级</b> —— 所谓"加速"在技术上不成立。</p>
    </div>
  </div>`;

  const help = () => {
    $('wxHelp').innerHTML =
      $('wxChannel').value === 'serverchan'
        ? '<a href="https://sct.ftqq.com" target="_blank" rel="noopener">sct.ftqq.com</a> 微信扫码登录后复制 SendKey'
        : '<a href="https://www.pushplus.plus" target="_blank" rel="noopener">pushplus.plus</a> 微信扫码登录后，在「一对一推送」复制 token';
  };
  help();
  $('wxChannel').onchange = help;

  $('btnWxTest').onclick = async () => {
    const btn = $('btnWxTest');
    btn.disabled = true;
    btn.textContent = '发送中…';
    $('wxResult').textContent = '';
    await api('/api/config', {
      wechat: {
        enabled: true,
        channel: $('wxChannel').value,
        token: $('wxToken').value.trim(),
      },
    });
    const r = await api('/api/notify/test', {});
    $('wxResult').innerHTML = r.ok
      ? `<b style="color:var(--green-600)">已提交到 ${esc(r.channel || '')}</b>，请查看微信`
      : `<b style="color:var(--danger)">失败</b>：${esc(r.error || '未知错误')}`;
    btn.disabled = false;
    btn.textContent = '发送测试';
    if (r.ok) toast('测试消息已提交', '请查看微信', '');
  };

  // 数据源自检：用一次真实查询验证 id/key
  const dsTest = $('btnDsTest');
  if (dsTest) {
    dsTest.onclick = async () => {
      const id = $('dsId').value.trim();
      const key = $('dsKey').value.trim();
      const out = $('dsResult');
      if (!id || !key) {
        out.innerHTML = '<b style="color:var(--danger)">请先填写 开发者ID 与 开发者KEY</b>';
        return;
      }
      dsTest.disabled = true;
      dsTest.textContent = '测试中…';
      out.textContent = '正在发起一次真实查询…';

      const r = await api('/api/datasource/test', { id, key });

      if (r.ok) {
        out.innerHTML =
          `<b style="color:var(--green-600)">连接成功</b> —— 取到 ${r.count} 趟车次` +
          `（${esc(r.sample ? r.sample.from + '→' + r.sample.to : '')}）`;
        // 测通了就直接保存，省一步
        await api('/api/config', {
          dataSource: { apihz: { id, key }, provider: $('dsProvider').value },
        });
        toast('数据源已保存', '现在可以查看余票了');
      } else {
        out.innerHTML = `<b style="color:var(--danger)">连接失败</b>：${esc(r.error || '未知错误')}`;
      }
      dsTest.disabled = false;
      dsTest.textContent = '测试连接';
    };
  }

  $('btnSaveCfg').onclick = async () => {
    const provider = $('dsProvider') ? $('dsProvider').value : undefined;
    const r = await api('/api/config', {
      intervalSec: Number($('cfgInterval').value),
      rushIntervalSec: Number($('cfgRush').value),
      dedupeWindowMin: Number($('cfgDedupe').value),
      quietHours: { start: Number($('cfgQuietS').value), end: Number($('cfgQuietE').value) },
      wechat: {
        enabled: $('wxEnabled').checked,
        channel: $('wxChannel').value,
        token: $('wxToken').value.trim(),
      },
      dataSource: {
        provider,
        tryDirect: $('dsTryDirect') ? $('dsTryDirect').checked : undefined,
        apihz: {
          id: $('dsId') ? $('dsId').value.trim() : undefined,
          key: $('dsKey') ? $('dsKey').value.trim() : undefined,
        },
      },
    });
    await refresh();
    toast(r.ok ? '设置已保存' : '保存失败', r.ok ? '采集间隔已按新值生效' : r.error, r.ok ? '' : 'err');
  };
}

/* ══════════════ 添加区间弹层 ══════════════ */

let modalCtx = { offset: 7, seats: ['second', 'first'] };

function openModal() {
  $('modalMask').hidden = false;
  $('modalError').hidden = true;
  $('inFrom').value = '';
  $('inTo').value = '';
  modalCtx = { offset: 7, seats: ['second', 'first'] };
  renderChips();
  loadStations();
  setTimeout(() => $('inFrom').focus(), 60);
}

function closeModal() {
  $('modalMask').hidden = true;
  hideAc();
}

function renderChips() {
  // 日期 chip 直接显示真实日期与星期，省得用户心算"7 天后是几号"
  $('dateChips').innerHTML = DATE_PRESETS.map((p) => {
    const d = new Date();
    d.setDate(d.getDate() + p.v);
    const ds = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const wd = WEEKDAYS[d.getDay()];
    // 明天/后天 fmtDate 已会输出"明天 周六"，此处只补日期避免重复
    const label = p.v <= 2 ? `${fmtDate(ds)} ${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : fmtDate(ds, { short: true });
    return `<button class="chip ${modalCtx.offset === p.v ? 'on' : ''}" data-off="${p.v}">${esc(label)}</button>`;
  }).join('');
  $('seatChips').innerHTML = SEAT_FIELDS.map(
    (s) => `<button class="chip ${modalCtx.seats.includes(s.key) ? 'on' : ''}" data-seat="${s.key}">${esc(s.name)}</button>`
  ).join('');

  $('dateChips').querySelectorAll('[data-off]').forEach((b) => {
    b.onclick = () => { modalCtx.offset = Number(b.dataset.off); renderChips(); };
  });
  $('seatChips').querySelectorAll('[data-seat]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.seat;
      const i = modalCtx.seats.indexOf(k);
      if (i >= 0) modalCtx.seats.splice(i, 1);
      else modalCtx.seats.push(k);
      renderChips();
    };
  });
}

async function loadStations() {
  if (S.stations) return S.stations;
  const r = await api('/api/stations');
  if (r && r.ok) S.stations = r.stations;
  return S.stations;
}

function showAc(target) {
  const list = S.acList;
  const el = target === 'from' ? $('acFrom') : $('acTo');
  if (!list.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = list
    .map(
      (s, i) =>
        `<div class="ac-item ${i === S.acIdx ? 'sel' : ''}" data-i="${i}"><b>${esc(s.n)}</b><small>${esc(s.c)} · ${esc(s.p)}</small></div>`
    )
    .join('');
  el.querySelectorAll('.ac-item').forEach((it) => {
    it.onmousedown = (ev) => {
      ev.preventDefault();
      pickAc(Number(it.dataset.i));
    };
  });
}

function hideAc() {
  $('acFrom').hidden = true;
  $('acTo').hidden = true;
  S.acIdx = -1;
  S.acTarget = null;
}

function pickAc(i) {
  const s = S.acList[i];
  if (!s || !S.acTarget) return;
  $(S.acTarget === 'from' ? 'inFrom' : 'inTo').value = s.n;
  hideAc();
}

async function onAcInput(target) {
  const input = $(target === 'from' ? 'inFrom' : 'inTo');
  const q = input.value.trim();
  if (!q) { hideAc(); return; }

  const list = await loadStations();
  if (!list) return;

  const upper = q.toUpperCase();
  const lower = q.toLowerCase();
  const starts = [];
  const contains = [];
  for (const s of list) {
    if (s.n.startsWith(q)) starts.push(s);
    else if (s.n.includes(q)) contains.push(s);
    else if (s.c === upper || s.p === lower || s.p.startsWith(lower)) starts.push(s);
    if (starts.length + contains.length > 40) break;
  }
  S.acList = starts.concat(contains).slice(0, 12);
  S.acIdx = -1;
  S.acTarget = target;
  showAc(target);
}

function acKey(ev, target) {
  const el = target === 'from' ? $('acFrom') : $('acTo');
  if (el.hidden || !S.acList.length) return false;
  if (ev.key === 'ArrowDown') { S.acIdx = Math.min(S.acIdx + 1, S.acList.length - 1); showAc(target); return true; }
  if (ev.key === 'ArrowUp') { S.acIdx = Math.max(S.acIdx - 1, 0); showAc(target); return true; }
  if (ev.key === 'Enter' && S.acIdx >= 0) { pickAc(S.acIdx); ev.preventDefault(); return true; }
  if (ev.key === 'Escape') { hideAc(); return true; }
  return false;
}

/* ══════════════ 交互绑定 ══════════════ */

async function poll() {
  if (S.busy) return;
  S.busy = true;
  const btn = $('btnPoll');
  btn.disabled = true;
  btn.classList.add('busy');
  btn.querySelector('span').textContent = '采集中…';
  try {
    const r = await api('/api/poll', {});
    const d = (r && r.diagnostics) || {};
    if (d.blocked) toast('采集完成，但取数被拦截', '详情见主区提示', 'warn');
    else if (d.lastError) toast('采集未成功', String(d.lastError).slice(0, 80), 'err');
    else toast('采集完成');
  } catch (e) {
    toast('采集失败', e.message, 'err');
  } finally {
    S.busy = false;
    btn.disabled = false;
    btn.classList.remove('busy');
    btn.querySelector('span').textContent = '立即刷新';
    await refresh();
  }
}

/**
 * 安全绑定：元素缺失或赋值抛错都不能影响后面的绑定。
 *
 * 这一点很关键 —— 之前一旦某个元素不存在，整个 bind() 就中断了，
 * 后面的按钮全部失去响应，表现就是"按钮点了没反应"却看不到任何报错。
 */
function safeBind(label, fn) {
  try {
    fn();
  } catch (e) {
    console.error('[bind] ' + label + ' 失败:', e);
    try {
      toast('界面初始化异常', label + '：' + e.message, 'err');
    } catch {
      /* toast 自己都挂了就别再折腾 */
    }
  }
}

function bind() {
  safeBind('导航', () => {
    $$('.nav-item').forEach((b) => {
      b.onclick = async () => {
        S.view = b.dataset.view;
        if (S.view === 'events') await api('/api/events/read', {});
        await refresh();
      };
    });
  });

  safeBind('添加区间按钮', () => {
    $('btnAdd').onclick = openModal;
  });

  safeBind('弹层关闭按钮', () => {
    $('btnCancel').onclick = closeModal;
    $('btnCloseModal').onclick = closeModal;
    $('modalMask').onclick = (e) => {
      if (e.target === $('modalMask')) closeModal();
    };
  });

  safeBind('刷新按钮', () => {
    $('btnPoll').onclick = poll;
  });

  safeBind('列表筛选', () => {
    $('listSearch').oninput = () => renderList(S.data);
  });

  safeBind('站点互换', () => {
    $('btnSwap').onclick = () => {
      const a = $('inFrom').value;
      $('inFrom').value = $('inTo').value;
      $('inTo').value = a;
    };
  });

  safeBind('站点自动补全', () => {
    $('inFrom').oninput = () => onAcInput('from');
    $('inTo').oninput = () => onAcInput('to');
    $('inFrom').onkeydown = (e) => acKey(e, 'from');
    $('inTo').onkeydown = (e) => acKey(e, 'to');
    $('inFrom').onblur = () => setTimeout(hideAc, 150);
    $('inTo').onblur = () => setTimeout(hideAc, 150);
  });

  safeBind('保存区间', () => {
    $('btnSave').onclick = async () => {
      const from = $('inFrom').value.trim();
      const to = $('inTo').value.trim();
      const err = $('modalError');
      if (!from || !to) {
        err.hidden = false;
        err.textContent = '请填写出发站和到达站';
        return;
      }
      const r = await api('/api/routes', {
        from, to, dateOffset: modalCtx.offset, seats: modalCtx.seats,
      });
      if (!r.ok) {
        err.hidden = false;
        err.textContent = r.error || '添加失败';
        return;
      }
      closeModal();
      S.filters = { q: '', onlyAvail: false, sort: 'depart', type: 'all' };
      await refresh();
      toast('已添加监控区间', `${r.route.from} → ${r.route.to}`);
      poll();
    };
  });

  safeBind('主区操作按钮', () => {
    // 每帧重建，用事件委托
    $('mainActions').onclick = async (e) => {
      const t = e.target.closest('button, a');
      if (!t) return;
      if (t.id === 'btnStop' || t.id === 'btnStopHelp' || t.id === 'btnStopSettings') return shutdownApp();
      if (t.id === 'btnHelp') {
        S.view = 'help';
        return refresh();
      }
      if (t.id === 'btnBackRadar') {
        S.view = 'radar';
        return refresh();
      }
    };
  });

  safeBind('确认弹层', () => {
    $('confirmYes').onclick = () => closeConfirm(true);
    $('confirmNo').onclick = () => closeConfirm(false);
    $('confirmMask').onclick = (e) => {
      if (e.target === $('confirmMask')) closeConfirm(false);
    };
  });

  safeBind('键盘快捷键', () => {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // 无论弹层状态如何，Esc 都必须能收掉它
        if (!$('confirmMask').hidden) return closeConfirm(false);
        if (!$('modalMask').hidden) return closeModal();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        poll();
      }
    });
  });

  safeBind('全局错误提示', () => {
    window.addEventListener('error', (ev) => {
      console.error('[window] 未捕获错误:', ev.message);
    });
    window.addEventListener('unhandledrejection', (ev) => {
      console.error('[window] 未处理的 Promise 拒绝:', ev.reason);
    });
  });
}

/* ══════════════ 从网页停止程序 ══════════════ */

async function shutdownApp() {
  const ok = await askConfirm({
    title: '停止 12306 余票雷达？',
    html: `
      停止后：<br>
      · 不再自动查询余票，也不会再发微信提醒<br>
      · 本页会失效，需要重新双击 <b>余票雷达.exe</b> 才能再用<br>
      <br>
      想让它一直盯着票，就别停 —— 可以把这个页面关掉，程序仍在后台运行。`,
    yes: '停止程序',
    no: '继续运行',
  });
  if (!ok) return;

  toast('正在退出…', '本页稍后会失效');
  let stopped = false;
  try {
    const r = await api('/api/shutdown', {});
    stopped = !!(r && r.ok);
  } catch {
    /* 服务退出时连接会断，属正常，下面用轮询确认 */
  }

  // 等端口真的不再响应，避免"以为停了其实没停"
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const probe = await fetch('/api/state', { cache: 'no-store' });
      if (!probe.ok) {
        stopped = true;
        break;
      }
    } catch {
      stopped = true; // 连不上就是已经停了
      break;
    }
  }

  if (stopped) {
    setMainHtml(`<div class="empty">
      <svg viewBox="0 0 24 24" style="fill:var(--line)"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 15-5-5 1.4-1.4L11 14.2l6.6-6.6L19 9l-8 8z"/></svg>
      <b>程序已停止</b>
      <p>要再次使用，请双击桌面上的 <b>余票雷达.exe</b>。</p>
    </div>`);
    setActions('');
    $('statusCard').className = 'status-card off';
    $('statusText').textContent = '已停止';
    $('statusSub').textContent = '窗口可关闭';
    return;
  }

  // 没停成：多半是服务端还是旧版本，没有这个接口
  toast('没能停止程序', '服务端是旧版本，请关掉程序窗口后重新启动', 'err');
  setMainHtml(`<div class="notice warn">
    <svg viewBox="0 0 24 24"><path d="M12 2 1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V9h2v4z"/></svg>
    <div>
      <b>网页端停止不可用。</b>
      正在运行的服务端是旧版本，还没有这个接口。<br>
      请<b>关掉程序窗口（那个控制台窗口）</b>，然后重新双击 <b>余票雷达.exe</b>；之后就能从这里停止了。
    </div>
  </div>`);
  setActions(radarActions());
}

/* ══════════════ SSE ══════════════ */

function connect() {
  const es = new EventSource('/api/events');
  let pending = null;
  const schedule = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; refresh(); }, 350);
  };
  for (const ev of ['latency', 'route', 'cycle', 'notify']) es.addEventListener(ev, schedule);
  es.addEventListener('notify', (e) => {
    try {
      const n = JSON.parse(e.data);
      if (n.reason) toast('静默时段，未推送', n.reason, 'warn');
      else if (n.ok) toast('微信提醒已推送', n.channel || '', '');
      else if (n.error) toast('微信推送失败', n.error, 'err');
    } catch { /* ignore */ }
  });
}

/* ══════════════ 启动 ══════════════ */

bind();
refresh().then(connect);

// 相对时间定期刷新（只重绘侧栏与副标题，不打断输入）
S.liveTimer = setInterval(() => {
  if (!S.data) return;
  if (S.view === 'radar') {
    const r = curRoute();
    if (r) updateRadarSub(r);
    renderList(S.data);
    const card = $('statusCard');
    if (card && card.classList.contains('on')) {
      $('statusSub').textContent = `${S.data.intervalSec}s 间隔 · ${hhmmss(S.data.diagnostics.lastRunAt)}`;
    }
  }
}, 5000);

setInterval(refresh, 15000);
