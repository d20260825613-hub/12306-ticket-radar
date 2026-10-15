'use strict';
const client = require('../src/core/client');
const stations = require('../src/core/stations');

(async () => {
  const from = stations.resolve('北京南');
  const to = stations.resolve('上海虹桥');
  console.log('站点:', from, to);

  const session = await client.openSession();
  console.log('会话 cookie:', JSON.stringify(session.cookie));
  console.log('会话时延:', JSON.stringify(session.timing));

  const qs =
    `leftTicketDTO.train_date=2026-11-02` +
    `&leftTicketDTO.from_station=${from.code}` +
    `&leftTicketDTO.to_station=${to.code}` +
    `&purpose_codes=ADULT`;

  for (const ep of ['queryG', 'queryO', 'queryZ', 'queryA']) {
    const res = await client.httpGet({
      path: `/otn/leftTicket/${ep}?${qs}`,
      cookie: session.cookie,
      minIntervalMs: 300,
    });
    let head = res.body ? res.body.slice(0, 120).replace(/\s+/g, ' ') : '';
    console.log(
      `${ep}: ok=${res.ok} status=${res.status} bytes=${res.body ? res.body.length : 0} ` +
        `ttfb=${res.timing.ttfb} tls=${res.timing.tls} err=${res.error || '-'}`
    );
    console.log(`     body: ${head}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
