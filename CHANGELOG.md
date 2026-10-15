# 更新日志

本文件记录 12306 余票雷达的显著变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.2.0] - 2026-10-15

### 修复

- **一个畸形请求路径就能打死整个服务。** `const u = new URL(req.url, ...)`
  写在请求处理器的 `try` 之外，而 `GET /\` 不是合法 URL（`new URL` 抛
  `ERR_INVALID_URL`）。异常冒出处理器后成了未捕获异常，进程直接退出 ——
  一个设计成连续跑几周的盯票服务，被一个 URL 就干掉了。解析现在包在
  `try` 里，失败回 400 `bad request`，服务继续跑。
- **`intervalSec` 没有任何范围与类型校验，1e21 会让定时器退化成 1 毫秒。**
  `/api/config` 把请求体里的数字原样写进配置，而引擎用它算延时：
  `setTimeout(tick, 1e21 * 1000)` 溢出了 32 位整数、被 Node 折算成 1ms，
  引擎于是以约 70 次/秒的频率猛打上游接口 —— 既是对第三方接口的滥用，
  也实打实地抬高账号与 IP 被判风控的风险。现在写侧拒绝非数字、把
  `intervalSec` / `rushIntervalSec` 收敛到 10 秒 ~ 24 小时、
  `dedupeWindowMin` 收敛到 0 ~ 1440 分钟；读侧 `currentIntervalSec()` 另有一道
  钳位兜底，任何来源的越界值都不会再变成死循环。
- **`npm run selftest` 与 `npm run probe` 指向不存在的文件**，一跑就是
  `MODULE_NOT_FOUND`。`selftest` 改为 `tools/test_core.js`（38 项离线自检，
  不联网），`probe` 改为实际存在的 `tools/probe_endpoints.js`，并新增
  `npm test` 作为统一入口。

### 新增

- `tools/test_core.js` 增加 5 项回归检查：间隔钳位的边界、钳位后延时一定落在
  `setTimeout` 的安全范围、畸形请求目标的成因，以及一条**真的把服务起起来、
  用裸 socket 发出 `GET /\`、断言得到 400 且进程仍存活**的端到端用例。
  把 `src/` 还原到修复前跑这三组，会得到 `通过 39 / 失败 3`（服务端那条是
  `ECONNRESET`，即进程真的死了）。

## [0.1.0] - 2026-09-30

首个版本：只读余票监测 + 微信提醒，不登录账号、不抢票、不绕过验证码。
