'use strict';

/**
 * 探测某个端口上运行的是不是本程序，并判断它能否提供静态页面。
 *
 * 用途：区分"服务健康但文件缺失（404）"与"根本不是本程序"。
 * 用 Node 而非 PowerShell —— 受限环境下 PS 无法枚举进程。
 *
 * 用法: node tools/probe_instance.js [端口]
 */

const http = require('http');

const PORT = Number(process.argv[2] || 12308);

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 6000 }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers })
      );
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
  });
}

(async () => {
  console.log(`\n探测 127.0.0.1:${PORT}`);

  const state = await get('/api/state');
  if (state.error) {
    console.log('  /api/state  -> 无法连接: ' + state.error);
    console.log('\n结论: 该端口没有服务在跑。');
    return;
  }

  if (state.status !== 200) {
    console.log(`  /api/state  -> HTTP ${state.status}（不是本程序的接口）`);
    console.log('\n结论: 该端口被其它程序占用。');
    return;
  }

  let j = null;
  try {
    j = JSON.parse(state.body);
  } catch {
    console.log('  /api/state  -> 返回非 JSON（不是本程序）');
    console.log('\n结论: 该端口被其它程序占用。');
    return;
  }

  const isOurs = j && typeof j.stationCount === 'number' && j.diagnostics && j.config;
  if (!isOurs) {
    console.log('  /api/state  -> JSON 结构不符（不是本程序）');
    console.log('\n结论: 该端口被其它程序占用。');
    return;
  }

  console.log('  /api/state  -> 是本程序');
  console.log(`    站点库      ${j.stationCount}`);
  console.log(`    采集轮次    ${j.diagnostics.cycles}`);
  console.log(`    监控线路    ${(j.routes || []).length}`);
  console.log(`    采集间隔    ${j.intervalSec}s`);
  console.log(`    上次采集    ${j.diagnostics.lastRunAt ? new Date(j.diagnostics.lastRunAt).toLocaleString('zh-CN') : '从未'}`);
  console.log(`    上次错误    ${j.diagnostics.lastError ? String(j.diagnostics.lastError).slice(0, 80) : '无'}`);

  // 关键判断：静态文件是否可读
  console.log('\n  静态资源:');
  const files = ['/', '/index.html', '/styles.css', '/app.js'];
  let broken = 0;
  for (const f of files) {
    const r = await get(f);
    const mark = r.status === 200 ? 'ok  ' : 'FAIL';
    if (r.status !== 200) broken++;
    console.log(`    ${mark} ${f.padEnd(14)} HTTP ${r.status || r.error}  ${r.body ? r.body.length + ' bytes' : ''}`);
  }

  console.log('');
  if (broken === 0) {
    console.log('结论: 服务与静态文件均正常。');
  } else {
    console.log('结论: 服务在跑，但静态文件全部读不到 ——');
    console.log('      该实例的工作目录已被删除或移动（常见于重新构建安装目录时），');
    console.log('      它的 server.js 仍在内存里因此 API 有响应，但页面无法从磁盘读取。');
    console.log('      处理办法：关闭该实例（关掉它的控制台窗口），再重新启动程序。');
  }
})();
