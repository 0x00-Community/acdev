# 测试

三层, 都以「和浏览器一致」为准 (第一原则). 修 bug 的顺序: **先写一个现在失败的测试, 再修**, 不管问题是自己写 demo 撞到的还是用户报的.

| 层 | 什么时候 | 内容 |
| --- | --- | --- |
| 守门 | 每次改动 (现在手动, `.gitea/workflows/test.yml` 选 `gate`) | `web/` 的 typecheck 和 `bun run test`; WPT 里期望文件说能过、且三次结果一致的那些 (gate) |
| 全量 | 每晚 / 发版前 (`full`) | 全部适用的 WPT (testharness、reftest、crashtest), 结果按目录出通过率; 并排克隆 AC/acde-demo 跑它全部应用的 e2e (含回归用例那一页) |
| 回归 | 修每个 bug 时 | 网页接口的行为: 能用 WPT 表达的就是 WPT 的那一项 (期望文件里从 FAIL 变成通过); WPT 没有的, 照 WPT 的写法 (testharness 或 reftest) 写进 acde-dom 的 `test/` 或 `tests/`; `acde:` 模块、窗口、命令行这类 WPT 管不到的, 写 acde-demo `apps/regressions` 的一格或 acdebin-dbg `npm/` 的 e2e |

**WPT** (`scripts/wpt/`, `wpt.sh` 是入口; 状态目录 `logs/wpt/`, `WPT_STATE` / `WPT_DIR` 可改):

- 范围: WPT 的全部目录, 除了 `scripts/wpt/not-applicable` 列的 (一行一个目录, tab 后是理由). 只有「测的是浏览器自己, 页面碰不到」的才算不适用:
  浏览器外壳和自动化协议 (webdriver、扩展)、开放网页的广告和隐私生态 (fenced frame、跨站归因、存储访问授权…)、浏览器的支付面板、只对 https 页面的策略
  (页面都是 `http://acde.local`)、校验器的测试. 其余都适用, acdert 没实现的是缺口 (期望文件里记 FAIL / NOLOAD), 不是不适用.
- 托管: 和浏览器跑 WPT 一样用 wptserve (`.sub.` 模板、`.headers`、`.py` 处理器、worker 和 `.any` 变体都由它现场生成). 每个 worker 是一个
  `"entry": "/"` 的测试应用 (页面由后端给), 后端 `proxy.ts` 把页面的请求原样转给 wptserve (字节流, 不经 HTTP 客户端改写); 它还原运行时为后端改的
  `Host` / `Origin` / `Referer` (后端看到的是 `localhost`, 见 `docs/web/backend.md`「路由」) 成 `acde.local`, 并换上本目录的 `testharnessreport.js` /
  `testdriver-vendor.js`. wptserve 由 `serve.py` 起: 对外 (模板里) 的端口是 80 / 8001 / 8443 …, 实际监听 `--serve-port` 起的几个端口
  (缺省 18000), 所以不用 root. 运行器还托管不了的 (不是不适用, 计数, 报告里单列): https / h2 (页面不是 https)、websockets (ws 服务器在另一个端口,
  `acde.local:<端口>` 不进后端)、打印 reftest. 跨端口 / 子域名 (`HTTP_PORT2`、`www.`) 的子测试会失败, 记在期望里.
- 三种测试: testharness (`harness/testharnessreport.js` 收结果; `testdriver-vendor.js` 把 click / send_keys / action_sequence 交给驱动的真实输入);
  reftest (无边框窗口 800x600, 等 `reftest-wait` 去掉、字体就绪、两帧, 截图逐像素比, 按清单的 fuzzy 范围, 参考链, 同一会话缓存参考图);
  crashtest (加载、等 `test-wait` 去掉, 进程还在即 PASS). 6 秒内页面没加载完记 NOLOAD.
- 命令: `wpt.sh fetch` (稀疏检出 `revision` 钉的 WPT, 去掉不适用的目录, 生成清单, 装好 wptserve 的 Python 环境) → `prepare --workers N` → `run --acdert <acdebin-dbg> [--label L]
  [--dirs a,b] [--kinds …] [--tests gate.json] [--skip-slow <期望目录>]` (`--skip-slow` 跳过期望里记成 TIMEOUT / NOLOAD / HANG 的: 它们大多等满 10 / 60 秒的超时, 全量里大半时间花在这上面, 比如 acdert 没有的老式多字节编码; 只有 `baseline` 全跑) (`--app` 缺省是本仓库的 `web/packages/acde-host/dist`, 要先 `cd web && bun run build`) →
  `report L` (按目录的通过率、缺的接口、常见失败) / `expectations check L` (对期望文件, 回退就退出 1) / `expectations update L [L2 L3]` (几次结果合并,
  不一致的标 flaky) / `expectations gate` (守门的测试表).
- 期望文件 `scripts/wpt/expectations/<platform>/<目录>.json`: 每个测试一行, 全过的写状态, 否则 `{status, fail: [没过的子测试], flaky}`. 平台分开
  (字体、GPU 不同, reftest 结果不同): `linux` 由 CI 的 `baseline` 生成 (跑全量, 再跑两遍 gate, 三次合并; 产物里的 `expectations/linux` 拷进来提交),
  `darwin` 在 Mac 上照样做. 修好东西后跑 `update` 把改进记下来, 一起提交.
- CI (`.gitea/workflows/test.yml`, 手动, runner `x86_64-debian-234`, 直接跑在主机上, 没有 Docker): `web`; `wpt` 每个分片一个任务
  (`gate` 一片, `full` / `baseline` 四片, 依次跑: Gitea 一个任务最多 3 小时, 全量一个任务跑不完; `run --shard i/n` 按分块的名字分);
  `expectations` (只有 `baseline`: 合并各片结果, gate 再跑两遍, 写 `expectations/linux`, 作为产物 `wpt-expectations`, 拷进来提交);
  `demo` (`full` / `baseline`: acde-demo 的 e2e). 准备环境的步骤在 `.gitea/actions/wpt-setup` (并排克隆 AC/acdebin-dbg 编 release, Mesa 的软件
  Vulkan 无头跑, WPT 检出). 结果作为产物留 14 天. 稳定后改成每次推送跑 gate、每晚跑 full, 改之前先告诉基座的人.
