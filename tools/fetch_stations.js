'use strict';

/**
 * 下载 12306 公开站点表并缓存到 data/station_name.js。
 * 运行时不再依赖网络获取该文件。
 *
 * 用法: node tools/fetch_stations.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'station_name.js');
const URL_PATH = '/otn/resources/js/framework/station_name.js';

https
  .get(
    {
      host: 'kyfw.12306.cn',
      path: URL_PATH,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 20000,
    },
    (res) => {
      if (res.statusCode !== 200) {
        console.error(`下载失败: HTTP ${res.statusCode}`);
        process.exit(1);
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const m = body.match(/'([^']*)'/);
        if (!m) {
          console.error('内容格式异常，未找到站点表');
          process.exit(1);
        }
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, body, 'utf8');
        const n = m[1].split('@').filter(Boolean).length;
        console.log(`已保存 ${OUT}`);
        console.log(`车站数量: ${n}  文件大小: ${body.length} 字节`);
      });
    }
  )
  .on('error', (e) => {
    console.error('下载出错:', e.message);
    process.exit(1);
  });
