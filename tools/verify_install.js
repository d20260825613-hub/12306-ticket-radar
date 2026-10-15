'use strict';

/**
 * 安装校验：检查项目配置与桌面安装目录是否完整可用。
 *
 * 用 Node 而不是 PowerShell 来读 JSON —— Windows PowerShell 5.1 会按 ANSI
 * 读取 UTF-8 文件，中文会显示成乱码，容易被误判为"文件损坏"。
 *
 * 用法: node tools/verify_install.js [安装目录]
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const target = process.argv[2] || null;

let problems = 0;
function ok(msg) { console.log('  ok   ' + msg); }
function bad(msg) { console.log('  FAIL ' + msg); problems++; }
function info(msg) { console.log('       ' + msg); }

function checkJson(file, label) {
  if (!fs.existsSync(file)) {
    info(`${label}: 不存在（首次运行会自动生成）`);
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok(`${label}: JSON 有效`);
    return data;
  } catch (e) {
    bad(`${label}: JSON 解析失败 — ${e.message}`);
    return null;
  }
}

function stationTableOk(file) {
  if (!fs.existsSync(file)) return { ok: false, count: 0 };
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/'([^']*)'/);
  if (!m) return { ok: false, count: 0 };
  return { ok: true, count: m[1].split('@').filter(Boolean).length };
}

console.log('\n=== 项目根目录 ===');
console.log('  ' + projectRoot);

// 用真实的站点模块验证配置里的站名能否解析
let stations = null;
try {
  stations = require(path.join(projectRoot, 'src', 'core', 'stations.js'));
} catch (e) {
  bad('stations.js 加载失败: ' + e.message);
}

const cfg = checkJson(path.join(projectRoot, 'data', 'config.json'), 'data/config.json');
if (cfg && cfg.routes && stations) {
  for (const r of cfg.routes) {
    const from = stations.resolve(r.from);
    const to = stations.resolve(r.to);
    if (from && to) {
      ok(`线路可解析: ${r.from}(${from.code}) -> ${r.to}(${to.code})`);
    } else {
      bad(`线路无法解析: "${r.from}" -> "${r.to}"  (from=${from ? from.code : 'null'} to=${to ? to.code : 'null'})`);
    }
  }
}

const st = stationTableOk(path.join(projectRoot, 'data', 'station_name.js'));
if (st.ok) ok(`站点表: ${st.count} 个车站`);
else bad('站点表缺失或格式异常');

checkJson(path.join(projectRoot, 'data', 'state.json'), 'data/state.json');

// ── 桌面 / 指定安装目录 ──
if (target) {
  console.log('\n=== 安装目录 ===');
  console.log('  ' + target);

  if (!fs.existsSync(target)) {
    bad('安装目录不存在');
  } else {
    const required = ['src', 'web', 'data', 'tools', 'package.json'];
    for (const r of required) {
      const p = path.join(target, r);
      if (fs.existsSync(p)) ok(r);
      else bad(r + ' 缺失');
    }

    // 启动器 exe
    const exes = fs.readdirSync(target).filter((f) => f.toLowerCase().endsWith('.exe'));
    if (exes.length) ok('启动器: ' + exes.join(', '));
    else bad('没有找到 .exe');

    for (const f of ['src\\server.js', 'web\\index.html', 'web\\app.js', 'web\\styles.css']) {
      const p = path.join(target, f);
      if (!fs.existsSync(p)) bad(f + ' 缺失');
    }

    const st2 = stationTableOk(path.join(target, 'data', 'station_name.js'));
    if (st2.ok) ok(`站点表: ${st2.count} 个车站`);
    else info('站点表缺失（首次运行会自动下载）');

    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    })(target);
    const total = files.reduce((a, f) => a + fs.statSync(f).size, 0);
    info(`共 ${files.length} 个文件，${(total / 1024).toFixed(1)} KB`);

    // 不应随分发的文件
    const leaks = files
      .filter((f) => /edge-profile|\.backup-v1|shot-radar|icon-preview/.test(f))
      .map((f) => path.relative(target, f));
    if (leaks.length) bad('包含不应分发的文件: ' + leaks.slice(0, 3).join(', '));
    else ok('无调试残留文件');
  }
}

console.log('\n' + (problems === 0 ? '校验通过' : problems + ' 项失败') + '\n');
process.exit(problems === 0 ? 0 : 1);
