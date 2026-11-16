# 测试

三层, 都以「和浏览器一致」为准 (第一原则). 修 bug 的顺序: **先写一个现在失败的测试, 再修**, 不管问题是自己写 demo 撞到的还是用户报的.

| 层 | 什么时候 | 内容 |
| --- | --- | --- |
| 守门 | 每次改动 (现在手动, `.gitea/workflows/test.yml` 选 `gate`) | `web/` 的 typecheck 和 `bun run test`; WPT 里期望文件说能过、且三次结果一致的那些 (gate) |
| 全量 | 每晚 / 发版前 (`full`) | 全部适用的 WPT (testharness、reftest、crashtest); 结果按目录出通过率 |
| 回归 | 修每个 bug 时 | 网页接口的行为: 能用 WPT 表达的就是 WPT 的那一项 (期望文件里从 FAIL 变成通过); WPT 没有的, 照 WPT 的写法 (testharness 或 reftest) 写进 acde-dom 的 `test/` 或 `tests/`; `acde:` 模块、窗口、命令行这类 WPT 管不到的, 写 acde-demo `apps/regressions` 的一格或 acdebin-dbg `npm/` 的 e2e |

**WPT** (`scripts/wpt/`, `wpt.sh` 是入口; 状态目录 `logs/wpt/`, `WPT_STATE` / `WPT_DIR` 可改):

- 范围: WPT 的全部目录, 除了 `scripts/wpt/not-applicable` 列的 (一行一个目录, tab 后是理由). 只有「测的是浏览器自己, 页面碰不到」的才算不适用:
  浏览器外壳和自动化协议 (webdriver、扩展)、开放网页的广告和隐私生态 (fenced frame、跨站归因、存储访问授权…)、浏览器的支付面板、只对 https 页面的策略
  (页面都是 `http://acde.local`)、校验器的测试. 其余都适用, acdert 没实现的是缺口 (期望文件里记 FAIL / NOLOAD), 不是不适用.
- 运行器还托管不了的 (不是不适用, 计数, 报告里单列): worker 变体 (`.any.worker.html` 等, 要 wptserve 现场生成)、要 wptserve 的 (`.sub.`、`.headers`、
  `.py` 处理器、websockets、eventsource)、https / h2、打印 reftest. 运行器把 WPT 目录链接进一个测试应用的静态资源, 页面都在 `http://acde.local`;
  接 wptserve 要 acde 支持「页面由后端给」的非框架应用 (现在只有框架的 SSR 产物能这样).
- 三种测试: testharness (`harness/testharnessreport.js` 收结果; `testdriver-vendor.js` 把 click / send_keys / action_sequence 交给驱动的真实输入);
  reftest (无边框窗口 800x600, 等 `reftest-wait` 去掉、字体就绪、两帧, 截图逐像素比, 按清单的 fuzzy 范围, 参考链, 同一会话缓存参考图);
  crashtest (加载、等 `test-wait` 去掉, 进程还在即 PASS). 页面打不开 (运行时把它换成了应用入口页, XHTML / SVG / XML 文档现在都这样) 6 秒内记 NOLOAD.
- 命令: `wpt.sh fetch` (稀疏检出 `revision` 钉的 WPT, 去掉不适用的目录, 生成清单) → `prepare --workers N` → `run --acdert <acdebin-dbg> [--label L]
  [--dirs a,b] [--kinds …] [--tests gate.json]` (`--app` 缺省是本仓库的 `web/packages/acde-host/dist`, 要先 `cd web && bun run build`) →
  `report L` (按目录的通过率、缺的接口、常见失败) / `expectations check L` (对期望文件, 回退就退出 1) / `expectations update L [L2 L3]` (几次结果合并,
  不一致的标 flaky) / `expectations gate` (守门的测试表).
- 期望文件 `scripts/wpt/expectations/<platform>/<目录>.json`: 每个测试一行, 全过的写状态, 否则 `{status, fail: [没过的子测试], flaky}`. 平台分开
  (字体、GPU 不同, reftest 结果不同): `linux` 由 CI 的 `baseline` 生成 (跑全量, 再跑两遍 gate, 三次合并; 产物里的 `expectations/linux` 拷进来提交),
  `darwin` 在 Mac 上照样做. 修好东西后跑 `update` 把改进记下来, 一起提交.
- CI (`.gitea/workflows/test.yml`, 手动, runner `x86_64-debian-234`, 直接跑在主机上, 没有 Docker): `web` 和 `wpt` (并排克隆 AC/acdebin-dbg 编 release, Mesa 的软件
  Vulkan 无头跑). 结果和期望文件作为产物留 14 天. 稳定后改成每次推送跑 gate、每晚跑 full, 改之前先告诉基座的人.
