'use strict';

/**
 * 测试用的最小 DOM 实现（共享）。
 *
 * 为什么要有这个文件：界面测试原先各自手写 DOM 桩，行为不一致，
 * 于是"渲染后按 id 绑定处理函数"这类代码在不同测试里表现不同，
 * 一度把桩的缺陷误判成产品缺陷（也漏掉过真实缺陷）。
 *
 * 这里统一实现两件关键行为（真实浏览器如此，之前的手写桩没有）：
 *   1. innerHTML 赋值后，其中的元素立即可被 getElementById 找到
 *   2. 元素属性（value / checked / selected）会从 HTML 文本解析出来
 *
 * 用法:
 *   const { createDom } = require('./lib/dom');
 *   const dom = createDom();
 *   dom.document, dom.$('#id'), dom.mainHtml(), dom.navItems, dom.settle()
 */

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
  set innerHTML(v) {
    this._html = String(v);
    this._text = toText(this._html);
    // 模拟浏览器：innerHTML 里的元素立即可被 getElementById 找到
    if (this._onHtml) this._onHtml(this._html);
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this._html = String(v); }

  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() {}
  setAttribute(k, v) { this.attrs[k] = String(v); this.dataset[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener() {}
  focus() {} blur() {} setSelectionRange() {} scrollIntoView() {}
  getContext() { return new Proxy({}, { get: () => () => {} }); }
  closest() { return this; }

  click() {
    if (typeof this.onclick === 'function') {
      return this.onclick({ target: this, stopPropagation() {}, preventDefault() {}, closest: () => this });
    }
    return undefined;
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

function toText(html) {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function matches(el, sel) {
  const s = String(sel).trim();
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

/**
 * 创建一个独立的 DOM 环境。
 * 每次调用返回互不干扰的一套 document / registry。
 */
function createDom() {
  const map = new Map();
  const renderedIds = new Set();

  /** 从 HTML 文本里登记元素，并按属性初始化。 */
  function scanIds(html) {
    const s = String(html);
    const re = /<([a-zA-Z]+)([^>]*\bid="([\w-]+)"[^>]*)>/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const tag = m[1].toLowerCase();
      const attrs = m[2];
      const id = m[3];
      renderedIds.add(id);

      let el = map.get(id);
      if (!el) {
        el = new El(tag, id);
        map.set(id, el);
      }
      // 让它的 innerHTML 赋值也能登记新元素（嵌套渲染）
      el._onHtml = scanIds;
      // 属性解析（真实浏览器行为）
      const val = attrs.match(/\bvalue="([^"]*)"/);
      if (val && el.value === '') el.value = decodeEntities(val[1]);
      if (/\bchecked\b/.test(attrs)) el.checked = true;
      if (/\bhidden\b/.test(attrs)) el.hidden = true;
      if (/\bdisabled\b/.test(attrs)) el.disabled = true;
      if (/<select\b/.test(m[0])) {
        const rest = s.slice(m.index + m[0].length);
        const end = rest.indexOf('</select>');
        const body = end >= 0 ? rest.slice(0, end) : '';
        const sel = body.match(/<option[^>]*\bvalue="([^"]*)"[^>]*\bselected\b/);
        if (sel) el.value = sel[1];
      }
    }
  }

  const navItems = ['radar', 'latency', 'events', 'help', 'settings'].map((v) => {
    const el = new El('button');
    el.dataset.view = v;
    el._classes.add('nav-item');
    return el;
  });

  const document = {
    body: new El('body'),
    getElementById(id) {
      // 与浏览器一致：静态 HTML 元素始终存在，这里按需创建
      if (!map.has(id)) map.set(id, new El('div', id));
      return map.get(id);
    },
    querySelectorAll(sel) {
      if (sel === '.nav-item') return navItems;
      const out = [];
      for (const el of map.values()) if (matches(el, sel)) out.push(el);
      return out;
    },
    createElement: (t) => new El(t),
    addEventListener(ev, fn) {
      if (ev === 'keydown') keyHandlers.push(fn);
    },
    documentElement: new El('html'),
  };

  const keyHandlers = [];

  return {
    document,
    navItems,
    registry: map,
    renderedIds,
    scanIds,
    $: (id) => document.getElementById(id),
    mainHtml: () => document.getElementById('mainBody').innerHTML,
    keydown: (ev) => keyHandlers.forEach((fn) => fn(ev)),
    /** 初始化：把静态 HTML 的属性（含 hidden）灌进来 */
    initFromFile(file) {
      const fs = require('fs');
      scanIds(fs.readFileSync(file, 'utf8'));
    },
    /** 等待 Promise 链跑完 */
    async settle(times) {
      for (let i = 0; i < (times || 10); i++) await new Promise((r) => setImmediate(r));
    },
  };
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

module.exports = { createDom, El, matches };
