'use strict';

/**
 * 启动器进程生命周期测试。
 *
 * 验证的核心问题：关闭启动器窗口后，Node 服务是否真的被结束？
 *
 *   Windows 不会因为父进程结束而结束子进程。修复前，点窗口的 × 之后
 *   Node 仍在后台占着端口，导致下次启动看到"服务已在运行"、进程也清不掉。
 *   修复方式是 Job Object + JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE。
 *
 * 验证方法：启动 exe → 确认服务在跑 → 强杀启动器进程（模拟关窗口，
 * 不给它任何清理机会）→ 确认端口随即释放。
 *
 * 用法: node tools/test_launcher_lifecycle.js [安装目录]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INSTALL = process.argv[2] || path.join(ROOT, 'build', 'lifecycle-test');
const PORT = 41000 + Math.floor(Math.random() * 8000);

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 端口上是否有东西在监听。 */
function isListening() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', timeout: 1200 }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** 等待端口进入期望状态，返回是否达成。 */
async function waitFor(expectListening, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await isListening();
    if (now === expectListening) return true;
    await sleep(300);
  }
  return false;
}

/** 进程是否还活着。 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 结束启动器进程。
 *
 * 不用 taskkill：受限环境下它会返回 "Access denied" 且不结束目标进程，
 * 于是"子进程是否残留"的结论完全失真（曾经就被这个误导过）。
 * 直接用 child.kill()，并回报是否真的终止成功。
 */
function terminate(proc) {
  try {
    proc.kill();
  } catch { /* 可能已退出 */ }
  return proc.pid;
}

/** 等待进程真正消失。 */
async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(200);
  }
  return false;
}

(async () => {
  // 安装布局：<安装目录>\余票雷达\余票雷达.exe
  // 用码点构造名字，避免源文件编码问题
  const appName = String.fromCharCode(0x4f59, 0x7968, 0x96f7, 0x8fbe);
  const appDir = path.join(INSTALL, appName);
  const exe = path.join(appDir, appName + '.exe');

  console.log('\n安装目录: ' + appDir);
  console.log('测试端口: ' + PORT);
  console.log('启动器  : ' + exe);

  if (!fs.existsSync(exe)) {
    console.log('\n找不到启动器，跳过该测试。');
    console.log('请先构建：powershell -File tools\\build_exe.ps1 -InstallDir "' + INSTALL + '" -SkipShortcut');
    process.exit(0);
  }

  // 前置：端口必须是空闲的，否则结论不可信
  if (await isListening()) {
    console.log('\n端口 ' + PORT + ' 已被占用，无法进行测试。');
    process.exit(1);
  }

  console.log('\n【启动】');
  const env = Object.assign({}, process.env, { PORT: String(PORT) });
  // 把启动器输出写到文件，失败时能看清原因
  const logFile = path.join(os.tmpdir(), 'radar-launcher-' + Date.now() + '.log');
  const logStream = fs.openSync(logFile, 'w');

  const launcher = spawn(exe, [], {
    cwd: appDir,
    detached: true,
    stdio: ['ignore', logStream, logStream],
    windowsHide: true,
    env,
  });
  launcher.unref();

  const up = await waitFor(true, 25000);
  check('启动器能在 25 秒内拉起服务', up, 'port=' + PORT);
  if (!up) {
    terminate(launcher);
    await sleep(500);
    try { fs.closeSync(logStream); } catch { /* ignore */ }
    console.log('\n启动器输出（' + logFile + '）：');
    try {
      console.log(fs.readFileSync(logFile, 'utf8').slice(0, 2000));
    } catch {
      console.log('  (读不到输出)');
    }
    console.log('\n通过 ' + pass + ' / 失败 ' + fail);
    process.exit(1);
  }
  try { fs.closeSync(logStream); } catch { /* ignore */ }

  const launcherPid = launcher.pid;
  console.log('  启动器 pid = ' + launcherPid);

  console.log('\n【结束启动器进程（模拟关闭窗口）】');
  terminate(launcher);
  const launcherGone = await waitGone(launcherPid, 10000);
  check('启动器进程确实被终止（否则后续结论无意义）', launcherGone,
    launcherGone ? '' : '启动器仍然存活，无法验证子进程清理');

  const down = await waitFor(false, 15000);
  check('启动器结束后服务随之结束（Job Object 生效）', down,
    down ? '' : '端口 ' + PORT + ' 一直有人监听 —— 子进程成了孤儿');

  console.log('\n【再次启动，确认端口可复用】');
  if (!down) {
    check('端口可复用（前置失败，跳过）', false, '上一次未清理干净');
  } else {
    const l2 = spawn(exe, [], {
      cwd: appDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });
    l2.unref();

    const up2 = await waitFor(true, 25000);
    check('清理后可以重新启动', up2, 'port=' + PORT);

    if (up2) {
      console.log('\n【第二次结束】');
      terminate(l2);
      const gone2 = await waitGone(l2.pid, 10000);
      check('第二次启动器同样被终止', gone2, gone2 ? '' : '未终止');
      const down2 = await waitFor(false, 15000);
      check('第二次同样干净结束', down2, down2 ? '' : '仍有残留');
    }
  }

  console.log('\n══════════════════════════════');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
