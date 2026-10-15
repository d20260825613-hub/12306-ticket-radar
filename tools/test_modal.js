'use strict';

/**
 * 添加监控区间弹层的开关行为测试。
 *
 * 背景：用户反馈"弹窗无法关闭"。重点验证所有关闭路径：
 *   取消按钮 / 右上角 × / 点遮罩空白处 / Esc 键
 *
 * 用最小 DOM stub 加载真实 web/app.js，直接调用绑定的处理函数。
 *
 * 用法: node tools/test_modal.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const APP_JS = path.join(ROOT, 'web', 'app.js');

/* ══════════════ 最小 DOM ══════════════ */

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
    this.onclick = null;
    this.oninput = null;
    this.onchange = null;
    this.onblur = null;
    this.onkeydown = null;

    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._classes.add(x)),
      remove: (...c) => c.forEach((x) => self._classes.delete(x)),
      toggle: (c, on) =>
        on === undefined
          ? self._classes.has(c)
            ? self._classes.delete(c)
            : self._classes.add(c)
          : on
          ? self._classes.add(c)
          : self._classes.delete(c),
      contains: (c) => self._classes.has(c),
    };
  }

  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this._text = v.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this._html = String(v); }

  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() {}
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener() {}
  focus() {}
  blur() {}
  setSelectionRange() {}
  scrollIntoView() {}
  getContext() { return new Proxy({}, { get: () => () => {} }); }

  click() {
    if (typeof this.onclick === 'function') {
      return this.onclick({ target: this, stopPropagation() {}, preventDefault() {}, closest: () => null });
    }
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
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

/**
 * 用 HTML 里声明的 hidden 属性初始化 DOM。
 *
 * 之前的测试桩没做这一步，于是"弹层初始是否隐藏"这类断言全是假结果 ——
 * 而恰是这个问题（弹层关不掉）真正的原因是 CSS 压不住。
 */
function initFromHtml(html) {
  const re = /<[a-zA-Z][^>]*\bid="([\w-]+)"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const id = m[1];
    const el = documentStub.getElementById(id);
    if (/\bhidden\b/.test(tag)) el.hidden = true;
  }
}

let globalKeyHandler = null;

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
  createElement: (tag) => new El(tag),
  addEventListener: (ev, fn) => {
    if (ev === 'keydown') globalKeyHandler = fn;
  },
  documentElement: new El('html'),
};

/* ══════════════ mock 数据 ══════════════ */

const now = Date.now();
const appState = {
  config: {
    routes: [], intervalSec: 60, rushIntervalSec: 20, dedupeWindowMin: 10,
    quietHours: { start: 23, end: 6 },
    wechat: { enabled: false, channel: 'pushplus', token: '' },
  },
  stationCount: 3384,
  diagnostics: { lastRunAt: now, lastOkAt: now, lastError: null, blocked: false, cycles: 1, consecutiveFailures: 0 },
  latency: [],
  events: [],
  unread: 0,
  routes: [],
  quietNow: false, rushNow: false, intervalSec: 60, serverTime: now, version: '0.1.0',
};

const sandbox = {
  document: documentStub,
  window: {
    devicePixelRatio: 1,
    open: () => {},
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
  },
  navigator: {},
  fetch: async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/api/state') ? appState : { ok: true }),
  }),
  EventSource: class { constructor() {} addEventListener() {} },
  requestAnimationFrame: (fn) => fn(),
  setTimeout: (fn, ms) => {
    // 同步执行，便于测试 focus/blur 之类的延时逻辑
    if (typeof fn === 'function' && (ms === undefined || ms <= 200)) fn();
    return 0;
  },
  setInterval: () => 0,
  clearTimeout: () => {},
  console,
  confirm: () => true,
  getComputedStyle: () => ({ getPropertyValue: () => '#07c160' }),
};
sandbox.globalThis = sandbox;

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
  }
}

const run = (expr) => vm.runInContext(expr, sandbox);
const $ = (id) => documentStub.getElementById(id);

/* ══════════════ 执行 ══════════════ */

// 按真实 index.html 的 hidden 属性初始化 DOM
try {
  initFromHtml(fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8'));
} catch (e) {
  console.error('读取 index.html 失败:', e.message);
  process.exit(1);
}

try {
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), sandbox, { filename: 'app.js' });
  console.log('app.js 加载成功\n');
} catch (e) {
  console.error('app.js 加载失败:', e.message);
  process.exit(1);
}

setTimeout(() => {
  console.log('【打开弹层】');
  const mask = $('modalMask');
  check('初始状态是隐藏的', mask.hidden === true, 'hidden=' + mask.hidden);

  $('btnAdd').click();
  check('点 ＋ 后弹层显示', mask.hidden === false, 'hidden=' + mask.hidden);
  check('自动补全下拉初始隐藏', $('acFrom').hidden === true);
  check('生成了日期 chips', $('dateChips').children.length > 0 || $('dateChips').innerHTML.includes('chip'));

  console.log('\n【关闭路径 1：取消按钮】');
  $('btnCancel').click();
  check('取消后弹层隐藏', mask.hidden === true, 'hidden=' + mask.hidden);

  console.log('\n【关闭路径 2：右上角 ×】');
  $('btnAdd').click();
  check('重新打开成功', mask.hidden === false);
  $('btnCloseModal').click();
  check('点 × 后弹层隐藏', mask.hidden === true, 'hidden=' + mask.hidden);

  console.log('\n【关闭路径 3：点遮罩空白处】');
  $('btnAdd').click();
  check('重新打开成功', mask.hidden === false);
  // 模拟点在遮罩本身（target === mask）
  if (typeof mask.onclick === 'function') {
    mask.onclick({ target: mask });
    check('点遮罩后弹层隐藏', mask.hidden === true, 'hidden=' + mask.hidden);
  } else {
    check('遮罩绑定了点击处理', false, 'mask.onclick 未绑定');
  }

  console.log('\n【关闭路径 4：Esc 键】');
  $('btnAdd').click();
  check('重新打开成功', mask.hidden === false);
  if (globalKeyHandler) {
    globalKeyHandler({ key: 'Escape', preventDefault() {} });
    check('Esc 后弹层隐藏', mask.hidden === true, 'hidden=' + mask.hidden);
  } else {
    check('注册了全局键盘处理', false, '未注册 keydown');
  }

  console.log('\n【连续开关（回归：曾经点不开/关不掉）】');
  let allOk = true;
  for (let i = 0; i < 6; i++) {
    $('btnAdd').click();
    if (mask.hidden !== false) { allOk = false; break; }
    $('btnCancel').click();
    if (mask.hidden !== true) { allOk = false; break; }
  }
  check('连续 6 次开关都正常', allOk);

  console.log('\n【自动补全下拉不会挡住关闭】');
  $('btnAdd').click();
  $('inFrom').value = '北京';
  if (typeof $('inFrom').oninput === 'function') $('inFrom').oninput();
  check('输入后下拉有内容或已隐藏', $('acFrom').hidden === true || $('acFrom').innerHTML.length > 0);
  $('btnCancel').click();
  check('下拉展开状态下仍能关闭弹层', mask.hidden === true, 'hidden=' + mask.hidden);
  check('关闭时一并隐藏了下拉', $('acFrom').hidden === true && $('acTo').hidden === true,
    'from=' + $('acFrom').hidden + ' to=' + $('acTo').hidden);

  console.log('\n【确认弹层】');
  const cm = $('confirmMask');
  check('确认弹层初始隐藏', cm.hidden === true);
  run("askConfirm({title:'t', html:'x'})");
  check('askConfirm 后显示', cm.hidden === false);
  $('confirmNo').click();
  check('点取消后隐藏', cm.hidden === true);
  run("askConfirm({title:'t', html:'x'})");
  $('confirmYes').click();
  check('点确定后隐藏', cm.hidden === true);

  console.log('\n【CSS 层叠（这是"关不掉"的真正原因）】');
  const css = fs.readFileSync(path.join(ROOT, 'web', 'styles.css'), 'utf8');

  // 必须有 !important 的 [hidden] 规则，否则 .mask{display:flex} 会压过它
  const hiddenRules = css.match(/\[hidden\][^{]*\{[^}]*\}/g) || [];
  const strongRule = hiddenRules.find((r) => /display\s*:\s*none\s*!important/.test(r));
  check('存在 [hidden] { display:none !important } 规则', !!strongRule, hiddenRules.join(' | ') || '没找到任何 [hidden] 规则');

  check('存在 .mask[hidden] 兜底规则', /\.mask\[hidden\][^{]*\{[^}]*display\s*:\s*none/.test(css));

  // .mask 确实用了 flex（正因如此才需要 !important 来压住）
  check('.mask 使用 display:flex（因此必须用 !important 压制）', /\.mask\s*\{[^}]*display\s*:\s*flex/.test(css));

  // !important 规则必须出现在 .mask 之前或之后都行 —— 因为 !important 优先级更高，与顺序无关
  const impIdx = css.search(/\[hidden\]\s*\{[^}]*!important/);
  const maskIdx = css.search(/\.mask\s*\{/);
  check('两条规则都存在（顺序不影响，!important 优先）', impIdx >= 0 && maskIdx >= 0,
    'hidden@' + impIdx + ' mask@' + maskIdx);

  console.log('\n【绑定健壮性】');
  const js = fs.readFileSync(APP_JS, 'utf8');
  check('用 safeBind 包裹各组绑定', /function safeBind/.test(js) && (js.match(/safeBind\(/g) || []).length >= 8,
    'safeBind 调用 ' + (js.match(/safeBind\(/g) || []).length + ' 次');
  check('绑定失败会提示用户而不是静默', /界面初始化异常/.test(js));
  check('注册了全局错误监听', /addEventListener\('unhandledrejection'/.test(js));

  console.log('\n══════════════════════════════');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
}, 60);
