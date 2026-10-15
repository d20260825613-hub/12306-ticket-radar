'use strict';

/**
 * 只读数据目录下的健壮性测试。
 *
 * 场景：程序被放在不可写的位置（只读介质、受控文件夹权限、系统保护目录）。
 * 期望：服务照常启动并可查询，只是配置/状态无法持久化 ——
 *       绝不能因为一次 writeFileSync 失败就让整个进程崩掉。
 *
 * 用例通过子进程运行，因为 DATA_DIR 在模块加载时就固定了。
 *
 * 用法: node tools/test_readonly.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;

const PORT = 30000 + Math.floor(Math.random() * 10000);

/**
 * 找一个"存在但不可写"的目录。
 * 先试着在 Windows 目录下创建子目录 —— 受限的沙箱/标准用户会失败，
 * 这正是我们要模拟的条件。
 */
function findReadOnlyDir() {
  const candidates = [];
  if (process.env.SystemRoot) candidates.push(path.join(process.env.SystemRoot, 'radar-ro-test'));
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'radar-ro-test'));
  candidates.push(path.join(os.tmpdir(), 'radar-ro-test-' + Date.now()));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // 建得出来就写个小文件试试，能写说明不是只读
      fs.writeFileSync(path.join(dir, '.probe'), 'x');
      fs.unlinkSync(path.join(dir, '.probe'));
      fs.rmdirSync(dir);
      continue; // 可写，换下一个
    } catch {
      return dir; // 不可写 —— 正是需要的
    }
  }
  return null;
}

/**
 * 在指定数据目录下起服务，返回探测结果。
 *
 * 注意：不用 spawnSync 捕获 stdout。受限环境下 Node 的 child_process
 * 使用 stdio: 'pipe' 会 EPERM（命名管道被禁止）。改为让子进程把结果
 * 写入临时文件，父进程读文件。
 */
function runInDir(dataDir) {
  const outFile = path.join(os.tmpdir(), 'radar-ro-out-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  const script = `
    const fs = require('fs');
    const path = require('path');
    const http = require('http');

    const OUT = ${JSON.stringify(outFile)};
    process.env.TICKET_RADAR_DATA = ${JSON.stringify(dataDir)};
    process.env.PORT = ${JSON.stringify(String(PORT))};
    process.env.NO_OPEN = '1';

    // 收集所有输出，最后统一写文件
    const logs = [];
    const origLog = console.log, origWarn = console.warn, origErr = console.error;
    console.log = (...a) => { logs.push(a.join(' ')); };
    console.warn = (...a) => { logs.push(a.join(' ')); };
    console.error = (...a) => { logs.push(a.join(' ')); };

    let finished = false;
    function finish(out) {
      if (finished) return;
      finished = true;
      out.logs = logs.join('\\n');
      try { fs.writeFileSync(OUT, JSON.stringify(out), 'utf8'); } catch (e) { /* 写不了也没办法 */ }
      process.exit(0);
    }

    let crashed = null;
    process.on('uncaughtException', (e) => { crashed = e.message; finish({ crashed, httpOk: false }); });

    try {
      // 让 12306 客户端返回成功但空结果，避免真实网络请求
      const clientPath = require.resolve(${JSON.stringify(path.join(ROOT, 'src', 'core', 'client.js'))});
      require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: {
        openSession: async () => ({ cookie: 'x', timing: { ttfb: 1, tls: 1, tcp: 1, dns: 1, total: 2 } }),
        queryTickets: async () => ({ ok: true, endpoint: 'queryG', rows: [], map: {},
          timing: { ttfb: 100, tls: 60, tcp: 40, dns: 10, total: 150 }, status: 200 }),
        probeLatency: async () => ({ ok: true, status: 200, timing: { ttfb: 90, tls: 60, tcp: 35, dns: 12, total: 150 } }),
        httpGet: async () => ({ ok: false, error: 'stub' }),
        cookieHeaderFrom: () => '', KNOWN_ENDPOINTS: [], HOST: 'kyfw.12306.cn'
      }};

      const serverMod = require(${JSON.stringify(path.join(ROOT, 'src', 'server.js'))});
      serverMod.start();
      serverMod.engine.stop();
    } catch (e) {
      finish({ crashed: 'start() 抛出: ' + e.message, httpOk: false });
    }

    setTimeout(() => {
      const out = { crashed: null, httpOk: false, routes: null, writeResults: null };
      const req = http.get({ host: '127.0.0.1', port: ${PORT}, path: '/api/state' }, (resp) => {
        const c = [];
        resp.on('data', (d) => c.push(d));
        resp.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(c).toString('utf8'));
            out.httpOk = resp.statusCode === 200;
            out.routes = j.routes.length;
          } catch (e) { out.probeError = e.message; }

          const state = require(${JSON.stringify(path.join(ROOT, 'src', 'core', 'state.js'))});
          out.writeResults = { config: state.saveConfig(), state: state.saveState() };
          out.crashed = crashed;
          finish(out);
        });
      });
      req.on('error', (e) => { out.probeError = e.message; out.crashed = crashed; finish(out); });
      req.setTimeout(6000, () => { req.destroy(new Error('timeout')); });
    }, 900);
  `;

  const res = spawnSync(NODE, ['-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: ROOT,
    stdio: 'ignore', // 不捕获管道，结果走文件
  });

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch { /* 没写出来 */ }
  try { fs.unlinkSync(outFile); } catch { /* ignore */ }

  return { parsed, raw: parsed && parsed.logs ? parsed.logs : '(子进程未产生输出)', status: res.status };
}

/* ─────────────── 执行 ─────────────── */

const roDir = findReadOnlyDir();
console.log('\n只读目录: ' + (roDir || '(找不到不可写目录)'));

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

if (!roDir) {
  console.log('  跳过：本环境找不到不可写目录，无法构造该场景');
  process.exit(0);
}

const ro = runInDir(roDir);
if (!ro.parsed) {
  console.log('\n子进程未返回结构化结果，原始输出：');
  console.log(ro.raw.slice(0, 2500));
}

check('只读目录下服务仍能启动并响应 HTTP', !!(ro.parsed && ro.parsed.httpOk),
  ro.parsed ? 'httpOk=' + ro.parsed.httpOk : 'no result');
check('进程未因写入失败而崩溃', !!(ro.parsed && !ro.parsed.crashed),
  ro.parsed ? String(ro.parsed.crashed) : 'no result');
check('保存配置返回 false 而非抛异常',
  !!(ro.parsed && ro.parsed.writeResults && ro.parsed.writeResults.config === false),
  ro.parsed ? JSON.stringify(ro.parsed.writeResults) : 'no result');
check('保存状态返回 false 而非抛异常',
  !!(ro.parsed && ro.parsed.writeResults && ro.parsed.writeResults.state === false),
  ro.parsed ? JSON.stringify(ro.parsed.writeResults) : 'no result');
check('给出了可读的降级提示', /无法写入|只在内存中生效|不会持久化|只读模式/.test(ro.raw), ro.raw.slice(0, 400));

// 对照组：可写目录下必须返回 true
const rwDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-rw-'));
const rw = runInDir(rwDir);
check('可写目录下保存成功返回 true',
  !!(rw.parsed && rw.parsed.writeResults && rw.parsed.writeResults.config === true && rw.parsed.writeResults.state === true),
  rw.parsed ? JSON.stringify(rw.parsed.writeResults) : rw.raw.slice(0, 300));
check('可写目录下无写入告警', !/无法写入/.test(rw.raw));
try { fs.rmSync(rwDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('\n══════════════════════════════');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
