'use strict';

/**
 * 渲染冒烟测试：在 Node 里用最小 DOM stub 加载真实 web/app.js，
 * 喂入构造的余票数据，验证各视图渲染不抛错、产出预期的 DOM 结构。
 *
 * 为什么需要它：12306 拦截了余票查询，真实数据路径在界面上看不到，
 * 而表格/筛选/排序这些代码恰恰只在"有余票数据"时才执行。
 *
 * 注意：本文件含中文，务必用 UTF-8 保存。不要用 Windows PowerShell 5.1
 * 的 Get-Content/Set-Content 改写它（会按 ANSI 读写导致中文损坏）。
 *
 * 用法: node tools/smoke_ui.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = path.join(__dirname, '..', 'web', 'app.js');

/* ─────────────── 最小 DOM ─────────────── */

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
  set innerHTML(v) { this._html = String(v); this._text = stripTags(this._html); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this._html = escapeHtml(this._text); }

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
  closest() { return null; }
  getContext() { return new Proxy({}, { get: () => () => {} }); }

  click() {
    if (typeof this.onclick === 'function') {
      this.onclick({ target: this, stopPropagation() {}, preventDefault() {} });
    }
  }

  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function matches(el, sel) {
  const s = sel.trim();
  if (s.startsWith('#')) return el.id === s.slice(1);
  if (s.startsWith('.')) return el._classes.has(s.slice(1));
  if (s.startsWith('[')) {
    const m = s.match(/^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/);
    if (!m) return false;
    const key = m[1].replace(/^data-/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
    return m[2] === undefined
      ? el.dataset[key] !== undefined
      : String(el.dataset[key]) === m[2];
  }
  return el.tagName === s.toUpperCase();
}

const registry = new Map();
const navItems = ['radar', 'latency', 'events', 'settings'].map((v) => {
  const el = new El('button');
  el.dataset.view = v;
  el._classes.add('nav-item');
  return el;
});

const documentStub = {
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
  addEventListener: () => {},
  documentElement: new El('html'),
};

/* ─────────────── mock 数据 ─────────────── */

const A = (n) => ({ state: 'available', count: n, text: n == null ? '有' : '有(' + n + ')' });
const N = () => ({ state: 'none', count: 0, text: '无' });
const W = () => ({ state: 'waitlist', count: null, text: '候补' });
const U = () => ({ state: 'unknown', count: null, text: '' });

/** 全部席位都置为 unknown，便于只覆盖关心的那几个。 */
function blankSeats() {
  return {
    business: U(), first: U(), second: U(), topGrade: U(), softSleeper: U(),
    deluxeSleeper: U(), hardSleeper: U(), softSeat: U(), hardSeat: U(),
    noSeat: U(), preferredFirst: U(),
  };
}

function mkRow(code, dep, arr, dur, seats) {
  return {
    trainNo: '24000' + code, code, type: code[0],
    fromCode: 'VNP', toCode: 'AOH',
    fromName: '北京南', toName: '上海虹桥',
    boardCode: 'VNP', boardName: '北京南', alightName: '上海虹桥',
    departTime: dep, arriveTime: arr, duration: dur, canBook: true, date: '2026-10-08',
    seats: Object.assign(
      {
        business: U(), first: U(), second: U(), topGrade: U(), softSleeper: U(),
        deluxeSleeper: U(), hardSleeper: U(), softSeat: U(), hardSeat: U(),
        noSeat: U(), preferredFirst: U(),
      },
      seats
    ),
  };
}

const rows = [
  mkRow('G1', '06:30', '11:24', '04:54', { business: A(3), first: A(12), second: A() }),
  mkRow('G3', '06:52', '11:33', '04:41', { business: N(), first: N(), second: W() }),
  mkRow('G531', '06:08', '12:04', '05:56', { business: N(), first: N(), second: A(28) }),
  mkRow('G5', '07:40', '12:32', '04:52', { business: A(1), first: N(), second: A(46), noSeat: A() }),
  mkRow('G7', '08:00', '12:38', '04:38', { business: N(), first: A(5), second: A(7) }),
  mkRow('D311', '19:34', '07:12', '11:38', { softSleeper: A(4), deluxeSleeper: A(2), second: N() }),
  mkRow('Z281', '19:10', '09:22', '14:12', { softSleeper: A(2), hardSleeper: A(18), hardSeat: A(60) }),
];

const now = Date.now();
const appState = {
  config: {
    routes: [{ from: '北京南', to: '上海虹桥', dateOffset: 45, seats: ['second', 'first', 'business'] }],
    intervalSec: 60, rushIntervalSec: 20, dedupeWindowMin: 10,
    quietHours: { start: 23, end: 6 },
    wechat: { enabled: false, channel: 'pushplus', token: '' },
  },
  stationCount: 3384,
  diagnostics: {
    lastRunAt: now - 30000, lastOkAt: now - 30000, lastError: null,
    queryEndpoint: 'queryG', blocked: false, cycles: 5, consecutiveFailures: 0,
  },
  latency: Array.from({ length: 40 }, (_, i) => ({
    ts: now - (39 - i) * 60000,
    kind: i % 3 === 0 ? 'query' : 'static',
    ok: true, dns: 18, tcp: 31, tls: 64,
    ttfb: 100 + ((i * 11) % 60), total: 300, error: null,
  })),
  events: [
    {
      ts: now - 60000, kind: 'becameAvailable', trainCode: 'G531', seatKey: 'second',
      seatName: '二等座', text: 'G531 06:08开 二等座 无票 -> 有(28)',
      route: '北京南 -> 上海虹桥', date: '2026-10-08', read: false,
    },
  ],
  unread: 1,
  routes: [{
    raw: { from: '北京南', to: '上海虹桥', dateOffset: 45, seats: ['second', 'first', 'business'] },
    from: '北京南', to: '上海虹桥', fromCode: 'VNP', toCode: 'AOH',
    date: '2026-10-08', rows, updatedAt: now - 30000, endpoint: 'queryG',
  }],
  quietNow: false, rushNow: false, intervalSec: 60, serverTime: now,
};

/* ─────────────── 沙箱 ─────────────── */

const sandbox = {
  document: documentStub,
  window: { devicePixelRatio: 1, open: () => {}, matchMedia: () => ({ matches: false }) },
  fetch: async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/api/state') ? appState : { ok: true }),
  }),
  EventSource: class { constructor() {} addEventListener() {} },
  requestAnimationFrame: (fn) => fn(),
  setTimeout: (fn) => 0,
  setInterval: () => 0,
  clearTimeout: () => {},
  console,
  confirm: () => true,
  getComputedStyle: () => ({ getPropertyValue: () => '#07c160' }),
};
sandbox.globalThis = sandbox;

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ok   ' + label);
  else {
    console.log('  FAIL ' + label + (detail ? '  -> ' + detail : ''));
    failures++;
  }
}

const run = (expr) => vm.runInContext(expr, sandbox);
const mainHtml = () => documentStub.getElementById('mainBody').innerHTML;

/**
 * 承诺式措辞检测。
 *
 * 要抓的是"把不可实现的能力说成卖点"，同时必须放行两类正确表述：
 *   1. 被否定的能力边界："不自动下单"、"不会自动下单"
 *   2. 拆穿行业话术："所谓'加速包'在技术上不成立"
 * 所以不只看紧邻字符，还回看一小段里有没有否定/质疑语气。
 */
const PROMISE_WORDS = /自动(抢票|下单|支付|购票)|加速包|保证有票|百分百有票|包抢到/;
const DEBUNK = /[不无非别没]|所谓|并不|根本|不存在|不成立|假的|忽悠/;

function hasPromiseWords(html) {
  const text = String(html);
  const re = new RegExp(PROMISE_WORDS.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    // 回看这一段（含句子开头方向约 24 字），有否定/质疑语气就放行
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    if (!DEBUNK.test(before)) return true;
  }
  return false;
}

/* ─────────────── 执行 ─────────────── */

try {
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), sandbox, { filename: 'app.js' });
  console.log('app.js 加载成功\n');
} catch (e) {
  console.error('app.js 加载失败:', e.message);
  process.exit(1);
}

setTimeout(() => {
  /**
   * 把线路夹具替换成"关注全部席位"的一条，便于验证各席位状态的渲染。
   *
   * 默认夹具的 raw.seats 只含 second/first/business ——
   * 那样无座等席位不会参与渲染，断言会失真（曾因此误判为渲染 bug）。
   */
  function useRouteWith(rows, seats) {
    const route = {
      raw: { from: '北京南', to: '上海虹桥', dateOffset: 14, seats },
      from: '北京南', to: '上海虹桥', fromCode: 'VNP', toCode: 'AOH',
      date: '2026-10-08', rows, updatedAt: Date.now(), endpoint: 'apihz',
    };
    run('S.data.routes=' + JSON.stringify([route]));
  }

  /** 造一条只覆盖指定席位的车次行。 */
  function rowWithSeats(code, overrides) {
    return {
      trainNo: 't-' + code, code, type: code[0],
      fromCode: 'VNP', toCode: 'AOH',
      fromName: '北京南', toName: '上海虹桥',
      boardCode: 'VNP', boardName: '北京南', alightName: '上海虹桥',
      departTime: '08:00', arriveTime: '12:30', duration: '04:30',
      canBook: true, date: '2026-10-08',
      seats: Object.assign(blankSeats(), overrides),
    };
  }

  console.log('【余票雷达视图】');
  let html = mainHtml();

  check('渲染出余票表格', html.includes('<table class="grid"'), 'len=' + html.length);
  check('包含车次 G1', html.includes('G1'));
  check('包含车次 Z281', html.includes('Z281'));
  check('有可购席位的行标绿底', html.includes('class="hit"'));
  check('可购席位渲染为 available', html.includes('seat available'));
  check('无票席位渲染为 none', html.includes('seat none'));
  check('候补席位渲染为 waitlist', html.includes('seat waitlist'));
  check('生成了去下单链接', html.includes('kyfw.12306.cn/otn/leftTicket/init'));
  check('链接带车站电报码', html.includes('VNP') && html.includes('AOH'));
  check('逗号未被误编码为 %2C', !html.includes('%2C'));
  check('链接带日期', html.includes('2026-10-08'));
  check('有筛选工具栏', html.includes('id="fQ"') && html.includes('id="fAvail"'));
  check('车型下拉包含 D 字头', html.includes('value="D"'));
  check('标题正确', documentStub.getElementById('mainTitle').textContent === '北京南 → 上海虹桥');
  check('副标题含车次数', documentStub.getElementById('mainSub').textContent.includes('7 趟车次'));
  const trCount = (html.match(/<tr /g) || []).length;
  check('表格行数覆盖全部车次', trCount >= rows.length, 'tr=' + trCount + ' rows=' + rows.length);

  console.log('\n【延迟视图】');
  run("S.view='latency'");
  try {
    run('render()');
    html = mainHtml();
    check('渲染出统计卡', html.includes('静态资源 TTFB'));
    check('渲染出趋势图 canvas', html.includes('id="chart"'));
    check('渲染出请求分解', html.includes('DNS 解析') && html.includes('TLS 握手'));
    check('渲染出说明文字', html.includes('不影响你能否抢到票'));
  } catch (e) {
    check('延迟视图渲染', false, e.message);
  }

  console.log('\n【提醒记录视图】');
  run("S.view='events'");
  try {
    run('render()');
    html = mainHtml();
    check('渲染出消息气泡', html.includes('msg-bubble'));
    check('显示车次与席位', html.includes('G531') && html.includes('二等座'));
    check('有日期分隔', html.includes('day-sep'));
  } catch (e) {
    check('提醒记录渲染', false, e.message);
  }

  console.log('\n【设置视图】');
  run("S.view='settings'");
  try {
    run('render()');
    html = mainHtml();
    check('渲染出推送配置', html.includes('id="wxToken"') && html.includes('id="wxChannel"'));
    check('渲染出频率配置', html.includes('id="cfgInterval"') && html.includes('id="cfgDedupe"'));
    check('渲染出静默时段', html.includes('id="cfgQuietS"'));
    check('声明了能力边界', html.includes('不会做'));
  } catch (e) {
    check('设置视图渲染', false, e.message);
  }

  console.log('\n【筛选与排序】');
  run("S.view='radar'");
  run("S.filters={q:'G1',onlyAvail:false,sort:'depart',type:'all'}");
  try {
    run('render()');
    html = mainHtml();
    check('筛选词生效：保留 G1', html.includes('>G1<'));
    check('筛选词生效：排除 Z281', !html.includes('Z281'));
  } catch (e) {
    check('筛选渲染', false, e.message);
  }

  run("S.filters={q:'',onlyAvail:true,sort:'seats',type:'all'}");
  try {
    run('render()');
    html = mainHtml();
    check('只看有票：保留有票车次 G1', html.includes('G1'));
    check('只看有票：剔除全无票车次 G3', !html.includes('>G3<'));
  } catch (e) {
    check('只看有票渲染', false, e.message);
  }

  console.log('\n【未接入数据源时的引导】');
  run("S.filters={q:'',onlyAvail:false,sort:'depart',type:'all'}");
  run("S.data.dataSource={providers:[],active:null,reason:'直连 12306 不可用，且第三方数据源未配置（请在设置里填写 id/key）',anyReady:false}");
  run("S.data.diagnostics={lastError:null,blocked:false,consecutiveFailures:0}");
  try {
    run('render()');
    html = mainHtml();
    check('首屏引导去配置数据源', html.includes('还差一步就能看到余票'));
    check('给出注册地址', html.includes('apihz.cn'));
    check('说明免费额度', html.includes('10 次/分钟'));
    check('给出配置按钮', html.includes('btnGoDs'));
    check('不出现承诺式措辞', !hasPromiseWords(html));
  } catch (e) {
    check('数据源引导渲染', false, e.message);
  }

  console.log('\n【已接入数据源但采集失败】');
  run("S.data.dataSource={providers:[],active:'apihz',reason:'按配置使用第三方数据源',anyReady:true}");
  run("S.data.diagnostics={lastError:'调用频次过快，请26秒后再试',blocked:false,consecutiveFailures:1}");
  try {
    run('render()');
    html = mainHtml();
    check('说明失败原因且可折叠详情', html.includes('上次采集没成功') && html.includes('错误详情'));
    check('不出现承诺式措辞', !hasPromiseWords(html));
  } catch (e) {
    check('采集失败渲染', false, e.message);
  }

  console.log('\n【已接入且正常】');
  run("S.data.diagnostics={lastError:null,blocked:false,consecutiveFailures:0,lastOkAt:Date.now()}");
  run("S.data.config.wechat={enabled:false,channel:'pushplus',token:''}");
  try {
    run('render()');
    html = mainHtml();
    check('正常时提示可配微信提醒', html.includes('微信提醒') || html.includes('btnGoWx'));
  } catch (e) {
    check('正常态渲染', false, e.message);
  }
  run("S.data.config.wechat={enabled:true,channel:'pushplus',token:'x'}");

  console.log('\n【剩余票数量显示】');
  // 三种情况必须能区分：具体数量 / 有票但未公布 / 无票
  run("S.view='radar'");
  useRouteWith(
    [rowWithSeats('G100', {
      second: { state: 'available', count: 12, text: '有(12)' },
      first: { state: 'available', count: 3, text: '有(3)' },
      business: { state: 'available', count: null, text: '有' },
      noSeat: { state: 'none', count: 0, text: '无' },
    })],
    ['second', 'first', 'business', 'noSeat']
  );
  try {
    run('render()');
    html = mainHtml();

    check('有具体数量的席位显示数字', /<span class="num">12<\/span>/.test(html), '未找到 num=12');
    check('另一个具体数量也显示', /<span class="num">3<\/span>/.test(html));
    check('数字紧跟席位名（12 二等）', /<span class="num">12<\/span><span class="sn">二等<\/span>/.test(html),
      '期望顺序：数字在前、席位名在后');
    check('数量未知时写明"数量未公布"', html.includes('数量未公布'));
    check('数量未知的席位带 noqty 标记', html.includes('seat available noqty'));
    check('无票席位渲染为 seat none', html.includes('class="seat none"'));
    check('无票与"数量未公布"是不同 class',
      html.includes('class="seat none"') && html.includes('seat available noqty'));
    check('顶部给出统计摘要', html.includes('个席位有确切余票数量'));
    check('摘要解释了"数量未公布"不等于没票', /不代表没票|不等于没票|只是不知道剩几张/.test(html));

    // 排序只看表格内部：摘要里也有"数量未公布"字样，不能拿整页位置比较
    const tbodyHtml = (html.match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '';
    const numPos = tbodyHtml.indexOf('<span class="num">12</span>');
    const noQtyPos = tbodyHtml.indexOf('noqty');
    check('表格内有确切数量的席位排在前面',
      numPos >= 0 && noQtyPos >= 0 && numPos < noQtyPos,
      'num@' + numPos + ' noqty@' + noQtyPos);
  } catch (e) {
    check('剩余票数量渲染', false, e.message);
  }

  console.log('\n【数量显示：边界】');
  useRouteWith(
    [rowWithSeats('K200', {
      second: { state: 'available', count: 1, text: '有(1)' },
      first: { state: 'none', count: 0, text: '无' },
      business: { state: 'unknown', count: null, text: '' },
      noSeat: { state: 'waitlist', count: null, text: '候补' },
    })],
    ['second', 'first', 'business', 'noSeat']
  );
  try {
    run('render()');
    html = mainHtml();
    check('余票 1 张正常显示', /<span class="num">1<\/span>/.test(html));
    check('count=0 归为无票而不是"0 张"',
      html.includes('class="seat none"') && !/<span class="num">0<\/span>/.test(html));
    check('unknown 席位不渲染', !html.includes('>商务<'), '商务座应为 unknown，不该出现');
    check('候补状态单独渲染', html.includes('seat waitlist') && html.includes('候补'));
  } catch (e) {
    check('边界渲染', false, e.message);
  }

  console.log('\n【统计摘要的计数正确性】');
  useRouteWith(
    [rowWithSeats('G300', {
      second: { state: 'available', count: 5, text: '有(5)' },
      first: { state: 'available', count: null, text: '有' },
      business: { state: 'none', count: 0, text: '无' },
    })],
    ['second', 'first', 'business']
  );
  try {
    run('render()');
    html = mainHtml();
    check('统计出 1 个确切数量席位', /<b>1<\/b> 个席位有确切余票数量/.test(html), '未匹配到 b=1');
    check('统计出 1 个仅"有票"席位', /1 个席位只显示/.test(html));
    check('无票席位不计入统计', !/2 个席位有确切/.test(html));
  } catch (e) {
    check('统计渲染', false, e.message);
  }

  console.log('\n【怎么抢到票】');
  run("S.view='help'");
  try {
    run('render()');
    html = mainHtml();
    check('说明第三方无优先级', html.includes('没有任何优先级'));
    check('第一条建议是官方候补', html.includes('候补购票'));
    check('给出放票时间点', html.includes('8:00'));
    check('给出分流思路', html.includes('多买一站') && html.includes('分段接驳'));
    check('提示只走官方渠道', html.includes('12306 官方 App'));
    check('声明能力边界', html.includes('不会做'));
    check('不出现承诺式措辞', !hasPromiseWords(html));
  } catch (e) {
    check('帮助页渲染', false, e.message);
  }

  console.log('\n【停止入口与可复制】');
  run("S.view='radar'");
  run("S.data.diagnostics={lastError:null,blocked:false}");
  try {
    run('render()');
    const actions = documentStub.getElementById('mainActions').innerHTML;
    check('主区提供「停止程序」入口', actions.includes('btnStop'));
    check('主区提供帮助入口', actions.includes('btnHelp'));
    check('车次号可点击复制', mainHtml().includes('class="copyable"'));
    check('复制按钮带 data-copy', mainHtml().includes('data-copy='));
    check('车次行带官方去下单链接', mainHtml().includes('class="book"'));
  } catch (e) {
    check('停止入口渲染', false, e.message);
  }

  console.log('\n【首次引导】');
  const savedRoutes = run('JSON.stringify(S.data.routes)');
  run('S.data.routes=[]');
  try {
    run('render()');
    html = mainHtml();
    check('无线路时显示引导卡', html.includes('onboard'));
    check('引导说明工具价值', /替你盯着余票|微信叫你/.test(html));
    check('引导里有添加入口', html.includes('btnOnboardAdd'));
  } catch (e) {
    check('引导渲染', false, e.message);
  }
  run(`S.data.routes=${savedRoutes}`);

  console.log('\n【空数据状态】');
  run("S.data.diagnostics={lastError:null,blocked:false}");
  run('S.data.routes[0].rows=null');
  try {
    run('render()');
    check('给出空状态提示', mainHtml().includes('还没有采集到数据'));
  } catch (e) {
    check('空状态渲染', false, e.message);
  }

  console.log('\n══════════════════════════════');
  if (failures === 0) {
    console.log('全部检查通过');
    process.exit(0);
  }
  console.log(failures + ' 项检查失败');
  process.exit(1);
}, 60);
