'use strict';

/**
 * 线上 DOM 校验：抓取正在服务的页面，检查界面元素与绑定是否齐全。
 *
 * 用途：区分"渲染出来的 HTML 有问题"和"JS 绑定有问题"。
 * 纯文本解析，不依赖浏览器（受限环境下无法启动无头浏览器）。
 *
 * 用法: node tools/audit_dom.js [端口]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || 12308);

let pass = 0;
let fail = 0;
const problems = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    problems.push(name + (detail ? '  -> ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
  }
}

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
  });
}

/** 取出某个 id 元素的完整开始标签。 */
function tagOf(html, id) {
  const re = new RegExp(`<[a-zA-Z][^>]*\\bid="${id}"[^>]*>`, 'g');
  const m = html.match(re);
  return m ? m[0] : null;
}

(async () => {
  console.log(`\n校验 127.0.0.1:${PORT}`);

  const index = await get('/');
  if (index.error || index.status !== 200) {
    console.log('  无法获取页面: ' + (index.error || 'HTTP ' + index.status));
    process.exit(1);
  }
  const html = index.body;
  const app = await get('/app.js');
  const css = await get('/styles.css');
  const js = app.body || '';
  const style = css.body || '';

  console.log('\n【页面元素】');
  const requiredIds = [
    'modalMask', 'modalError', 'inFrom', 'inTo', 'acFrom', 'acTo',
    'dateChips', 'seatChips', 'btnSave', 'btnCancel', 'btnCloseModal', 'btnSwap',
    'confirmMask', 'confirmYes', 'confirmNo', 'confirmTitle', 'confirmText',
    'mainActions', 'mainBody', 'listBody', 'toasts', 'btnAdd', 'btnPoll',
    'statusCard', 'statusText', 'statusSub', 'brandVer',
  ];
  const missing = requiredIds.filter((id) => !tagOf(html, id));
  check(`${requiredIds.length} 个必需元素都存在`, missing.length === 0, missing.length ? '缺: ' + missing.join(', ') : '');

  console.log('\n【弹层初始状态】');
  const modalTag = tagOf(html, 'modalMask');
  const confirmTag = tagOf(html, 'confirmMask');
  check('#modalMask 初始带 hidden 属性', !!modalTag && /\bhidden\b/.test(modalTag), modalTag || '未找到');
  check('#confirmMask 初始带 hidden 属性', !!confirmTag && /\bhidden\b/.test(confirmTag), confirmTag || '未找到');

  console.log('\n【CSS 关键规则】');
  // [hidden] 必须能压住 .mask 的 display:flex，否则弹层关不掉
  const hiddenRule = style.match(/\[hidden\][^{]*\{[^}]*\}/);
  check('存在 [hidden] 规则', !!hiddenRule, hiddenRule ? hiddenRule[0] : '没找到');
  check('[hidden] 规则带 !important（压过 display:flex）',
    !!hiddenRule && /!important/.test(hiddenRule[0]),
    hiddenRule ? hiddenRule[0] : '');
  check('.mask 使用 display:flex', /\.mask\s*\{[^}]*display\s*:\s*flex/.test(style));
  check('存在 .mask[hidden] 兜底规则',
    /\.mask\[hidden\][\s\S]{0,100}?\{[^}]*display\s*:\s*none/.test(style));

  console.log('\n【线上文件是否落后于源文件】');
  // 这次的教训：改了项目里的 web/ 却忘了重建安装目录，
  // 运行中的实例一直在提供旧文件，界面上看不出任何异常。
  const localCss = path.join(ROOT, 'web', 'styles.css');
  const localJs = path.join(ROOT, 'web', 'app.js');
  try {
    const srcCss = fs.readFileSync(localCss, 'utf8');
    const srcJs = fs.readFileSync(localJs, 'utf8');
    check('线上 styles.css 与源文件一致', srcCss === style,
      `源 ${srcCss.length} 字节 / 线上 ${style.length} 字节`);
    check('线上 app.js 与源文件一致', srcJs === js,
      `源 ${srcJs.length} 字节 / 线上 ${js.length} 字节`);
    if (srcCss !== style || srcJs !== js) {
      console.log('');
      console.log('  ⚠ 运行中的实例提供的是旧文件。');
      console.log('    它可能是从另一个目录启动的（例如桌面安装目录）。');
      console.log('    处理：重新构建安装目录，然后重启程序。');
      console.log('      powershell -File tools\\build_exe.ps1');
    }
  } catch (e) {
    check('能读取源文件用于对比', false, e.message);
  }

  console.log('\n【JS 绑定完整性】');
  const binds = [
    ['btnAdd → openModal', /\$\('btnAdd'\)\.onclick\s*=\s*openModal/],
    ['btnCancel → closeModal', /\$\('btnCancel'\)\.onclick\s*=\s*closeModal/],
    ['btnCloseModal → closeModal', /\$\('btnCloseModal'\)\.onclick\s*=\s*closeModal/],
    ['遮罩点击关闭', /\$\('modalMask'\)\.onclick/],
    ['Esc 关闭弹层', /key === 'Escape'/],
    ['confirmYes 绑定', /\$\('confirmYes'\)\.onclick/],
    ['confirmNo 绑定', /\$\('confirmNo'\)\.onclick/],
    ['定时刷新里不再整段重建 DOM', /renderList\(S\.data\)/],
  ];
  for (const [name, re] of binds) check(name, re.test(js));

  console.log('\n【弹层不会被重渲染冲掉】');
  // 只统计真正的调用（openModal()），排除赋值处的函数引用（= openModal）
  const callCount = (js.match(/openModal\(\)/g) || []).length;
  const assignCount = (js.match(/=\s*openModal\b/g) || []).length;
  check('既有打开调用也有按钮绑定', callCount >= 1 && assignCount >= 1,
    `调用 ${callCount} 次 / 绑定 ${assignCount} 处`);
  // 只有 openModal 内部会把 hidden 置为 false
  const showSites = js.match(/modalMask'\)\.hidden\s*=\s*false/g) || [];
  check('只有一处会把弹层置为显示', showSites.length === 1, '共 ' + showSites.length + ' 处');

  console.log('\n【弹层在 #app 之外（不受列表重渲染影响）】');
  const appClose = html.lastIndexOf('</div>', html.indexOf('<div class="mask" id="modalMask"'));
  check('modalMask 位于 #app 之后', html.indexOf('id="modalMask"') > html.indexOf('</main>'),
    'modal 位置 ' + html.indexOf('id="modalMask"') + ' / main 结束 ' + html.indexOf('</main>'));

  console.log('\n══════════════════════════════');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (problems.length) {
    console.log('\n问题清单：');
    for (const p of problems) console.log('  · ' + p);
  }
  process.exit(fail === 0 ? 0 : 1);
})();
