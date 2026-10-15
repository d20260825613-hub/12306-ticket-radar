'use strict';

/**
 * 界面文件缺失时的恢复行为测试。
 *
 * 场景：程序运行期间，它的安装目录被删除或移动。
 *   - API 全在内存里，仍然响应
 *   - 静态文件每次从磁盘读，于是全部 404
 * 期望：不要返回裸 "not found"，而是可读的恢复指引（HTTP 503 + 说明页）。
 *
 * 这个场景真实发生过：重新构建安装目录会让正在运行的实例页面全 404。
 *
 * 做法：把 src 复制到临时安装目录，再让 web 成为指向临时 web 的 junction，
 * 这样就可以在服务运行期间把 web 目录删掉再恢复，而不动项目本身。
 *
 * 用法: node tools/test_missing_web.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 40000 + Math.floor(Math.random() * 10000);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-web-'));
const stageSrc = path.join(stage, 'src');
const stageWebTarget = path.join(stage, 'web-real'); // 真正的 web 内容放这里
const webLink = path.join(stage, 'web'); // 安装目录里的 web（可随时摘除）
const dataDir = path.join(stage, 'data');

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

function get(p, method) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: p, method: method || 'GET', timeout: 8000 },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
      }
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
    req.end();
  });
}

function json(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function makeWebDir(marker) {
  fs.mkdirSync(stageWebTarget, { recursive: true });
  for (const f of ['index.html', 'app.js', 'styles.css']) {
    fs.writeFileSync(path.join(stageWebTarget, f), `<!-- ${f} ${marker} -->`, 'utf8');
  }
}

function removeWebDir() {
  try {
    fs.rmSync(stageWebTarget, { recursive: true, force: true });
  } catch { /* ignore */ }
}

(async () => {
  // 1. 复制 src，使 server.js 的 __dirname 落在临时安装目录里
  fs.cpSync(path.join(ROOT, 'src'), stageSrc, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  // 站点表随包分发，复制过来避免首次运行去下载
  fs.copyFileSync(path.join(ROOT, 'data', 'station_name.js'), path.join(dataDir, 'station_name.js'));

  // 2. 准备 web 内容，并把它链接成安装目录里的 web
  makeWebDir('ORIGINAL');
  let linkOk = true;
  try {
    fs.symlinkSync(stageWebTarget, webLink, 'junction');
  } catch (e) {
    linkOk = false;
    console.log('无法建立 junction，跳过该测试: ' + e.message);
    process.exit(0);
  }

  const child = spawn(NODE, [path.join(stageSrc, 'server.js')], {
    cwd: stage,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      NO_OPEN: '1',
      TICKET_RADAR_DATA: dataDir,
    }),
    stdio: 'ignore',
  });

  let exitedEarly = null;
  child.on('exit', (code) => {
    exitedEarly = code;
  });

  await new Promise((r) => setTimeout(r, 1500));
  if (exitedEarly !== null) {
    console.log(`服务提前退出（code ${exitedEarly}），无法测试`);
    process.exit(1);
  }

  console.log('\n【界面文件存在时】');
  const okRoot = await get('/');
  check('GET / 返回 200', okRoot.status === 200, 'HTTP ' + okRoot.status + ' ' + (okRoot.error || ''));
  check('返回的是本次的 stub 内容', /ORIGINAL/.test(okRoot.body), okRoot.body.slice(0, 50));

  const s1 = json((await get('/api/state')).body);
  check('/api/state 报告 web.ok 为 true', !!(s1 && s1.web && s1.web.ok === true), s1 ? JSON.stringify(s1.web) : 'no json');

  /* ══════════ 删除界面目录 ══════════ */

  console.log('\n【界面文件被删除后（模拟安装目录被删/移动）】');
  removeWebDir();

  const goneRoot = await get('/');
  check('GET / 不再返回裸 404', goneRoot.status !== 404, 'HTTP ' + goneRoot.status);
  check('返回 503 语义', goneRoot.status === 503, 'HTTP ' + goneRoot.status);
  check('返回 HTML 说明页', /<html/i.test(goneRoot.body));
  check('解释原因是目录被删除或移动', /目录已被删除或移动|安装目录/.test(goneRoot.body));
  check('给出可操作的恢复步骤', /重新双击|关闭/.test(goneRoot.body));
  check('提到重启才会加载新版代码', /重启|重新双击/.test(goneRoot.body));
  check('不再只是 "not found"', goneRoot.body.trim() !== 'not found');

  const cssGone = await get('/styles.css');
  check('其它静态路径同样给说明页', cssGone.status === 503, 'HTTP ' + cssGone.status);

  const s2 = json((await get('/api/state')).body);
  check('API 仍然可用（内存中）', !!(s2 && s2.stationCount), 'no json');
  check('/api/state 报告 web.ok 为 false', !!(s2 && s2.web && s2.web.ok === false), s2 ? JSON.stringify(s2.web) : 'no json');

  /* ══════════ 恢复界面目录 ══════════ */

  console.log('\n【界面文件恢复后】');
  makeWebDir('RESTORED');

  const backRoot = await get('/');
  check('无需重启即可恢复 200', backRoot.status === 200, 'HTTP ' + backRoot.status);
  check('返回的是恢复后的内容', /RESTORED/.test(backRoot.body), backRoot.body.slice(0, 50));

  const s3 = json((await get('/api/state')).body);
  check('/api/state 的 web.ok 恢复为 true', !!(s3 && s3.web && s3.web.ok === true), s3 ? JSON.stringify(s3.web) : 'no json');
  check('/api/state 带版本号', !!(s3 && s3.version), s3 ? String(s3.version) : 'no json');

  /* ══════════ 网页端停止程序 ══════════ */

  console.log('\n【网页端「停止程序」】');
  const sd = await get('/api/shutdown', 'POST');
  const sdB = sd.body ? json(sd.body) : null;
  check('停止接口返回 ok', !!(sdB && sdB.ok === true), String(sd.body || sd.error).slice(0, 120));

  let down = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const probe = await get('/api/state');
    if (probe.error) {
      down = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  check('调用后服务确实停止响应', down, down ? '' : '服务仍在响应');

  let exited = false;
  const exitDeadline = Date.now() + 6000;
  while (Date.now() < exitDeadline) {
    if (child.exitCode !== null) {
      exited = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  check('服务进程已结束', exited, exited ? '' : '进程仍存活');

  try {
    if (child.exitCode === null) child.kill();
  } catch { /* ignore */ }

  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(stage, { recursive: true, force: true });
  } catch { /* ignore */ }

  console.log('\n══════════════════════════════');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常:', e);
  try {
    fs.rmSync(stage, { recursive: true, force: true });
  } catch { /* ignore */ }
  process.exit(1);
});
