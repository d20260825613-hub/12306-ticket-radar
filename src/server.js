'use strict';

/**
 * 本地服务：静态页面 + JSON API + SSE 实时推送。
 *
 * 只监听 127.0.0.1，不对外暴露。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const state = require('./core/state');
const stations = require('./core/stations');
const engineMod = require('./core/engine');
const providers = require('./core/providers');
const wechat = require('./notify/wechat');

const WEB_DIR = path.join(__dirname, '..', 'web');
// 与 state.js 的 DATA_DIR 保持一致，支持环境变量重定向
const PORT_FILE = path.join(state.DATA_DIR, 'port.txt');

/** 版本号取自 package.json，供界面展示。 */
let APP_VERSION = '0.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  if (pkg.version) APP_VERSION = pkg.version;
} catch {
  /* 读不到就保持默认 */
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const engine = new engineMod.Engine();
/** SSE 客户端集合 */
const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

engine.on('latency', (s) => broadcast('latency', s));
engine.on('route', (r) =>
  broadcast('route', {
    ok: r.ok,
    blocked: r.blocked || false,
    error: r.error || null,
    from: r.from ? r.from.name : null,
    to: r.to ? r.to.name : null,
    date: r.date || null,
    endpoint: r.endpoint || null,
    elapsedMs: r.elapsedMs || null,
    count: r.rows ? r.rows.length : 0,
  })
);
engine.on('notify', (n) => broadcast('notify', n));
engine.on('notify-skipped', (n) => broadcast('notify', n));
engine.on('cycle', (c) => broadcast('cycle', c.diagnostics));

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * 自检：界面文件是否还在。
 * API 全在内存里，即使安装目录被删除或移动也照常响应；
 * 但静态文件是每次请求从磁盘读的，一旦目录没了所有页面就 404。
 * 这个函数用来把那种情况识别出来，并给出可读解释，而不是返回裸 "not found"。
 */
function webDirStatus() {
  try {
    if (!fs.existsSync(WEB_DIR)) return { ok: false, exists: false, files: 0 };
    const files = fs.readdirSync(WEB_DIR).filter((f) => f.endsWith('.html') || f.endsWith('.css') || f.endsWith('.js'));
    return { ok: files.length > 0, exists: true, files: files.length };
  } catch (e) {
    return { ok: false, exists: false, files: 0, error: e.message };
  }
}

/** 界面文件不可用时返回的恢复页面。 */
function sendWebMissingPage(res) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>界面文件不可用 · 12306 余票雷达</title>
<style>
  body{margin:0;padding:48px 24px;background:#f2f3f5;color:#1a1a1a;
       font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .box{max-width:640px;margin:0 auto;background:#fff;border-radius:12px;
       padding:28px 30px;box-shadow:0 4px 16px rgba(16,24,40,.08)}
  h1{margin:0 0 6px;font-size:18px}
  .sub{color:#888;font-size:12.5px;margin-bottom:20px}
  .warn{background:#fff8e6;border:1px solid #ffe0a3;color:#8a5a00;
        border-radius:8px;padding:12px 14px;font-size:13px;margin-bottom:18px}
  code{background:rgba(127,127,127,.14);padding:1px 6px;border-radius:4px;
       font-family:Consolas,Menlo,monospace;font-size:12px;word-break:break-all}
  ol{padding-left:20px;margin:10px 0}
  li{margin:6px 0}
  button{margin-top:18px;border:0;border-radius:8px;padding:10px 20px;
         background:#07c160;color:#fff;font-size:14px;cursor:pointer}
  button:hover{background:#06ad56}
  .kv{color:#888;font-size:12px;margin-top:18px;border-top:1px solid #eee;padding-top:12px}
</style></head><body>
<div class="box">
  <h1>界面文件不可用</h1>
  <div class="sub">12306 余票雷达 · 服务进程仍在运行</div>
  <div class="warn">
    服务的 API 正常，但读取界面文件失败 —— 程序所在的目录已被删除或移动。
  </div>
  <p>常见原因：程序运行期间，它的安装目录被重新构建、删除或改名。</p>
  <ol>
    <li>关闭正在运行的程序窗口（那个控制台窗口）</li>
    <li>重新双击 <code>余票雷达.exe</code> 启动</li>
  </ol>
  <p style="color:#888;font-size:12.5px">
    如果你刚更新过版本，这一步是必须的 —— 新版代码只有重启才会加载。
  </p>
  <button onclick="location.reload()">重新加载</button>
  <div class="kv">
    期望的界面目录：<code>${WEB_DIR.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>
  </div>
</div></body></html>`;
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(WEB_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // 界面文件整个缺失时，给出可读的恢复指引而不是裸 404
      const w = webDirStatus();
      if (!w.ok) return sendWebMissingPage(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found: ' + urlPath);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

/** 汇总当前状态给前端。 */
function snapshotPayload() {
  const cfg = state.getConfig();
  const st = state.getState();
  const latency = st.latency.slice(-120);

  const routes = (cfg.routes || []).map((r) => {
    const from = stations.resolve(r.from);
    const to = stations.resolve(r.to);
    const date = r.date || engineMod.todayPlus(r.dateOffset == null ? DEFAULT_DATE_OFFSET : r.dateOffset);
    const key = state.routeKey(Object.assign({}, r, { date }));
    const snap = st.snapshots[key];
    return {
      raw: r,
      from: from ? from.name : r.from,
      to: to ? to.name : r.to,
      fromCode: from ? from.code : '',
      toCode: to ? to.code : '',
      date,
      rows: snap ? snap.rows : null,
      updatedAt: snap ? snap.ts : null,
      endpoint: snap ? snap.endpoint : null,
    };
  });

  return {
    config: cfg,
    stationCount: stations.count(),
    diagnostics: engine.diagnostics,
    latency,
    events: st.events.slice(-60).reverse(),
    unread: st.events.filter((e) => !e.read).length,
    routes,
    quietNow: state.isQuietNow(),
    rushNow: state.isRushWindow(),
    intervalSec: state.currentIntervalSec(),
    serverTime: Date.now(),
    /** 数据源现状：哪个可用、当前会选谁、为什么 */
    dataSource: (() => {
      const choice = providers.pick(cfg.dataSource);
      return {
        providers: providers.list().map((p) => Object.assign({}, p, {
          ready: providers.get(p.id).ready(cfg.dataSource),
        })),
        active: choice.provider ? choice.provider.name : null,
        reason: choice.reason,
        anyReady: !!choice.provider,
      };
    })(),
  };
}

/**
 * 监控日期的上限与默认值（天）。
 *
 * 12306 预售期约 14 天，超出后任何数据源都查不到。
 * 历史上默认用 45 天 —— 结果"测试连接"（7 天）成功、
 * 实际采集（45 天）必然失败，非常误导。这里统一收敛。
 */
const MAX_DATE_OFFSET = 14;
const DEFAULT_DATE_OFFSET = 7;

function clampDateOffset(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return DEFAULT_DATE_OFFSET;
  return Math.min(Math.round(v), MAX_DATE_OFFSET);
}

/** 精简站点列表，供前端自动补全（约 130KB，一次拉取后缓存）。 */
let stationIndexCache = null;
function stationIndex() {
  if (stationIndexCache) return stationIndexCache;
  stationIndexCache = stations.load().map((s) => ({ n: s.name, c: s.code, p: s.pinyin, y: s.city }));
  return stationIndexCache;
}

const server = http.createServer(async (req, res) => {
  // 解析请求目标必须自己兜住。这句原本在 try 之外，一个畸形 URL 抛出的异常
  // 会冒出请求处理器，而未捕获的异常直接杀掉整个进程 —— 一个坏 URL 就能
  // 打死一个设计成连续跑几周的盯票服务。
  let u;
  try {
    u = new URL(req.url, 'http://127.0.0.1');
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request\n');
    return;
  }
  const p = u.pathname;

  try {
    if (p === '/api/state') {
      const payload = snapshotPayload();
      payload.web = webDirStatus();
      payload.version = APP_VERSION;
      return sendJson(res, 200, payload);
    }

    // 从网页里停止程序 —— 否则用户只能去找那个控制台窗口
    if (p === '/api/shutdown' && req.method === 'POST') {
      sendJson(res, 200, { ok: true, message: '正在退出' });
      console.log('');
      console.log('  收到网页端的退出请求，正在关闭…');
      // 先让响应发出去，再收尾
      setTimeout(() => {
        engine.stop();
        state.saveState();
        try {
          server.close();
        } catch {
          /* 已关闭 */
        }
        setTimeout(() => process.exit(0), 200);
      }, 150);
      return;
    }

    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (p === '/api/stations') {
      return sendJson(res, 200, { ok: true, stations: stationIndex() });
    }

    if (p === '/api/events/clear' && req.method === 'POST') {
      state.getState().events = [];
      state.saveState();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/resolve' && req.method === 'POST') {
      const body = await readBody(req);
      const r = stations.resolve(body.q);
      return sendJson(res, 200, { ok: !!r, result: r });
    }

    if (p === '/api/routes' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = state.getConfig();
      const from = stations.resolve(body.from);
      const to = stations.resolve(body.to);
      if (!from || !to) return sendJson(res, 400, { ok: false, error: '站点无法识别，请检查站名' });
      const route = {
        from: from.name,
        to: to.name,
        // 收敛到预售期内：超出 14 天任何数据源都查不到
        dateOffset: clampDateOffset(Number(body.dateOffset) || DEFAULT_DATE_OFFSET),
        seats: Array.isArray(body.seats) && body.seats.length ? body.seats : ['second', 'first'],
      };
      cfg.routes = (cfg.routes || []).filter((r) => !(r.from === route.from && r.to === route.to && r.dateOffset === route.dateOffset));
      cfg.routes.push(route);
      state.saveConfig();
      engine.restart();
      return sendJson(res, 200, { ok: true, route, config: cfg });
    }

    if (p === '/api/routes/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = state.getConfig();
      const before = (cfg.routes || []).length;
      cfg.routes = (cfg.routes || []).filter(
        (r) => !(r.from === body.from && r.to === body.to && String(r.dateOffset) === String(body.dateOffset))
      );
      state.saveConfig();
      engine.restart();
      return sendJson(res, 200, { ok: true, removed: before - cfg.routes.length });
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = state.getConfig();
      // 网页里填的数字是不可信输入，而且它直接决定定时器延时：1e21 会让
      // setTimeout 溢出、被 Node 折算成 1ms，引擎于是以约 70 次/秒的节奏
      // 猛打上游。写侧拒绝非数字并把越界值收敛到可用范围，读侧另有一道兜底。
      for (const [k, min, max] of [
        ['intervalSec', state.MIN_INTERVAL_SEC, state.MAX_INTERVAL_SEC],
        ['rushIntervalSec', state.MIN_INTERVAL_SEC, state.MAX_INTERVAL_SEC],
        ['dedupeWindowMin', 0, state.MAX_DEDUPE_WINDOW_MIN],
      ]) {
        if (body[k] === undefined) continue;
        const v = Number(body[k]);
        if (!Number.isFinite(v)) {
          return sendJson(res, 400, { ok: false, error: `${k} 必须是数字` });
        }
        cfg[k] = Math.min(Math.max(Math.round(v), min), max);
      }
      if (body.rushWindowEnabled !== undefined) cfg.rushWindowEnabled = Boolean(body.rushWindowEnabled);
      if (body.quietHours) cfg.quietHours = Object.assign({}, cfg.quietHours, body.quietHours);
      if (body.notifyOn) cfg.notifyOn = Object.assign({}, cfg.notifyOn, body.notifyOn);
      if (body.wechat) {
        cfg.wechat = Object.assign({}, cfg.wechat, body.wechat);
      }
      if (body.dataSource) {
        const ds = body.dataSource;
        cfg.dataSource = Object.assign({}, cfg.dataSource, ds);
        if (ds.apihz) {
          cfg.dataSource.apihz = Object.assign({}, cfg.dataSource.apihz, ds.apihz);
        }
      }
      state.saveConfig();
      // 只重排下一次采集：改频率/推送设置不该额外触发一次 12306 查询
      engine.reschedule();
      return sendJson(res, 200, { ok: true, config: cfg, intervalSec: state.currentIntervalSec() });
    }

    if (p === '/api/notify/test' && req.method === 'POST') {
      const cfg = state.getConfig();
      const r = await wechat.sendTest(cfg.wechat);
      return sendJson(res, 200, r);
    }

    // 数据源自检：用一次真实查询验证 id/key 是否可用
    if (p === '/api/datasource/test' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = state.getConfig();
      // 允许用请求里带的值临时覆盖，方便"先测再存"
      const probeCfg = body && (body.id || body.key)
        ? Object.assign({}, cfg.dataSource, {
            apihz: Object.assign({}, cfg.dataSource.apihz, {
              id: body.id || cfg.dataSource.apihz.id,
              key: body.key || cfg.dataSource.apihz.key,
              endpoint: '',
            }),
          })
        : cfg.dataSource;

      const provider = providers.get('apihz');
      if (typeof provider.testConnection !== 'function') {
        return sendJson(res, 200, { ok: false, error: '该数据源不支持自检' });
      }
      const r = await provider.testConnection(probeCfg);
      return sendJson(res, 200, r);
    }

    if (p === '/api/poll' && req.method === 'POST') {
      const r = await engine.runCycle();
      return sendJson(res, 200, { ok: true, diagnostics: engine.diagnostics, results: (r.results || []).map((x) => ({ ok: x.ok, error: x.error || null, blocked: x.blocked || false, count: x.rows ? x.rows.length : 0 })) });
    }

    if (p === '/api/events/read' && req.method === 'POST') {
      for (const e of state.getState().events) e.read = true;
      state.saveState();
      return sendJson(res, 200, { ok: true });
    }

    return serveStatic(req, res, p);
  } catch (e) {
    console.error('[server] 请求处理异常:', e);
    return sendJson(res, 500, { ok: false, error: e.message });
  }
});

/**
 * 打开默认浏览器。
 * 这是可选便利功能 —— 任何失败都必须被吞掉，绝不能影响服务本身。
 * （实测：受限环境下 exec 会抛 EPERM，若未捕获会直接崩掉整个进程。）
 */
function openBrowser(url) {
  try {
    const cmd =
      process.platform === 'win32'
        ? `cmd /c start "" "${url}"`
        : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
    const child = exec(cmd, () => {
      /* 打不开就算了，用户可手动访问 */
    });
    if (child && typeof child.on === 'function') {
      child.on('error', () => {
        /* spawn 失败同样忽略 */
      });
    }
  } catch (e) {
    console.log(`  (未能自动打开浏览器: ${e.message}，请手动访问 ${url})`);
  }
}

function start() {
  state.loadConfig();
  state.loadState();

  const cfg = state.getConfig();

  // 首次运行给一条默认监控线路，避免空界面
  if (!cfg.routes || !cfg.routes.length) {
    cfg.routes = [{ from: '北京南', to: '上海虹桥', dateOffset: DEFAULT_DATE_OFFSET, seats: ['second', 'first'] }];
    state.saveConfig();
  }

  // 收敛历史配置里超出预售期的日期。
  // 旧版本的界面提供过 30/45 天选项，那些线路必然查不到数据 ——
  // 直接改掉比让用户对着"查询失败"猜要友好得多。
  {
    const fixed = [];
    for (const r of cfg.routes) {
      const clamped = clampDateOffset(r.dateOffset);
      if (clamped !== r.dateOffset) {
        fixed.push(`    ${r.from} → ${r.to}：${r.dateOffset} 天 → ${clamped} 天`);
        r.dateOffset = clamped;
      }
    }
    if (fixed.length) {
      state.saveConfig();
      console.warn('');
      console.warn('  [!] 以下线路的日期超出预售期（约 14 天），已自动收敛：');
      for (const line of fixed) console.warn(line);
      console.warn('      原因：12306 预售期约 14 天，超出后任何数据源都查不到。');
      console.warn('');
    }
  }

  const port = Number(process.env.PORT || cfg.httpPort || 12308);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('');
      console.error(`  [x] 端口 ${port} 已被占用。`);
      console.error(`      可能已有一个本程序在运行 —— 直接访问 http://127.0.0.1:${port}/`);
      console.error('      若确认不是本程序，可换端口启动:');
      console.error(`        set PORT=12309 && node src\\server.js`);
      console.error('');
    } else {
      console.error(`  [x] 服务启动失败: ${err.message}`);
    }
    engine.stop();
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    // 记录端口只是方便排查；写不了就算了，绝不影响服务
    try {
      fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
      fs.writeFileSync(PORT_FILE, String(port), 'utf8');
    } catch (e) {
      console.warn(`  (端口文件无法写入 ${PORT_FILE}：${e.message})`);
    }
    console.log('');
    console.log('  🚄 12306 余票雷达');
    console.log(`  面板地址: ${url}`);
    console.log(`  站点库:   ${stations.count()} 个车站`);
    console.log(`  轮询间隔: ${state.currentIntervalSec()}s`);
    console.log('  提示: 本工具只做查询与提醒，下单请用 12306 官方渠道');
    // 启动即自检界面文件：缺了要立刻说清楚，而不是等用户点开页面看到 404
    const web = webDirStatus();
    if (!web.ok) {
      console.warn('');
      console.warn('  [!] 界面文件不可用 —— 页面会显示恢复指引。');
      console.warn(`      期望目录: ${WEB_DIR}`);
      console.warn('      原因通常是：程序运行期间该目录被删除或移动。');
      console.warn('      处理办法：关闭本窗口，重新双击程序启动。');
      console.warn('');
    }
    console.log('');
    if (cfg.autoOpenBrowser && !process.env.NO_OPEN) openBrowser(url);
  });

  engine.start();

  const shutdown = () => {
    console.log('\n[server] 正在退出…');
    engine.stop();
    state.saveState();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) start();

module.exports = { start, server, engine };
