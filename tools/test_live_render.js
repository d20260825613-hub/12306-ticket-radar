'use strict';

/**
 * 用「线上真实响应」驱动渲染，找出视图崩溃的原因。
 *
 * 为什么需要它：smoke_ui 里的 mock 数据是我自己造的，字段永远齐全，
 * 所以"新功能在真实 payload 下会不会挂"根本没被覆盖。
 * 这个工具直接抓线上 /api/state，逐个视图渲染，把异常打出来。
 *
 * 用法: node tools/test_live_render.js [端口]
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || 12308);

/* ────────────── 最小 DOM（与 smoke_ui 一致的精简版） ────────────── */

class El {
  constructor(tag, id) {
    this.tagName = (tag || 'div').toUpperCase();
    this.id = id || '';
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.dataset = {};
    this._html = '';
    this._text = '';
    this._classes = new Set();
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.selectionStart = 0;
    this.clientWidth = 800;
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._classes.add(x)),
      remove: (...c) => c.forEach((x) => self._classes.delete(x)),
      toggle: (c, on) => (on ? self._classes.add(c) : self._classes.delete(c)),
      contains: (c) => self._classes.has(c),
    };
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this._text = String(v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this._html = String(v); }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() {}
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener() {}
  focus() {} blur() {} setSelectionRange() {} scrollIntoView() {}
  getContext() { return new Proxy({}, { get: () => () => {} }); }
  click() { if (typeof this.onclick === 'function') this.onclick({ target: this, stopPropagation() {}, preventDefault() {}, closest: () => null }); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

function matches(el, sel) {
  const s = sel.trim();
  if (s.startsWith('#')) return el.id === s.slice(1);
  if (s.startsWith('.')) return el._classes.has(s.slice(1));
  if (s.startsWith('[')) {
    const m = s.match(/^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/);
    if (!m) return false;
    const key = m[1].replace(/^data-/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
    return m[2] === undefined ? el.dataset[key] !== undefined : String(el.dataset[key]) === m[2];
  }
  return el.tagName === s.toUpperCase();
}

const registry = new Map();
const navItems = ['radar', 'latency', 'events', 'help', 'settings'].map((v) => {
  const el = new El('button');
  el.dataset.view = v;
  el._classes.add('nav-item');
  return el;
});

const documentStub = {
  body: new El('body'),
  getElementById: (id) => {
    if (!registry.has(id)) registry.set(id, new El('div', id));
    return registry.get(id);
  },
  querySelectorAll: (sel) => {
    if (sel === '.nav-item') return navItems;
    const out = [];
    for (const el of registry.values()) if (matches(el, sel)) out.push(el);
    return out;
  },
  createElement: (t) => new El(t),
  addEventListener: () => {},
  documentElement: new El('html'),
};

/* ────────────── 抓线上数据 ────────────── */

function fetchJson(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 15000 }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, json: JSON.parse(Buffer.concat(c).toString('utf8')) });
        } catch (e) {
          resolve({ ok: false, error: '非 JSON: ' + e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

(async () => {
  console.log(`\n用线上真实响应驱动渲染（端口 ${PORT}）`);

  let live = await fetchJson('/api/state');

  // 没有运行中的实例时，自己起一个 —— 这个测试要验证"服务端真实 payload
  // 能否驱动渲染"，所以必须拿到真实 payload，不能用手写 mock。
  let ownServer = null;
  if (!live.ok) {
    console.log('  未发现运行中的实例，自行启动一个…');
    const os = require('os');
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-live-'));
    process.env.TICKET_RADAR_DATA = TMP;
    process.env.NO_OPEN = '1';
    const P = 43000 + Math.floor(Math.random() * 8000);
    process.env.PORT = String(P);
    fs.writeFileSync(
      path.join(TMP, 'config.json'),
      JSON.stringify({
        routes: [{ from: '北京南', to: '上海虹桥', dateOffset: 7, seats: ['second', 'first', 'business'] }],
        intervalSec: 300,
        dataSource: { provider: 'auto', apihz: { id: '', key: '' }, fallbackToApihz: true, tryDirect: false },
        autoOpenBrowser: false,
        httpPort: P,
      }, null, 2),
      'utf8'
    );
    ownServer = require(path.join(ROOT, 'src', 'server.js'));
    ownServer.start();
    await new Promise((r) => setTimeout(r, 900));
    ownServer.engine.stop();
    // 换端口重新探测
    live = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: P, path: '/api/state', timeout: 15000 }, (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => {
          try {
            resolve({ ok: true, json: JSON.parse(Buffer.concat(c).toString('utf8')) });
          } catch (e) {
            resolve({ ok: false, error: 'non-json' });
          }
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    });
    global.__tmpData = TMP;
  }

  if (!live.ok) {
    console.log('无法获取状态: ' + live.error);
    process.exit(1);
  }
  const realState = live.json;

  const cleanup = () => {
    if (ownServer) {
      try { ownServer.server.close(); } catch { /* ignore */ }
      try { fs.rmSync(global.__tmpData, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };

  console.log('\n【线上 payload 的顶层字段】');
  console.log('  ' + Object.keys(realState).join(', '));
  const hasDs = 'dataSource' in realState;
  check('payload 含 dataSource 字段', hasDs,
    hasDs ? '' : '缺失 —— 服务端是旧版本，界面却已是新版本，两者不匹配');
  if (hasDs) {
    console.log('  dataSource: ' + JSON.stringify(realState.dataSource).slice(0, 200));
  }

  // 用真实 payload 渲染
  const sandbox = {
    document: documentStub,
    window: { devicePixelRatio: 1, open: () => {}, matchMedia: () => ({ matches: false }), addEventListener: () => {} },
    navigator: {},
    fetch: async () => ({ ok: true, status: 200, json: async () => realState }),
    EventSource: class { constructor() {} addEventListener() {} },
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    setInterval: () => 0,
    clearTimeout: () => {},
    console,
    confirm: () => true,
    getComputedStyle: () => ({ getPropertyValue: () => '#07c160' }),
  };
  sandbox.globalThis = sandbox;

  try {
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
  } catch (e) {
    console.log('\napp.js 加载失败: ' + e.message);
    process.exit(1);
  }

  const run = (x) => vm.runInContext(x, sandbox);
  const mainHtml = () => documentStub.getElementById('mainBody').innerHTML;

  // 用真实 payload 覆盖 S.data
  run(`S.data = ${JSON.stringify(realState)}`);

  console.log('\n【逐视图渲染（真实 payload）】');
  for (const view of ['radar', 'latency', 'events', 'help', 'settings']) {
    let err = null;
    try {
      run(`S.view=${JSON.stringify(view)}`);
      run('render()');
    } catch (e) {
      err = e;
    }
    const html = err ? '' : mainHtml();
    check(
      `${view} 视图渲染成功`,
      !err,
      err ? err.message : ''
    );
    if (!err) {
      check(`  ${view} 视图有内容`, html.length > 50, 'len=' + html.length);
    } else {
      console.log('       堆栈: ' + String(err.stack || '').split('\n')[1]);
    }
  }

  console.log('\n【设置页关键控件】');
  run("S.view='settings'");
  let settingsHtml = '';
  try {
    run('render()');
    settingsHtml = mainHtml();
  } catch (e) {
    check('设置页渲染', false, e.message);
  }
  if (settingsHtml) {
    for (const [name, needle] of [
      ['数据源 ID 输入框', 'id="dsId"'],
      ['数据源 KEY 输入框', 'id="dsKey"'],
      ['测试连接按钮', 'id="btnDsTest"'],
      ['数据源模式下拉', 'id="dsProvider"'],
      ['微信 token 输入框', 'id="wxToken"'],
      ['频率配置', 'id="cfgInterval"'],
    ]) {
      check(name, settingsHtml.includes(needle), needle);
    }
    // 渲染后处理函数是否真的绑上了（这才是"打不开/点不动"的关键）
    const dsTest = documentStub.getElementById('btnDsTest');
    check('测试连接按钮绑定了处理函数', typeof dsTest.onclick === 'function',
      'onclick=' + typeof dsTest.onclick);
    const dsId = documentStub.getElementById('dsId');
    check('数据源 ID 输入框是输入元素', dsId.tagName !== 'DIV' || dsId.value !== undefined);
  }

  console.log('\n══════════════════════════════');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
