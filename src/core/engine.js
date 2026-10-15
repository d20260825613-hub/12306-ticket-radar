'use strict';

/**
 * 采集引擎：定时探测时延 + 查询余票 + 变化检测 + 推送。
 *
 * 频率策略（刻意的保守设计）：
 *   - 常态 60s 一次；整点放票窗口(8:00-18:00 的每小时前 3 分钟)提速到 20s
 *   - 余票库本身不是实时推送，秒级轮询不提升中票率，只会提高被风控的概率
 */

const EventEmitter = require('events');
const client = require('./client');
const stations = require('./stations');
const state = require('./state');
const providers = require('./providers');
const wechat = require('../notify/wechat');

function todayPlus(days) {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class Engine extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    /** 定时器代号：stop() 递增，用于作废在途的 tick，避免旧定时器续期 */
    this.timerGen = 0;
    this.running = false;
    this.session = null;
    this.sessionAt = 0;
    /** 上次采集到的诊断信息，供 UI 展示"为什么没数据" */
    this.diagnostics = {
      lastRunAt: null,
      lastOkAt: null,
      lastError: null,
      queryEndpoint: null,
      blocked: false,
      cycles: 0,
      consecutiveFailures: 0,
      /** 当前使用的数据源名 */
      dataSource: null,
      dataSourceReason: '',
    };
  }

  /** 会话复用：JSESSIONID 有效期内不必反复 init。 */
  async ensureSession() {
    const age = Date.now() - this.sessionAt;
    if (this.session && this.session.cookie && age < 5 * 60000) return this.session;
    const s = await client.openSession();
    if (s.cookie) {
      this.session = s;
      this.sessionAt = Date.now();
    }
    return s;
  }

  /** 一次时延探测：只打静态资源，不消耗查询额度，也最不容易被拦。 */
  async probeLatency() {
    const res = await client.probeLatency();
    const sample = {
      ts: Date.now(),
      kind: 'static',
      ok: !!res.ok,
      ttfb: res.timing ? res.timing.ttfb : null,
      tls: res.timing ? res.timing.tls : null,
      tcp: res.timing ? res.timing.tcp : null,
      total: res.timing ? res.timing.total : null,
      error: res.error || null,
    };
    state.recordLatency(sample);
    this.emit('latency', sample);
    return sample;
  }

  /**
   * 记录一次查询的时延采样。
   * 第三方数据源的耗时同样计入 —— 它决定了"多久能看到余票"。
   */
  recordQueryLatency({ ok, error, timing, source }) {
    const sample = {
      ts: Date.now(),
      kind: 'query',
      ok: !!ok,
      source: source || null,
      ttfb: timing ? timing.ttfb : null,
      tls: timing ? timing.tls : null,
      tcp: timing ? timing.tcp : null,
      total: timing ? timing.total : null,
      error: error || null,
    };
    state.recordLatency(sample);
    this.emit('latency', sample);
    return sample;
  }

  /** 查询一个监控目标。 */
  async queryRoute(route) {
    const from = stations.resolve(route.from);
    const to = stations.resolve(route.to);
    if (!from || !to) {
      return { ok: false, error: `站点无法解析: ${route.from} / ${route.to}` };
    }

    const date = route.date || todayPlus(route.dateOffset == null ? 7 : route.dateOffset);
    const cfg = state.getConfig();

    // 选数据源：优先直连，不可用时自动退到第三方
    const choice = providers.pick(cfg.dataSource);
    this.diagnostics.dataSource = choice.provider ? choice.provider.name : null;
    this.diagnostics.dataSourceReason = choice.reason;

    if (!choice.provider) {
      const msg = choice.reason;
      this.recordQueryLatency({ ok: false, error: msg });
      return { ok: false, configured: false, from, to, date, error: msg, elapsedMs: 0 };
    }

    const started = Date.now();
    let res = await choice.provider.fetchTickets({
      date,
      from: from.name,
      to: to.name,
      fromCode: from.code,
      toCode: to.code,
      cfg: cfg.dataSource,
      session: choice.provider.name === 'direct' ? await this.ensureSession() : null,
    });

    // 直连失败且允许降级 → 换第三方再试一次
    if (!res.ok && choice.provider.name === 'direct' && cfg.dataSource.fallbackToApihz && providers.get('apihz').ready(cfg.dataSource)) {
      const alt = providers.get('apihz');
      const retry = await alt.fetchTickets({
        date,
        from: from.name,
        to: to.name,
        cfg: cfg.dataSource,
      });
      if (retry.ok) {
        res = retry;
        this.diagnostics.dataSource = 'apihz';
        this.diagnostics.dataSourceReason = '直连失败，已自动改用第三方数据源';
      }
    }

    this.recordQueryLatency({
      ok: !!res.ok,
      error: res.error || null,
      timing: res.timing,
      source: res.source || choice.provider.name,
    });

    if (!res.ok) {
      const blocked = /error\.html|风控|端点轮换超过上限|HTTP 302/.test(res.error || '');
      return {
        ok: false,
        blocked,
        from,
        to,
        date,
        source: choice.provider.name,
        error: res.error,
        elapsedMs: Date.now() - started,
      };
    }

    const rows = res.rows;

    // 变化检测
    const key = state.routeKey(Object.assign({}, route, { date }));
    const prev = state.getState().snapshots[key];
    const prevRows = prev ? prev.rows : [];

    let events = [];
    if (prev) {
      // seenTrains 取自已提醒过的历史事件，避免首次采集把每趟可购车次都当成"新增"
      const seen = state.seenTrainsFrom(state.getState().events);
      events = state.diffSnapshot(prevRows, rows, route.seats, seen);
      events = state.dedupe(events, state.getState().events, state.getConfig().dedupeWindowMin);
    }

    const stamped = events.length
      ? state.addEvents(events, { route: `${from.name}→${to.name}`, date })
      : [];

    state.getState().snapshots[key] = {
      ts: Date.now(),
      from: from.name,
      to: to.name,
      date,
      source: res.source || choice.provider.name,
      endpoint: res.endpoint,
      // 快照只留变化检测需要的字段，避免状态文件膨胀。
      // 带上到达时刻与历时，事件文案才能给出完整的"06:30→11:24"。
      rows: rows.map((r) => ({
        code: r.code,
        seats: r.seats,
        departTime: r.departTime,
        arriveTime: r.arriveTime,
        duration: r.duration,
      })),
    };

    return {
      ok: true,
      from,
      to,
      date,
      source: res.source || choice.provider.name,
      endpoint: res.endpoint,
      rows,
      events: stamped,
      elapsedMs: Date.now() - started,
      timing: res.timing,
    };
  }

  /** 轮询一次全部目标。 */
  async runCycle() {
    if (this.running) return { skipped: true };
    this.running = true;
    const results = [];

    try {
      await this.probeLatency();

      const cfg = state.getConfig();
      for (const route of cfg.routes || []) {
        try {
          const r = await this.queryRoute(route);
          results.push(r);

          if (r.ok) {
            this.diagnostics.lastOkAt = Date.now();
            this.diagnostics.queryEndpoint = r.endpoint;
            this.diagnostics.blocked = false;
            this.diagnostics.consecutiveFailures = 0;
          } else {
            this.diagnostics.blocked = !!r.blocked;
            this.diagnostics.consecutiveFailures++;
          }
          this.diagnostics.lastError = r.ok ? null : r.error;
          this.emit('route', r);

          // 事件推送（静默时段只记录不打扰）
          if (r.ok && r.events && r.events.length) {
            if (state.isQuietNow()) {
              this.emit('notify-skipped', { reason: '静默时段', events: r.events });
            } else {
              const content = [
                wechat.renderEvents(r.events),
                '',
                '---',
                wechat.renderTicketTable({ from: r.from.name, to: r.to.name, date: r.date }, r.rows),
                '',
                '> 请打开 12306 官方 App/网站自行下单。',
              ].join('\n');
              const sent = await wechat.send(cfg.wechat, {
                title: `🚄 ${r.from.name}→${r.to.name} 有票了`,
                content,
              });
              this.emit('notify', Object.assign({ events: r.events }, sent));
            }
          }
        } catch (e) {
          this.diagnostics.lastError = e.message;
          this.diagnostics.consecutiveFailures++;
          results.push({ ok: false, error: e.message, route });
          this.emit('route', { ok: false, error: e.message, route });
        }
      }

      state.saveState();
      this.diagnostics.lastRunAt = Date.now();
      this.diagnostics.cycles++;
      this.emit('cycle', { results, diagnostics: this.diagnostics });
      return { results, diagnostics: this.diagnostics };
    } finally {
      this.running = false;
    }
  }

  /**
   * 启动轮询。
   * @param {boolean} immediate true=立刻跑一轮；false=只排下一次
   *
   * 区分这两者很重要：改配置只需重排下一次采集，
   * 若也立刻跑一轮，用户每调一次设置就多打一次 12306。
   */
  start(immediate) {
    this.stop();
    const gen = ++this.timerGen;
    const tick = async () => {
      if (gen !== this.timerGen) return; // 已被 stop/start 取代，不再续期
      try {
        await this.runCycle();
      } catch (e) {
        console.error('[engine] 轮询异常:', e.message);
      }
      if (gen === this.timerGen && this.timer) {
        this.timer = setTimeout(tick, state.currentIntervalSec() * 1000);
      }
    };
    this.timer = setTimeout(tick, immediate ? 0 : state.currentIntervalSec() * 1000);
    console.log(
      `[engine] 已启动，间隔 ${state.currentIntervalSec()}s` + (immediate ? '（立即采集一次）' : '')
    );
  }

  stop() {
    this.timerGen++; // 使在途/待执行的 tick 失效，避免旧定时器续期
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 线路变化后按新间隔重启，并立刻采集一次。 */
  restart() {
    this.start(true);
  }

  /** 仅重排下一次采集（改频率/推送设置时用，不额外打 12306）。 */
  reschedule() {
    this.start(false);
  }
}

module.exports = { Engine, todayPlus };
