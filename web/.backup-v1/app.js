'use strict';

/**
 * 前端逻辑：状态拉取 + SSE 实时更新 + 三个视图渲染。
 * 无框架、无构建步骤，直接由本地服务托管。
 */

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
const SEAT_NAME = Object.fromEntries(SEAT_FIELDS.map((s) => [s.key, s.name]));

const STATE = {
  view: 'radar',
  data: null,
  selectedRoute: 0,
  busy: false,
};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtAgo(ts) {
  if (!ts) return '未更新';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  return `${Math.round(s / 3600)} 小时前`;
}

/* ==================== 数据 ==================== */

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  return res.json();
}

async function refresh() {
  try {
    STATE.data = await api('/api/state');
    render();
  } catch (e) {
    console.error('拉取状态失败', e);
  }
}

/* ==================== 渲染 ==================== */

function render() {
  const d = STATE.data;
  if (!d) return;
  renderRail(d);
  renderList(d);
  renderMain(d);
  renderBadge(d);
}

function renderRail(d) {
  document.querySelectorAll('.rail-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === STATE.view);
  });
  const st = $('railStatus');
  const diag = d.diagnostics || {};
  st.className = 'rail-status';
  if (diag.blocked) st.classList.add('warn');
  else if (diag.consecutiveFailures > 0) st.classList.add('warn');
  else if (diag.lastOkAt) st.classList.add('on');
  else st.classList.add('off');
}

function renderBadge(d) {
  const unread = (d.events || []).filter((e) => !e.read).length;
  const b = $('eventBadge');
  if (unread > 0) {
    b.hidden = false;
    b.textContent = String(unread);
  } else {
    b.hidden = true;
  }
}

function currentRoute() {
  const d = STATE.data;
  if (!d || !d.routes || !d.routes.length) return null;
  if (STATE.selectedRoute >= d.routes.length) STATE.selectedRoute = 0;
  return d.routes[STATE.selectedRoute];
}

function routeHitCount(r) {
  if (!r.rows) return null;
  let n = 0;
  for (const row of r.rows) {
    for (const k of Object.keys(row.seats || {})) {
      const s = row.seats[k];
      if (s && s.state === 'available') { n++; break; }
    }
  }
  return n;
}

function renderList(d) {
  $('listTitle').textContent = { radar: '余票雷达', latency: '网络延迟', events: '提醒记录', settings: '设置' }[STATE.view];
  const body = $('listBody');

  if (STATE.view === 'radar') {
    if (!d.routes.length) {
      body.innerHTML = '<div class="empty">还没有监控区间<small>点右上角 ＋ 添加</small></div>';
    } else {
      body.innerHTML = d.routes
        .map((r, i) => {
          const hits = routeHitCount(r);
          const preview =
            hits === null
              ? '<span style="color:#bbb">尚无数据</span>'
              : hits > 0
              ? `<span class="hot">${hits} 趟车次有票</span>`
              : '暂无可购席位';
          return `<div class="list-item ${i === STATE.selectedRoute ? 'active' : ''}" data-idx="${i}">
            <div class="list-ico ${hits > 0 ? '' : 'muted'}">${esc(r.from.slice(0, 2))}</div>
            <div class="list-main">
              <div class="list-row1">
                <div class="list-name">${esc(r.from)} → ${esc(r.to)}</div>
                <div class="list-time">${esc(String(r.date).slice(5))}</div>
              </div>
              <div class="list-preview">${preview}</div>
            </div>
          </div>`;
        })
        .join('');
      body.querySelectorAll('.list-item').forEach((el) => {
        el.onclick = () => { STATE.selectedRoute = Number(el.dataset.idx); render(); };
      });
    }
  } else if (STATE.view === 'events') {
    const evs = d.events || [];
    body.innerHTML = evs.length
      ? evs
          .map(
            (e) => `<div class="list-item">
        <div class="list-ico">${e.kind === 'becameAvailable' ? '有' : '变'}</div>
        <div class="list-main">
          <div class="list-row1">
            <div class="list-name">${esc(e.trainCode)} · ${esc(e.seatName || '')}</div>
            <div class="list-time">${fmtTime(e.ts).slice(0, 5)}</div>
          </div>
          <div class="list-preview">${esc(e.route || '')}</div>
        </div>
      </div>`
          )
          .join('')
      : '<div class="empty">还没有提醒<small>余票出现变化时会记录在这里</small></div>';
  } else if (STATE.view === 'latency') {
    const lat = d.latency || [];
    const last = lat[lat.length - 1];
    body.innerHTML = `<div style="padding:14px">
      <div class="card-sub">最近一次探测</div>
      <div class="lat-metric" style="margin-top:8px;box-shadow:none;padding:10px 0">
        <div class="k">首字节 (TTFB)</div>
        <div class="v">${last && last.ttfb != null ? last.ttfb : '—'}<small>ms</small></div>
      </div>
      <div class="kv" style="margin-top:6px">采样点 <b>${lat.length}</b></div>
    </div>`;
  } else {
    body.innerHTML = `<div style="padding:14px" class="kv">配置文件<br><code style="font-size:11px">data/config.json</code></div>`;
  }

  $('footNote').textContent = `${d.stationCount} 个车站 · 间隔 ${d.intervalSec}s${d.rushNow ? ' · 放票窗口' : ''}`;
}

/* ---------- sparkline ---------- */

function drawSpark(canvas, series, colors) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const all = series.flatMap((s) => s.data.filter((v) => v != null));
  if (!all.length) {
    ctx.fillStyle = '#bbb'; ctx.font = '12px sans-serif';
    ctx.fillText('暂无采样', 8, h / 2);
    return;
  }
  let max = Math.max(...all);
  let min = Math.min(...all);
  if (max === min) { max = min + 1; }
  const pad = { l: 34, r: 8, t: 8, b: 16 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;

  // 网格 + Y 轴
  ctx.strokeStyle = '#eee'; ctx.lineWidth = 1;
  ctx.fillStyle = '#aaa'; ctx.font = '10px sans-serif';
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + (ih * i) / 3;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    const v = Math.round(max - ((max - min) * i) / 3);
    ctx.fillText(String(v), 6, y + 3);
  }

  series.forEach((s, si) => {
    const n = s.data.length;
    if (!n) return;
    ctx.strokeStyle = colors[si % colors.length];
    ctx.lineWidth = 1.6; ctx.beginPath();
    let started = false;
    s.data.forEach((v, i) => {
      if (v == null) return;
      const x = pad.l + (n <= 1 ? 0 : (iw * i) / (n - 1));
      const y = pad.t + ih - ((v - min) / (max - min)) * ih;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
}

/* ---------- 主区 ---------- */

function renderMain(d) {
  const body = $('mainBody');
  const diag = d.diagnostics || {};

  if (STATE.view === 'radar') return renderRadar(d, body, diag);
  if (STATE.view === 'latency') return renderLatency(d, body);
  if (STATE.view === 'events') return renderEventsView(d, body);
  return renderSettings(d, body);
}

function blockerBanner(diag, route) {
  if (!diag.lastError) return '';
  if (diag.blocked) {
    return `<div class="banner err">
      <b>取数被 12306 拦截</b><br>
      查询端点返回了风控跳转，本工具不会去逆向它的客户端校验。这意味着<b>余票数据暂时拿不到</b>，
      但网络延迟探测、站点库、提醒通道都正常。<br>
      <span style="color:#a05a58">明细：<code>${esc(String(diag.lastError).slice(0, 160))}</code></span><br>
      可行做法：在浏览器打开
      <a href="https://kyfw.12306.cn/otn/leftTicket/init" target="_blank">12306 余票查询页</a>
      手动查（本工具仍会帮你记录时延与提醒），或稍后重试。
    </div>`;
  }
  return `<div class="banner">
    <b>上次采集未成功</b><br>
    <code>${esc(String(diag.lastError).slice(0, 200))}</code>
  </div>`;
}

function renderRadar(d, body, diag) {
  const r = currentRoute();
  if (!r) {
    body.innerHTML = '<div class="empty">还没有监控区间<small>点左上角 ＋ 添加一个</small></div>';
    return;
  }

  $('mainTitle').textContent = `${r.from} → ${r.to}`;
  $('mainSub').textContent = `${r.date} · ${r.rows ? r.rows.length + ' 趟车次' : '尚无数据'} · ${fmtAgo(r.updatedAt)}`;

  const wantSeats = (r.raw && r.raw.seats) || [];
  const cols = SEAT_FIELDS.filter((s) => (wantSeats.length ? wantSeats.includes(s.key) : ['second', 'first', 'business'].includes(s.key)));

  let html = blockerBanner(diag, r);

  if (!r.rows) {
    html += `<div class="empty">还没有采集到数据<small>点左下角"立即刷新"试一次</small></div>`;
    body.innerHTML = html;
    return;
  }
  if (!r.rows.length) {
    html += `<div class="empty">该区间该日期没有车次<small>可能是日期超出预售期，或该区间无直达车</small></div>`;
    body.innerHTML = html;
    return;
  }

  const rows = r.rows
    .map((row) => {
      const seatCells = cols
        .map((c) => {
          const s = row.seats[c.key];
          if (!s || s.state === 'unknown') return '';
          return `<span class="seat ${s.state}" title="${esc(c.name)}">${esc(c.short)} ${esc(s.text)}</span>`;
        })
        .join('');
      const anyAvail = cols.some((c) => row.seats[c.key] && row.seats[c.key].state === 'available');
      return `<tr class="${anyAvail ? 'hit' : ''}">
        <td><span class="train-code">${esc(row.code)}</span></td>
        <td>${esc(row.departTime)}</td>
        <td>${esc(row.arriveTime)}</td>
        <td style="color:#888">${esc(row.duration)}</td>
        <td>${seatCells || '<span style="color:#ccc">—</span>'}</td>
      </tr>`;
    })
    .join('');

  html += `<div class="card">
    <div class="card-head">
      <div class="card-title">余票明细</div>
      <div class="card-sub">端点 ${esc(r.endpoint || '—')} · 更新于 ${fmtTime(r.updatedAt)}</div>
    </div>
    <table class="grid">
      <thead><tr><th>车次</th><th>出发</th><th>到达</th><th>历时</th><th>席位</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div class="card">
    <div class="card-head"><div class="card-title">接下来怎么做</div></div>
    <div style="line-height:1.9;font-size:13px">
      1. 有余票的班次已标绿底；<b>下单请打开 12306 官方 App / 网站</b>。<br>
      2. 想提高成功率，优先在官方提交<b>候补订单</b>（可多车次／多席别／多日期），它的排队优先级高于任何手动抢票。<br>
      3. 本工具在余票出现变化时会通过微信提醒你，你只需在收到提醒后动手。
    </div>
  </div>`;

  body.innerHTML = html;
}

function renderLatency(d, body) {
  $('mainTitle').textContent = '网络延迟';
  $('mainSub').textContent = `最近一次 ${fmtAgo(d.diagnostics && d.diagnostics.lastRunAt)}`;

  const lat = d.latency || [];
  const staticSamples = lat.filter((x) => x.kind === 'static');
  const querySamples = lat.filter((x) => x.kind === 'query');
  const lastStatic = staticSamples[staticSamples.length - 1];
  const lastQuery = querySamples[querySamples.length - 1];

  const avg = (arr, key) => {
    const v = arr.map((x) => x[key]).filter((x) => typeof x === 'number');
    if (!v.length) return null;
    return Math.round(v.reduce((a, b) => a + b, 0) / v.length);
  };

  body.innerHTML = `
  <div class="lat-grid">
    <div class="lat-metric">
      <div class="k">静态资源 TTFB</div>
      <div class="v">${lastStatic && lastStatic.ttfb != null ? lastStatic.ttfb : '—'}<small>ms</small></div>
      <div class="k" style="margin-top:6px">均值 ${avg(staticSamples.slice(-30), 'ttfb') ?? '—'} ms</div>
    </div>
    <div class="lat-metric">
      <div class="k">TLS 握手</div>
      <div class="v">${lastStatic && lastStatic.tls != null ? lastStatic.tls : '—'}<small>ms</small></div>
      <div class="k" style="margin-top:6px">均值 ${avg(staticSamples.slice(-30), 'tls') ?? '—'} ms</div>
    </div>
    <div class="lat-metric">
      <div class="k">查询端点 TTFB</div>
      <div class="v">${lastQuery && lastQuery.ttfb != null ? lastQuery.ttfb : '—'}<small>ms</small></div>
      <div class="k" style="margin-top:6px">均值 ${avg(querySamples.slice(-30), 'ttfb') ?? '—'} ms</div>
    </div>
    <div class="lat-metric">
      <div class="k">采样点</div>
      <div class="v">${lat.length}<small>次</small></div>
      <div class="k" style="margin-top:6px">静态 ${staticSamples.length} / 查询 ${querySamples.length}</div>
    </div>
  </div>

  <div class="card" style="margin-top:14px">
    <div class="card-head">
      <div class="card-title">时延趋势</div>
      <div class="card-sub">最近 ${Math.min(lat.length, 120)} 次采样</div>
    </div>
    <canvas class="spark" id="sparkAll"></canvas>
    <div class="legend">
      <span><i style="background:#07c160"></i>静态资源 TTFB</span>
      <span><i style="background:#fa9d3b"></i>查询端点 TTFB</span>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><div class="card-title">怎么看这组数字</div></div>
    <div style="line-height:1.9;font-size:13px;color:#555">
      <b>TTFB</b>（首字节时间）是你点下查询到 12306 开始回数据的时间，它决定了"页面多久出结果"。<br>
      <b>TLS 握手</b>是建连开销，首次连接后会被复用，所以它高不代表查询慢。<br>
      <b>重要</b>：这些数字只影响你<b>看到</b>余票的快慢，<b>不影响你能否抢到票</b> ——
      12306 是服务端排队放票，第三方软件在队列里没有任何优先级。
    </div>
  </div>`;

  requestAnimationFrame(() => {
    const c = $('sparkAll');
    if (!c) return;
    const win = lat.slice(-120);
    drawSpark(
      c,
      [
        { data: win.map((x) => (x.kind === 'static' ? x.ttfb : null)) },
        { data: win.map((x) => (x.kind === 'query' ? x.ttfb : null)) },
      ],
      ['#07c160', '#fa9d3b']
    );
  });
}

function renderEventsView(d, body) {
  $('mainTitle').textContent = '提醒记录';
  const evs = (d.events || []).slice().reverse();
  $('mainSub').textContent = `${evs.length} 条`;

  if (!evs.length) {
    body.innerHTML = '<div class="empty">还没有提醒<small>当某趟车从无票变为有票时，这里会出现记录</small></div>';
    return;
  }
  body.innerHTML = `<div class="stream">${evs
    .map(
      (e) => `<div class="bubble-row">
      <div class="bubble-ico ${e.kind === 'becameAvailable' ? '' : 'warn'}">${e.kind === 'becameAvailable' ? '有票' : '变化'}</div>
      <div class="bubble">
        <div class="t">${esc(e.route || '')} · ${esc(e.trainCode)}</div>
        <div>${esc(e.text)}</div>
        <div class="meta">${new Date(e.ts).toLocaleString('zh-CN')} · ${esc(e.date || '')}</div>
      </div>
    </div>`
    )
    .join('')}</div>`;
}

function renderSettings(d, body) {
  $('mainTitle').textContent = '设置';
  $('mainSub').textContent = '配置保存在本地 data/config.json';
  const c = d.config;

  body.innerHTML = `
  <div class="card">
    <div class="card-head"><div class="card-title">微信推送</div>
      <div class="card-sub">${c.wechat.enabled ? '已启用' : '未启用'}</div></div>
    <div class="form-row">
      <label>启用推送</label>
      <label class="switch"><input type="checkbox" id="wxEnabled" ${c.wechat.enabled ? 'checked' : ''}> 有票时推到微信</label>
    </div>
    <div class="form-row">
      <label>通道</label>
      <select id="wxChannel">
        <option value="pushplus" ${c.wechat.channel === 'pushplus' ? 'selected' : ''}>PushPlus（微信服务号）</option>
        <option value="serverchan" ${c.wechat.channel === 'serverchan' ? 'selected' : ''}>Server酱³</option>
      </select>
      <span class="tip" id="wxHelp"></span>
    </div>
    <div class="form-row">
      <label>推送 token</label>
      <input type="text" id="wxToken" placeholder="粘贴 token / SendKey" value="${esc(c.wechat.token || '')}">
      <button class="btn-mini" id="btnWxTest">发送测试</button>
    </div>
    <div class="form-row">
      <label></label>
      <span class="tip" id="wxResult"></span>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><div class="card-title">采集频率</div>
      <div class="card-sub">当前 ${d.intervalSec}s${d.rushNow ? '（放票窗口提速中）' : ''}</div></div>
    <div class="form-row">
      <label>常态间隔</label>
      <input type="number" id="cfgInterval" min="20" max="3600" value="${c.intervalSec}">
      <span class="tip">秒。建议 ≥60：余票库不是实时的，秒级轮询只增加风控风险</span>
    </div>
    <div class="form-row">
      <label>放票窗口间隔</label>
      <input type="number" id="cfgRush" min="10" max="600" value="${c.rushIntervalSec}">
      <span class="tip">秒。8:00–18:00 每小时前 3 分钟生效</span>
    </div>
    <div class="form-row">
      <label>提醒去重窗口</label>
      <input type="number" id="cfgDedupe" min="1" max="720" value="${c.dedupeWindowMin}">
      <span class="tip">分钟。同一车次同一席别的同类变化在该窗口内只提醒一次</span>
    </div>
    <div class="form-row">
      <label>静默时段</label>
      <input type="number" id="cfgQuietS" min="0" max="23" value="${c.quietHours.start}" style="width:70px">
      <span>至</span>
      <input type="number" id="cfgQuietE" min="0" max="23" value="${c.quietHours.end}" style="width:70px">
      <span class="tip">时。${d.quietNow ? '<b style="color:#fa9d3b">当前处于静默时段</b>' : '当前会推送'}</span>
    </div>
    <div class="form-row"><label></label><button class="btn-primary" id="btnSaveCfg">保存设置</button></div>
  </div>

  <div class="card">
    <div class="card-head"><div class="card-title">这个工具做什么、不做什么</div></div>
    <div style="line-height:1.9;font-size:13px;color:#555">
      <b>会做</b>：只读查询余票、监测余票变化、微信提醒、采集 12306 网络时延、本地站点库（${d.stationCount} 站）。<br>
      <b>不会做</b>：不登录你的账号、不识别验证码、不自动下单、不自动支付、不做多账号、不做代理 IP 池。<br>
      <b>原因</b>：前一组是信息聚合，后一组会违反 12306 用户协议，且第三方在 12306 的放票队列里没有优先级 ——
      所谓"加速"在技术上不成立。<br>
      <b>最快的中票路径</b>：官方<b>候补购票</b>（多车次/多席别/多日期全排上）+ 本工具的退票回流提醒来手动补漏。
    </div>
  </div>`;

  const help = () => {
    $('wxHelp').innerHTML =
      $('wxChannel').value === 'serverchan'
        ? '<a href="https://sct.ftqq.com" target="_blank">sct.ftqq.com</a> 扫码后复制 SendKey'
        : '<a href="https://www.pushplus.plus" target="_blank">pushplus.plus</a> 扫码后在"一对一推送"复制 token';
  };
  help();
  $('wxChannel').onchange = help;

  $('btnWxTest').onclick = async () => {
    $('wxResult').textContent = '发送中…';
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        wechat: { enabled: true, channel: $('wxChannel').value, token: $('wxToken').value.trim() },
      }),
    });
    const r = await api('/api/notify/test', { method: 'POST', body: '{}' });
    $('wxResult').innerHTML = r.ok
      ? `<span style="color:#07c160">已提交到 ${esc(r.channel || '')}，请查看微信</span>`
      : `<span style="color:#e64340">失败：${esc(r.error || '未知错误')}</span>`;
  };

  $('btnSaveCfg').onclick = async () => {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        intervalSec: Number($('cfgInterval').value),
        rushIntervalSec: Number($('cfgRush').value),
        dedupeWindowMin: Number($('cfgDedupe').value),
        quietHours: { start: Number($('cfgQuietS').value), end: Number($('cfgQuietE').value) },
        wechat: {
          enabled: $('wxEnabled').checked,
          channel: $('wxChannel').value,
          token: $('wxToken').value.trim(),
        },
      }),
    });
    await refresh();
    $('wxResult').innerHTML = '<span style="color:#07c160">已保存</span>';
  };
}

/* ==================== 弹层 ==================== */

function openModal() {
  $('modalMask').hidden = false;
  $('modalError').hidden = true;
  $('seatChecks').innerHTML = SEAT_FIELDS.slice(0, 6)
    .map(
      (s, i) =>
        `<label><input type="checkbox" value="${s.key}" ${i === 0 || i === 1 ? 'checked' : ''}> ${esc(s.name)}</label>`
    )
    .join('');
}

function closeModal() {
  $('modalMask').hidden = true;
}

async function checkStation(inputId, hintId) {
  const q = $(inputId).value.trim();
  const hint = $(hintId);
  if (!q) { hint.textContent = ''; hint.className = 'hint'; return; }
  const r = await api('/api/resolve', { method: 'POST', body: JSON.stringify({ q }) });
  if (r.ok) {
    hint.textContent = `✓ ${r.result.name} (${r.result.code})`;
    hint.className = 'hint ok';
  } else {
    hint.textContent = '识别不了';
    hint.className = 'hint bad';
  }
}

/* ==================== 事件绑定 ==================== */

function bind() {
  document.querySelectorAll('.rail-btn').forEach((b) => {
    b.onclick = async () => {
      STATE.view = b.dataset.view;
      if (STATE.view === 'events') await api('/api/events/read', { method: 'POST', body: '{}' });
      await refresh();
    };
  });

  $('btnAdd').onclick = openModal;
  $('btnCancel').onclick = closeModal;
  $('modalMask').onclick = (e) => { if (e.target === $('modalMask')) closeModal(); };

  $('inFrom').onblur = () => checkStation('inFrom', 'hintFrom');
  $('inTo').onblur = () => checkStation('inTo', 'hintTo');

  $('btnSave').onclick = async () => {
    const seats = [...$('seatChecks').querySelectorAll('input:checked')].map((i) => i.value);
    const r = await api('/api/routes', {
      method: 'POST',
      body: JSON.stringify({
        from: $('inFrom').value.trim(),
        to: $('inTo').value.trim(),
        dateOffset: Number($('inOffset').value),
        seats,
      }),
    });
    if (!r.ok) {
      $('modalError').hidden = false;
      $('modalError').textContent = r.error || '添加失败';
      return;
    }
    closeModal();
    $('inFrom').value = '';
    $('inTo').value = '';
    await refresh();
  };

  $('btnPoll').onclick = async () => {
    if (STATE.busy) return;
    STATE.busy = true;
    $('btnPoll').disabled = true;
    $('btnPoll').textContent = '采集中…';
    try {
      await api('/api/poll', { method: 'POST', body: '{}' });
    } finally {
      STATE.busy = false;
      $('btnPoll').disabled = false;
      $('btnPoll').textContent = '立即刷新';
      await refresh();
    }
  };
}

/* ==================== SSE ==================== */

function connect() {
  const es = new EventSource('/api/events');
  let pending = null;
  const schedule = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; refresh(); }, 400);
  };
  for (const ev of ['latency', 'route', 'cycle', 'notify', 'notify-skipped']) {
    es.addEventListener(ev, schedule);
  }
  es.onerror = () => { /* EventSource 自带重连 */ };
}

/* ==================== 启动 ==================== */

bind();
refresh().then(connect);
setInterval(refresh, 15000);
