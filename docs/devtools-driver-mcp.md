# 开发工具、driver、MCP、e2e

> 路径相对 CLI 包根 `npm/`。

都用 `DevClient` 直连会话的 `endpoint`. 挑会话 (`Sessions.pick`): `--session`; 否则 (不算测试会话) `dirs` 包含当前目录的 (取最深的); 否则当前目录不在任何工程里、只有一个会话时用它, 并在 stderr 说用的是哪个 (`say`, 命令行传入; driver 和 MCP 不传); 否则报错并列出.
连不上 (`ECONNREFUSED` / `ENOENT`) 时删掉会话文件, 报 `acdev dev <pid> is gone`.

**客户机里的会话** (`--session vm`, 工单 19 / A2; 命令、MCP 的 `acdev mcp --session vm`、driver 的 `Acde.attach({session: 'vm'})`): 不读会话文件,
经 `acdev vm` 那台客户机的 acdevd 开 `C` 隧道 (`Devd.socket()`, 内容为空: acdevd 找 logind 活动会话的管家调试套接字
`/run/user/<uid>/acde/dev.sock`, 见 `docs/devd.md`), 在隧道上建 `DevClient` (`DevClient.over`, 收任何 `Duplex`), 先发
`{type: 'hello', role: 'dev'}`, 之后和宿主同样一行一个 JSON. 会话记录是 `Sessions.guest()` (`endpoint` 为 `vm`, `pid` 0, `desktop` 为 `vm`);
`Sessions.pins` 判断钉住的是不是它. `acdev stop --session vm` 报错 (会话随用户注销结束, `acdev vm stop` 停客户机).
`webs` 在客户机里的回答多一个顶层 `locked` (有没有锁屏进程), 锁屏页那一行带 `lock: true` (`Acde.webList` 都留着, `webs()` 只给列表);
`Format.webs` 在有页面带 `lock` 时多一列 LOCK, 回答带 `locked` 时表下多一行 `locked: yes
客户机里限时内没回答的页面 (管家按进程限时 1.5 秒, libacde `docs/dev/dev-ipc.md`) 那一行带 `stalled: true`, `Format.webs` 把它的标题列写成 `(not answering)`.|no`; 宿主上两者都没有, 输出不变. 命令行和 MCP 同一份.
`screen` 在客户机会话里不带 `path` (宿主路径在客户机里写不了), 管家回 `{png: <base64>, width, height}`, acdev 解码后写到宿主路径
(`Acde.screen`, 命令行和 MCP 同经它); 宿主会话照旧让运行时写文件.
和宿主不同的回答: 客户机的 `input` 回 `{done, textSkipped}` (窗口管理器注入, 见 acdes `docs/manager.md`), 不是 act 回答; `Acde.inputResult` 两种都认,
`textSkipped` 大于 0 时算失败并说明原因 (命令行、MCP、driver 同一处). 客户机里注入的文字在网页里只留 ASCII, 所以 driver 的
`keyboard.type` / `insertText` 在客户机会话里遇到非 ASCII 文字时改走页面: 找那个页面窗口里有焦点的元素 (`query ':focus'`), 用 `act type`
经页面输入法打进去 (`Acde.typeInPage`); 没有焦点元素时报错.

- **命令** (`src/tools.ts`): `webs` (表格)、`eval <web> <代码|->` (JSON; web 是 web 名、应用 id 或 `desktop`)、`shot <web> [-o]` / `screen [-o]`
  (PNG 写文件, 打出路径)、`inspect` (`snapshot().text`; 给了 `--find` 时只打匹配的元素: acdev runtime 回的 `trees` 里一个命中节点带着整棵子树 (运行时的 `find` 命中就停),
  所以 acdev 按同样的规则 (名字或值含这段文字, 不分大小写) 在 `trees` 里重新找, 每个命中一行, 后面跟最近的有名字的祖先, 按窗口分组 (`Format.found`);
  一个都没有时 stderr 一行 `acdev: no element's name or value contains "<文字>"` (没给 `--offscreen` 时加一句它的提示)、退出码 2 (`Exit.NOTHING`))、`query <选择器> [--window W] [--ref REF] [--limit N]` (driver 的 `query`, 即 op `query`: 按 CSS 选择器找元素,
  `inspect` 不列的 (`display: none`、滚出可见范围、没有角色名字的) 也给 ref; 输出是 `Format.matches`, 和 MCP 的 `query` 同一份: `N in <窗口>:` 加每个元素一行
  `- <节点> <标签>` (节点那段是 `Locator.line`, 和运行时 `inspect` 的一行逐字相同: 角色、名字、值、标题的 `[level=N]`、状态、ref; `inspect --find`
  和 Locator 的报错也用它, 只有这一份), 不可见的后面标 `[hidden]`, 运行时给节点带的 `transparent` / `invisible` 状态照旧在前面, 所以和 `inspect --all` 的标记一致;
  找到时退出 0; 没有匹配时 stderr 打 `acdev: nothing in <窗口> matches "<选择器>"`, 退出码 2 (`Exit.NOTHING`, acde#85); `--limit` 是 1 到 3000 (`Tools.QUERY_LIMIT`, 运行时默认 600), 不用连会话先查)、
  `act <ref> <动作> [参数]` (动作只认 driver 的 `ACTIONS`, `ok: false` 退出码 1; 打的是 driver 的 `act` 的 `text`,
  关掉单应用会话唯一的窗口时就是那行「会话结束」, 退出码 0, 见 driver 的「关窗口结束会话」)、
  `stop` (挑会话同上, 连上发 `{type: "quit"}`, 等连接断、再等 acdev dev 的 pid 退出, 各最多 10 s (等连接的计时器在连接断开后取消, 不然它让 `acdev stop` 多留 10 s, acde#51), 还在就 SIGTERM (Windows 上是强制结束,
  acdev runtime 因连接断开跟着退出), 删会话文件, 打 `acdev: stopped acdev dev <pid>`; 连不上时删会话文件、报 `is gone`, 不按 pid 结束进程: pid 可能已被复用)、
  `console` / `network` (`--follow` 每 0.5 s 带 `next` 续读; `--since N` 从第 N 条起 (运行时的 `since` 含这一条), `--since reload` 从会话文件的
  `reloaded` 起: acdev dev 每次重建后、发 `reload` 之前用自己的连接问 `console` / `network {limit: 1}` 的 `next` (最多等 2 s, 问不到沿用上一次),
  写进会话文件 `reloaded: {console, network}`. 运行时的记录不随页面重载清空, 也不标重载 (同一窗口重载后 web 名不变, 不能按 web 名分), 所以只认
  acdev dev 发的重载, 页面自己的 `location.reload()` 不算; 还没重载过时是全部). 格式在 `src/driver/format.ts`. 出错 `acdev: <原因>`, 退出码 1; 动作名、`--level` 这类不用连会话就能查的参数先查, 错误一行, 末尾指向 `acdev <命令> --help`.
- **批准的命令** (`src/approvals.ts` `Approvals`, CLI 和 MCP 共用; 运行时一侧见 libacde AGENTS.md 的「批准」): 第 1 级下要批准的必需能力
  (`terminal`、`network`、`camera`、`microphone`、`launch`、`slots`、`fs.roots` 里的公共位置) 没答之前应用不开窗口, macOS / Linux 的宿主窗口和 headless
  没有对话框, 只能经 dev IPC 答. `acdev permissions` 打两段 (`Format.permissions`): `pending:` 下每行 `<id>  <app>  <能力>  (<launch|request>)`,
  `decisions:` 下每行 `<app>  <能力>  <granted|denied>`, 空的一段是 `pending: none` / `decisions: none`. `acdev allow` / `acdev deny`
  `[<提示 id> | <app> <能力>] [--all]` (`Tools.wanted` 先查参数, 不用连会话: 一个参数必须是数字 id, `--all` 不能再带参数; `Approvals.pick` 挑提示):
  不带参数时只有一个待答就答它, 几个待答时一个都不答、列出来、退出 1 (不猜); 按 id 或按应用加能力点名; `--all` 全答. 每答一个打
  `allowed|denied <app> <能力> (prompt <id>)`. 没有待答的、点名的不在待答里 (已有决定时说 `it is already granted|denied (revoke takes that back)`) 退出 1.
  `acdev revoke <app> <能力>` 是 driver 的 `revoke`, 打 `revoked <app> <能力>`, 没有那条决定时退出 1. `acdev webs` 的表是空的时候 (单应用会话的应用在等批准)
  每个待答提示再打一行 `<app> waits for approval of <能力>: acdev allow (or acdev deny)` (`Approvals.waiting`, `Format.waiting`; MCP 的 `webs` / `start`
  同理, 后半句是 `the answer tool allows or denies it`); 桌面会话里 `webs` 总有桌面页, 不打这行, 看 `acdev permissions`. 实测 (2026-11-11, acdert 0.0.9
  加当天的修复): 单应用会话里拒绝必需能力后 acdev runtime 记一行 `acdert app <id>: <名字>: "<能力>" is denied by the user; acdert app asks for it again the next
  time it runs` 退出 1, 下次 `acdev dev` 再问 (`… was denied "<能力>" in an earlier run: asking again`); 撤销必需能力后应用照常跑到下一次 reload,
  reload 时 acdev runtime 记同一行退出 1; 桌面里拒绝会留着 (跨会话), 应用不进列表 (`acde:apps` 发 `changed`), 撤销已批准的必需能力后应用同样出列表,
  开着的窗口留到下一次 reload (日志 `acdev dev: reload: <名字>: "<能力>" is denied by the user`, 窗口关掉); 撤销之后这一次运行里一直算被拒, 下次起运行时再问.
- **就绪等待** (`acdev wait <条件>`、driver `acde.waitFor(条件, 限时)`, `src/driver/wait/`, AC/acdev#115, 设计见总仓 `.scratch/acdev-debug-insight/issues/10-readiness.md`): 照 Espresso 的空闲资源, 等条件不等固定时长. 条件是一个判别联合 (`Condition`): `page` (在页面里求值 `true`; `no page` / `the page went away` 算还没好, 其余错误照抛)、`window` (窗口表里按 ref、窗口号、应用 id、标题 (不分大小写) 找, `focused` 再看 `focus`)、`element` (`snapshot({all})` 里按 `Format.found` 同一规则数命中, `gone` 等到 0)、`stable` (快照文本在 `quiet` 毫秒内没变)、`network-idle` (`network` 里没有 `done: false` 的条目, 且条目的序号和完成状态在 `quiet` 内没变)、`eval` (表达式结果为真; 同 `page` 认“还没好”)、`service` (`import('acde:services')` 的 `names()` 含这个名字). 每次判断回 `{done, seen}`, 间隔从 100 ms 翻倍到 500 ms; 到限时 (缺省 30 s) 抛 `WaitTimeout`, 消息带最后一次的 `seen`. 命令行超时时再用 `Evidence.keep` 留一份证 (标签 `wait-<条件>`, 客户机会话带日志), 退出码 1. 时钟和停顿可注入 (`Pace`), 单测不真等. 判断都在宿主一侧, 不需要 acdes. MCP 的 `wait_for` 还只按文字等, 扩到这些条件要先拆 `mcp.ts` (已近 800 行).
- **留证** (`acdev evidence [label]`, `src/evidence/`, AC/acdev#115, 设计见总仓 `.scratch/acdev-debug-insight/issues/02-failure-bundle.md`): 照安卓 bugreport / 问题步骤记录器, 出事当下一次留证. `Evidence.folder` 在 `-o` (缺省 `./.acde/evidence`) 下建 `<UTC 时间到毫秒>-<label>` (label 经 `paths.ts` 的 `slug`, 空了用 `evidence`), 用不带 `recursive` 的 `mkdir`, `EEXIST` 时加 `-2`、`-3` …, 所以并发和重跑都不覆盖. `Evidence.keep(scene, capture)` 按顺序采: `error.txt` (有失败原因时)、`output.log` (有 acdev dev 输出时)、`screen.png`、`webs.txt` (`Format.webs`)、`snapshot.txt` (`snapshot({all, offscreen})`, 旁边 `windows.json` 是它的 `windows`)、`console.txt` / `network.txt` (各最多 5000 条)、`journal.txt` (只在客户机会话: `guestJournal` 经 acdevd 跑 `journalSince`, 即 `journalctl -o short-iso-precise -n 20000 --since @<秒>`, 全部单元一起, 按 journald 的 REALTIME 排好). 全部共用 20 s 的时限 (`BUDGET_MS`), 一项失败或超时写 `<文件>.error.txt`, 不影响别的项; 最后写 `manifest.json` (`label`、`at`、`since`、每项 `{file, ok, ms, error?}`). `--since` 认 `@<unix 秒>`、ISO 时间、`<n>s` / `<n>m` 之前, 缺省两分钟前 (`RECENT_S`). 会话连不上 (`Acde.attach` 失败) 时 scene 为 null, 照样留 `error.txt` (连不上的原因) 和客户机日志. 退出码: 有一项采到就 0, 否则 1. 宿主会话没有 journald 那一项, acdev dev 的输出要用 `acdev test` 的 `output.log`.
- **客户机里的 DevTools** (`acdev devtools [web] --session vm`): 客户机的 `devtools` 回 `{ports: [{web, app, port}]}` (每个页面进程一个端口),
  宿主的回 `{port}`, `Devtools.ports` 两种都认; `Devtools.portFor` 按 web 名或应用 id 挑 (只有一个时就用它). 挑中的端口经
  `Forward` (`src/vm/forward.ts`) 转到宿主: 本机 `127.0.0.1` 上开一个随机端口, 每条连接开一条 `T` 隧道 (`Devd.tcp(port)`) 接过去;
  `/json/list` 经它读, 目标的 `webSocketDebuggerUrl` 改成本机端口 (`Devtools.through`), 再照常打开. 打开后命令不退出, 一直转发到 Ctrl+C.
- **`acdev devtools [web]`** (`src/devtools.ts` `Devtools`, acde#75; 规格 acdert#172): 和其他会话命令一样挑会话, 发开发通道请求
  `devtools` (`Acde.devtools()`, 回 `{port}`, 旧的 acdert 另带 `token`), 读 `http://127.0.0.1:<port>/json/list`, 按 id 挑目标 (给了 web: 参数本身、
  它解析出的 web 名或窗口号, web 按名字、应用 id、窗口号、窗口标题 (先原样, 再不分大小写) 找; id 都不中再按目标标题找 (不分大小写,
  也认去掉末尾 ` (<应用 id>)` 的标题), 再找 `service` 类型的目标 (服务, acdert#193: `services` / `service` 或标题 `services: a, b` 里的
  服务名); 没给: 聚焦的网页窗口, 没有就桌面), 用浏览器打开 `devtools://devtools/bundled/inspector.html?ws=…`.
  - 方向 (用户定 2026-11-17): 开发者工具内置进 acdev, 不依赖 Chrome, 是虚拟机的核心能力; 下面借 Chrome / Edge 的打开方式是现状, 换掉之前照旧.
  - 怎么打开 (`src/devtools-browser.ts` `DevtoolsBrowser`, acde#80): Chrome 158、Edge 157 不认命令行上的 `devtools://` 地址 (只开新标签页),
    所以经浏览器自己的 CDP 用 `Target.createTarget` (`newWindow: true`) 打开. 浏览器用 acdev 专用的配置目录
    `<用户缓存目录>/acde/devtools/<浏览器名的 slug>` (Windows `%LOCALAPPDATA%`, macOS `~/Library/Caches`, 其他 `$XDG_CACHE_HOME` 或
    `~/.cache`) 起, 带 `--user-data-dir=<它> --remote-debugging-port=0 --no-first-run --no-default-browser-check
    --no-startup-window --disable-sync` (`--no-startup-window`: 不先开一个空白新标签页的窗口, 屏幕上只有 `createTarget` 开的 DevTools
    窗口; 没有窗口时浏览器照样写端口文件、应答 CDP, 某个浏览器或平台不吃这个参数时走下面的退回路径. `--disable-sync`: 全新配置第一次
    起 Edge 157 时不再多开 `edge://sync-confirmation-dialog/`; Chromium 的通用参数, 对所有浏览器都加, 专用配置本来不需要同步),
    不碰用户日常的配置
    (Chrome 136 起默认配置目录不许开远程调试), 长期复用. 端口从配置目录的 `DevToolsActivePort` 读 (第一行端口, 第二行浏览器端点路径);
    文件在且 `/json/version` 答得上就复用那个浏览器, 不再起第二个进程; 否则删掉旧文件再起, 最多等 20 s. 起不来、连不上或
    `createTarget` 报错时打印地址和原因, 退出 0. `ACDEV_BROWSER=none` 只打印地址.
  - 浏览器查找顺序 (`Devtools.candidates`): `ACDEV_BROWSER` 优先 (路径; `none`: 不打开, 只打印地址, 提示也说明是它的缘故);
    Windows 依次查 `ProgramFiles(x86)`、`ProgramFiles`、`LOCALAPPDATA` 下的 Edge, 再同样三处的 Chrome; macOS 是 `/Applications`、
    `~/Applications` 里的 Google Chrome.app, 再 Microsoft Edge.app; Linux 在 PATH 上依次找 `google-chrome`、`google-chrome-stable`、
    `chrome`、`chromium`、`chromium-browser`、`microsoft-edge`、`microsoft-edge-stable`. 都没有时打印地址和说明, 退出 0.
  - 端点不要令牌 (acde#79, acdert#199): acdev runtime 按 `Host` 和 `Origin` 防护 (同 Chrome 自己的调试端口), `devtools` 只回 `{port}`,
    `/json/list` 和目标的 `webSocketDebuggerUrl` 原样用. 还回 `token` 的旧 acdert 照旧: `/json/list` 带 `?token=` (另加
    `Authorization: Bearer`), WebSocket 地址没带 `?token=` 时补上 (DevTools 前端连 WebSocket 不能加请求头), 这时打印的地址含令牌,
    别贴进议题、日志或聊天.
  - 测试: 假运行时 应答 `devtools` 并提供 `/json/list` (令牌 `fake-token`; `FAKE_ACDERT_DEVTOOLS_TOKENLESS=1` 时只回端口、不查令牌);
    命令行用例设 `ACDEV_BROWSER=none`; 启动浏览器的用例用假浏览器 (`test/fixtures/dev/fake-browser.ts`, `fakeBrowser()`): 它按
    `--user-data-dir` 写 `DevToolsActivePort`, 记下启动参数和收到的 CDP 调用, 闲 15 s 自己退出; 进程内的用例经 `launch` 注入只记录.
- **driver** (`acdev/driver`, `src/driver/`, 只用 `node:` 模块; 公开的接口类型、`ACTIONS`、`ActError` 和 `LaunchError` 在 `types.ts`, `acde.ts` 原样再导出, 只放 `Acde` 类): `Acde.attach` / `Acde.launch` (用工程的运行时跑 `cliFile()` (`Acde.runtime`: 规则同
  `Cli.follow`, 没有就用 `process.execPath`), 带 `ACDEV_FOLLOWED=1`: 会话文件按子进程 pid 找, `acdev dev` 自己再换运行时的话登记的是孙进程, 永远等不到;
  输出进 `Logs`,
  等会话文件再等 `ready()`: 窗口表不空且每个 web 的窗口都在表里, 因为 acdev runtime 先答 `webs`, 窗口稍后进表; 有待答的批准提示 (只剩摄像头 / 麦克风会问) 也算起来了; 默认 120 s (等不到会话文件时报出这段时间里别的进程登记的会话); `close()` 见下文 `Acde.#stop`).
  **起不来** (`LaunchError`, 是 `Error`, `name` 仍是 `Error`: 0.0.8 的输出里是 `error:` / `Error:`; `phase` / `code` / `logs` 是 getter, bun 打错误时
  不把它们当自有属性列出来): 消息第一行是 0.0.8 的原文, 说停在哪一步的是加在后面的一行, 再后面是输出的最后 40 行; `logs` 是全部输出.
  `exited`: `acdev dev exited (N) before it was ready:` (子进程退出后先等输出读完, 最多 `DRAIN_MS` 1 s, 再报, 所以最后几行不会丢);
  `session`: 限时内没有会话文件, 加一行 `no session yet: its build did not finish, or acdev runtime did not start listening; last output:` (会话文件要等
  构建完、acdev runtime 听上、acdev dev 连上才写; 分不清是哪一步, 两种都说, 输出里看得出; 别的进程登记了会话时不说这句);
  `window`: 会话在、acdev runtime 在答, 但 `ready()` 一直不成立也没有待答提示, 加一行
  `acdev runtime runs and answers, but no window appeared (pages: N, windows: M) and no approval prompt waits; last output:`; 轮询中连接断了不直接抛
  `acdev runtime closed the connection` (acdev runtime 先退, acdev dev 随后才退, 下一轮就是 `exited`), 到限时还没退出才说连接断了; `failed`: 其余的错 (连不上、
  acdev runtime 不答), 消息不变, 原错误在 `cause`.
  `close()` 先经自己的连接给 acdev runtime 发 `{type: 'quit'}` (acdev runtime 退出, acdev dev 随之走自己的收尾), 再关连接.
  失败和 `close()` 都经 `Acde.#stop`: unix 上 SIGTERM, 10 s 后 SIGKILL; Windows 上 SIGTERM 就是 `TerminateProcess`, acdev dev 的收尾不跑、
  acdev runtime 不随它结束, 所以只在发过 `quit` 时等它自己退 10 s, 否则或到时就 `Runtime.killTree` (`taskkill /T /F` 连 acdev runtime 一起结束, 再 SIGKILL).
  等的是进程退出 (`Child.gone`, `exit` 事件) 而不是管道关闭 (`Child.exited`,
  `close` 事件): 构建卡住时 acdev dev 被结束后它的构建子进程还拿着管道, 等 `close` 永远等不到, 测试只能由 bun 在限时加宽限期后杀掉, 什么都不留
  (实测过). 之后等输出读完 (最多 1 s) 再销毁两根管道. 等待用可取消的定时器: 原来 `close()` 里没取消的 10 s 定时器让只用 driver 的脚本在
  `close()` 之后还要等 10 s 才退出. 没解决的: acdev dev 在构建中被结束时, 构建工具的子进程不随它结束 (没有进程组; `acdev test` 里用进程组会让
  终端的 Ctrl+C 到不了 acdev dev 和 acdev runtime), 会留到它自己跑完.
  方法和 op 一一对应 (`chooseFolder` / `chooseFiles` / `chooseSaveFile` 都是 `choose`, 分别给 `folder` / `open` / `save`; 相对路径按当前目录解析;
  `route(url, 回应, {method, web, times})` 是 `route`, url 是 glob (同 libacde: `**` 任意, `*` 不含 `/`, `/` 开头比路径加查询) 或 RegExp, 回应
  `{status, statusText, headers, contentType, body (文字或字节, 转 base64), json}` 或 `{abort}`; `unroute(id?)`; `clipboard()` / `setClipboard(text)`). `evaluate` 返回 `NoInfer<T>` (否则 `expect(await w.evaluate(…))` 被推成 `Locator` 的重载).
  `waitForRequest(url, {method, web})` 先取 `network` 的 `next` 再轮询到匹配的请求结束 (`done`), `waitForConsole(文字或 RegExp, {level, web})` 同理; 要在触发之前调用.
  **批准** (只剩摄像头 / 麦克风: 用户 2026-11-11 决定其余能力声明即授予, acdert#146; acde#16, op `permissions` / `answer` / `revoke`, 类型来自 SDK 的 `PermissionPrompt` / `PermissionDecision` / `ApprovalCapability`):
  `permissions()` → `{pending, decisions}`; `waitForPrompt({app, capability, timeout})` 轮询到匹配的待答提示; `answer(提示或 id, allow)`;
  `allow(匹配)` / `deny(匹配)` 是等到再答, 回那个提示. `revoke(app, capability)` (capability 的类型是 `PermissionDecision['capability']`, 含用户选的文件夹 `fs.folder-<令牌>`) 是 op `revoke` (acdert#95), 回 `revoked`
  (有那条决定并删掉了才是 true), 桌面会话和 `acdev runtime app` 都能用. 没人答的提示一直等, 不自动批准.
  **拖放** (op `drop`): `drop(文件, {web, x, y})` (相对路径按当前目录解析, x / y 页面坐标一起给, 默认页面中心, web 默认 desktop) →
  `{web, window, files}`; `AppWindow.drop(文件, {x, y})` 带上自己的 web. acdev runtime 排进主线程就回答, 页面稍后才收到 `drop`, 要等页面上的效果
  (如 `evaluate` 轮询或 `expect`), 不能以回答为准. 页面拿到的: 普通文件进 `dataTransfer.files` (`File`), 每项 `getAsFileSystemHandle()` 是只读句柄
  (文件夹是目录句柄); 扩展期 `items` 前面还有 `text/uri-list` / `text/plain` 两项字符串.
  客户机会话 (`--session vm`) 里宿主的文件客户机里没有: `Acde.drop` 先经 acdevd 推进客户机 (`stageInGuest`, `src/vm/guest.ts`): 从 logind 取
  活动会话的用户和 uid, 推到 `/run/user/<uid>/acdev-drop/<随机名>/<原文件名>` (文件夹整个推), 再 `chown -R <用户>:` 并 `chmod 700`
  `acdev-drop`, 应用以用户身份才读得到; 然后用客户机里的路径 drop. 推不进去时报 `drop: could not put the files into the guest: …`, 不发 drop.
  客户机管家回 `{window, files, ms}` (不带 web), `Acde.dropped` 两种回答都认, 没有 web 时用请求里的 (默认 desktop); 原来按宿主形状严格检查,
  客户机的回答被当成坏回答报错 (`acdev runtime answered drop with …`, 退出码 1), 那就是「回了 answered 退出码却是 1」. 命令行和 driver 同经
  `Acde.drop`; MCP 没有 drop 工具.
  **关窗口结束会话** (命令行、MCP、driver 共用 `Acde.act` 这一处): 单应用会话 (`acdev runtime app`, 会话文件 `desktop` 为 null) 里关掉应用的窗口,
  acdev runtime 按设计随之退出, 不回答这个 `act` (实测 acdert 0.0.9: 日志 `ended (close), exit 0`, 连接直接断). `act(窗口 ref, 'close')` 发出时连接还在、
  等回答时连接断了 (`DevClient.ended`, 在 socket 的 `close` 事件里同步置位, 先于在途请求被拒)、会话是单应用的、不是自己 `close()` 断的, 就算成功:
  回 `{ok: true, ended: true, text: 'closed <ref>; acdev runtime exited with it, so acdev dev <pid> ended'}` (`Acde.endedBy`); `Acde.closed` 就是
  `DevClient.ended`. `AppWindow.close()` 见到 `ended` 不再等窗口消失; acdev runtime 先回答再退出时 (等窗口消失的轮询中连接断了) 同样回这个结果.
  别的情况连接断了照旧报错 (`acdev runtime closed the connection`), 不把崩溃当成功: 别的动作、元素 ref、桌面会话里的 `close` (那里关应用窗口不结束
  acdev runtime, 桌面关不掉: `the desktop cannot be closed`)、`run` (整批的回答丢了, 说不出前面几步做了什么). 会话已断之后再 `act` 是
  `acdev dev <pid> is no longer connected`.
  `AppWindow` 每次用到时在窗口表里重新找; `route` / `waitFor*` 带上它的 web. `Locator` 每次在最新语义树 (`limit: 3000, offscreen: true`) 上重新求、不缓存 ref; 动作要**恰好一个**匹配
  (多个报错, 不猜), click / fill / type / selectOption 还等不 `disabled`, `ok: false` 重试到超时再抛 `ActError`. `getByLabel` 是名字匹配的表单角色
  (textbox、combobox、checkbox …); `getByPlaceholder` / `getByTitle` / `getByAltText` 用 `query` 的 `attributes` 读回属性再比. `check` / `uncheck` /
  `setChecked` 状态不对才点, 点完等状态变过去; `dragTo(目标)` 每次重新找两边, 发 `act drag` (客户机会话里目标在另一个窗口时, 用目标窗口原点加目标元素 rect 中心算出屏幕坐标 `"x,y"` 发出, 因为源进程量不到别的进程里的元素). `expect` 重试到超时 (默认 5 s), 要一个元素的断言在零个
  或多个时一直等; `toHaveAttribute` 在父元素下 `query('*')` 带属性找回自己. 语义树的限制在 libacde: `opacity: 0` 算不可见, `getByText` 找的是无障碍名字,
  `<select>` 下拉框是 `combobox` (值是选中项, 打开时下面有 `option`), 列表框是 `listbox` (看得见的行是 `option`); 选值用 `selectOption`
  (走 `act select`, 不经弹出的列表), `click()` 走真的输入, 会打开下拉列表.
  CSS 找到的元素 (`locator`、`getByTestId`、`getByPlaceholder` …) 带 `visible`, 看不见的也算匹配 (和 Playwright 一样): `toBeVisible` /
  `toBeHidden` / `isVisible` / `waitFor({state})` 看 `visible`, 动作等元素看得见 (`Locator.line` 标 `[hidden]`); 语义树里的都算看得见.
  组合: `filter({hasText, hasNotText, has, hasNot})` (`has` / `hasNot` 是另一个 Locator, 在每个元素里面求, 它的 scope 不算)、`or(另一个)`
  (两边的并集, 按文档顺序)、`and(另一个)` (交集). `locator.evaluate(函数或源码, arg)`: 在页面里以 `(元素, arg)` 调用 (`eval` 带 `node`).
  断言还有 `toHaveClass` / `toHaveCSS(属性, 值)` (computed style) / `toHaveJSProperty` / `toBeEmpty` / `toBeEditable` / `toBeInViewport({ratio})`,
  都是在页面里求值再比, 同样重试.
  输入: `click` / `dblclick` / `hover` 收 `modifiers` (`Shift` / `Control` / `Alt` / `Meta` / `ControlOrMeta`), 变成 act 的 arg (`shift+ctrl`);
  `ControlOrMeta` 在所有宿主上都是 `Control` (libacde 对页面呈现统一的 Linux 环境, 编辑快捷键是 Ctrl).
  `AppWindow.mouse` (`move(x, y, {steps})` / `down` / `up` / `click(x, y, {button, clickCount, modifiers})` / `dblclick` / `wheel(dx, dy)`, 记着位置)
  和 `keyboard` (`down` / `up` / `press("Control+a")` / `type` (有键的按键, 别的走 `text`) / `insertText`) 用页面的 CSS 坐标, 发 `input`.
  `AppWindow.clock` (`clock.ts`): `install({time})` / `pauseAt` / `fastForward` / `runFor` / `resume` / `setFixedTime` / `setSystemTime` / `state`,
  时间是 ms、Date 或日期字符串, 时长是 ms 或 `"mm:ss"` / `"hh:mm:ss"` (语义见 libacde 的 `clock`). 对话框: `answerDialog({accept, text})`
  事先答复下一个, `waitForDialog({type})` (要在触发之前调用) / `dialogs()` 读 console 里的 `dialog` 条目. `addInitScript(code, {once})`
  (按应用 id 登记, 重开也在)、`reload()` (先在页面里放个记号, 等新页面没有它且 `readyState` 是 complete)、`resize(w, h)` (等 `innerWidth` /
  `innerHeight` 变过去)、`seedLocalStorage(键值)` (一次性的 init 脚本写进去再 reload; 不碰存储的文件格式).
- **截图** (`png.ts`, `screenshot.ts`): `Png` 只用 `node:zlib`: 解所有颜色类型、位深、tRNS、Adam7 (16 位按 /257 取整到 8 位), 编 RGBA (Sub 滤波); `diff` 照
  pixelmatch (YIQ 距离, 阈值默认 0.2, 抗锯齿的边不算, 差的画红). 窗口截图含窗框, 比例是 PNG 宽 / 窗口宽; 元素截图按 rect 减窗口原点乘比例裁;
  `mask` 涂品红. `toHaveScreenshot(名字?, {maxDiffPixels, maxDiffPixelRatio, threshold, mask, timeout})`: 连拍到两张一样才比, 不过就重拍到超时;
  没有基线就写 (`CI` 设了时报错), `Screenshots.context.update` 时重写; 不过时把 `-actual` / `-expected` / `-diff` 写进结果目录 (driver 单用时在基线旁).
  基线: acdev test 里是测试文件旁的 `__screenshots__/<文件名>/<名字>-<平台>.png` (不给名字是 `<测试名>-<序号>`), 单用 driver 时名字要是 .png 路径.
- **trace** (`trace.ts`): `acde.trace` 记每个动作和断言 (Locator / AppWindow 的方法、`expect`、`open`、`route`、`choose*` …; 嵌套的只记最外层) 的
  标题、耗时、结果; `screenshots` 开着时每步之后拍整屏. `write(dir)` 写 `trace.txt`, 有截图时再写 `trace.html` (自带的查看页) 和 `trace/NNN.png`.
- **MCP** (`src/mcp.ts`, `@modelcontextprotocol/server`): 31 个工具 (`doctor` / `doctor_fix` 见 `acde-doctor.md`, 其余建在 driver 上) (含 `route` / `unroute` / `clipboard`, `act` 的 drag / select,
  `input` (原始鼠标键盘)、`clock`、`dialog` (答复下一个并列出已有的)、`resize`, 这四个在 `src/mcppage.ts` 的 `PageTools.register`, 经
  `PageToolsHost` 用 `Mcp` 的会话和结果);
  `permissions` / `answer {allow, prompt? | app? + capability?}` / `revoke {app, capability}` 和命令行的批准命令共用 `Approvals`, `answer` / `revoke` 标成 destructive (`answer` 带 `allow: true` 时必须给 `app` 和 `capability`, 不认只给 id 或什么都不给: 批准替的是用户的回答, 而且决定是持久的, 所以批准了什么要写在这次调用里, 客户端问用户时看得见; 拒绝不要求)
  (它替用户做决定), `prompt` 和 `app` / `capability` 不能同时给; `query` 的输出是 `Format.matches`; `clipboard` 在宿主上有窗口的会话里碰的是用户的系统剪贴板, 要 `system: true` 才做 (headless 和客户机会话 `--session vm` 用自己的剪贴板, 不要; `Mcp.clipboardRefusal`), 标成 destructive / openWorld 让客户端先问) (`start` / `stop` / `logs` 是自己起 `acdev dev` 的). stdout 只走协议.
  会话: 钉住的 (`--session`、`sessions {use}`), 否则 `start` 起的, 否则按工作目录挑 (每次调用前看 IPC 断没断). stdin 关闭或收到信号时停掉 `start`
  起的 (在途的工具调用随连接关闭失败, 不再等 acdev runtime 回答; 进程随后自己退出). 工具出错回 `isError`, 不抛协议错误. 正在用的会话断了之后的下一次调用说它停了: `start` 起的报
  `the acdev dev started here (pid N) stopped; last output: …` (只报一次); 接上去的先等它的会话文件消失 (最多 `Mcp.DELISTED_MS` 2 s, 免得又挑中
  正在退出的那个), 再照常挑, 挑到别的会话 (比如用户重起的 `acdev dev`) 就接着用, 挑不到时报 `acdev dev N stopped; <挑会话的错误>`.
- **e2e** (`src/e2e/`): 文件 `*.e2e.{ts,tsx,js,mjs,mts}` (普通 `bun test` 匹配不到, 不会起 acdev runtime), 从 `acdev/test` 导入. 每个测试一个新 `acdev dev`
  (`E2eRun`), 隔离: 临时 `HOME` 和 `XDG_*`、`ACDE_STORAGE` 空、`ACDE_SIZE=1280x800`、浅色、减少动画、不跑 autostart, 构建进 `.acde/test`. 失败时在
  `<results>/<文件>/<测试>/` 留证, 用和 `acdev evidence` 同一份代码 (`Evidence.write`, 见上面「留证」): `error.txt`、`output.log`、`screen.png`、`webs.txt`、`snapshot.txt` 和 `windows.json`、`console.txt`、`network.txt`、`manifest.json` (客户机里 `--vm` 时再加从测试开始起的 `journal.txt`), 再加 `trace.txt` (截图比对的
  `-actual` / `-expected` / `-diff` 也在这). `--trace` 每个测试都留 `trace.html`; `-u` / `--update-screenshots` 重写基线. `TestRunner` 每个文件一个
  `bun test` 子进程, 设置走 `ACDE_TEST_*` (`settings.ts`); 默认 headless、每个测试 60 s. 结果按次存档 (AC/acdev#115, `archive.ts`): 每次运行在 `.acde/test-results` 下建 `<UTC 时间>-run` (`Evidence.folder`, 不覆盖), 这就是 `<results>`; 建之前删掉不是这种名字的旧布局和更早的运行, 连同这次只留最近 `KEEP_RUNS` (20) 次 (按名字即按时间, 从旧到新删); 一次运行什么都没留下 (全部通过) 时把它的目录删掉, 不占名额.
  **`--vm`** (工单 19): 用例跑在 `acdev vm` 客户机里登录着的会话里, 不起 `acdev dev`. 开跑前经 acdevd 以 root 跑一段脚本 (`src/vm/guest.ts`):
  从 logind 取 seat0 活动会话的用户和 HOME, 用 `chpasswd` 把密码设成 `ACDEV_VM_PASSWORD` (默认 `dopame-dev`, 给锁屏页的用例),
  `faillock --user <用户> --reset`; 没有活动会话时报错. 一次只跑一个文件, 所有用例接同一个会话 (`Acde.attach({session: 'vm'})`),
  `home` 是那个用户的 HOME (`ACDEV_TEST_GUEST_HOME` 传给测试进程), acdev 不替用例清它; 用例开头自己清状态. 不能和 `--desktop`、`--headed` 同用.
  测的是客户机里已经装好的东西, 宿主上不需要 acde 工程: 测试文件 (或目录) 不在任何 acde 工程里时, 工程按它自己所在的目录 (给的是目录时就是
  那个目录) 算, 其余用默认值; 在工程里时照常用工程 (`TestRunner.suites` 的 `standalone`). 宿主模式仍要求工程.
  **汇总** (一行, acde#85, `TestRunner.summary`): `acdev test: N tests in M files: P passed, F failed[, S not run (skipped, todo, or not
  matched by -t)]`, 再按需接 `; failed: <文件>`、`; not counted: …`、`; <n> files skipped (no test matches -t)`、`; <n> files not run (--bail)`;
  M 是有报告的文件数; 一个文件都没有报告时开头是 `<n> files ran`. `acdev test:` 有失败时红, 否则绿. 测试数取自
  bun 的 JUnit 报告: 每个文件的 `bun test` 加 `--reporter=junit --reporter-outfile <临时文件>` (实测 bun 1.4.4: 终端输出不变; 根元素
  `<testsuites tests failures skipped>`, `skipped` 含 skip、todo 和 `-t` 没选中的; 钩子失败算一个 `(unnamed)` 的失败用例), `TestRunner.tally`
  只读根元素的这三个属性: 跑了的 = tests − skipped, 通过 = 跑了的 − failures. 不解析 bun 给人看的输出. 文件加载就出错 (顶层抛错) 或进程被杀时
  bun 不写报告 (实测), 这样的文件不计数, 点名: `; not counted: <文件> (bun test left no report: the file did not load, or its run was killed)`.
  被 `-t` 整个跳过的文件不计.
  `-t`: 子进程把登记的、名字匹配 `-t` 的、真正跑了的测试写进 `ACDEV_TEST_MARKS` 指的文件 (`E2e.mark`); 登记过测试却一个也没匹配、一个也没跑的文件
  算跳过 (bun 对这种文件退出码非 0), 不算失败; 所有文件都跳过时报 `no test matches -t` 并退出 1. 匹配按 JS 正则只看测试自己的名字, 正则无效当匹配
  (只会少算跳过; describe 名匹配时 bun 会跑, 有 `ran` 也不算跳过).
  启动 `acdev dev` 的限时是测试限时减 3 s (至少一半, `E2eRun.startTimeout`), 起不来时报的是 `Acde.launch` 的原因和输出 (`LaunchError`, 见 driver),
  不是 bun 的超时; 这时没有会话可问, `keep` 留 `error.txt` 和 `output.log` (`LaunchError.logs` 里那个 `acdev dev` 的全部输出, 和失败的测试一样最多
  `Logs.KEEP` 行).
  **测试限时由 acdev 自己执行** (`E2eRun.within`): 测试体和从测试开始算的限时赛跑, 到点抛 `TimeoutError: the test did not finish within <ms> ms
  (its timeout: --timeout, or the one given to test())` (`TestTimeout`), 照常走 `keep` 留下失败现场, 再 `close()`; 交给 bun 的限时是测试限时加
  `GRACE_MS` (30 s), 留给保存和关会话. 原因 (在真的工程和 acdev runtime 上复现过): bun 到点就放弃这个测试并杀掉它起的子进程 (`killed 1 dangling process`),
  文件里最后一个测试超时时进程随即退出, `catch` 里的 `keep` 来不及跑, `.acde/test-results` 什么都没有. `keep` 向 acdev runtime 要截图、快照、console、network
  这几步合计最多 `KEEP_MS` (15 s, 每步 `E2eRun.within`), acdev runtime 不答时写 `<文件>.error.txt` (`not saved: …`), 不把宽限期耗在 `DevClient` 的 30 s 上.
  `--workers N` 同时跑几个文件 (默认核数的一半, 最多 4; `--headed` / `--bail` 时 1): 每个 worker 构建进自己的目录 (`.acde/test`、`.acde/test-2` …,
  `ACDEV_TEST_OUT`, 否则同一工程的几个文件互相覆盖构建产物), 输出按文件攒着, 跑完一个打一段. `--retries N`: 失败的测试换个新的 acdev dev 再跑
  (后来过了就打 flaky; 每次尝试各留一份: 第一次在 `<测试>/`, 第 n 次在 `<测试>.attempt-n/`), 每次尝试各有自己的测试限时 (`E2eRun.run` 的 deadline), 交给 bun 的是 (限时 + `GRACE_MS`) × 次数. `--video` (= failed) 失败的测试留 `video.png` (`Video`: 每秒 4 次 `screen`,
  和上一张一样的不要, 最多 600 张, 拼成 APNG, `Png.animate` 只搬 PNG 的块不重编码), `--video=on` 每个测试都留; 失败时停录像最多等
  `VIDEO_MS` (5 s, 在 `keep` 之前, 两者都在宽限期里), 录像在 `acde.close()` 之后才收尾 (会话关了录像的循环才一定结束).
  `test(名字, 函数, 选项)` 和 `test(名字, 选项, 函数)` 都行; 选项 `{timeout, size: [w, h], localStorage: {…}}`: `localStorage` 先
  `seedLocalStorage`, `size` 再 `resize` (算在测试限时里). `-t` 的记号 (`E2e.mark`) 照旧: 登记时一次, 跑时一次 (重试不重复记), 每个文件的
  记号文件和 junit 报告按文件序号取名 (并行时 `ran` 的计数对不上). `expect.poll(读值的函数, {timeout}).toBe(…)` 重试 bun 的匹配器; `expect.soft(…)` 失败只记下,
  测试结束时一起报. `acdev/test` 的 `test.only` / `skip` / `if` 用到时才取 bun 的 (bun 在 `CI` 设了时一碰 `test.only` 就抛).
  **解析 `acdev/test` / `acdev/driver`**: 用户工程不依赖 acdev, bun 的插件 (`onResolve`) 管不到静态 import、也不认 `NODE_PATH`, 所以每个工程在临时目录写一份
  tsconfig 给 `bun test --tsconfig-override` (`tsconfig.ts`): `extends` 工程最近的 tsconfig.json, `paths` 是它自己的 (顺着 `extends` 链取最近定义的
  `paths` 和 `baseUrl`, 换成绝对路径; 链上可以是相对路径、数组、包) 加上这两个模块, 指向跑测试的这个 acdev (`packageRoot()`, 打包后也对),
  所以 CLI 和 driver 总是同一个版本. 编辑器里的类型还得工程自己装.

**客户机会话里页面没了** (2026-11-20): 不带 ref 的 snapshot、webs、query、console、network、permissions 由管家交给当时的前台进程; 这个进程恰好在请求途中退出 (比如测试刚杀了它) 时回 `the page went away`. driver 对这几种只读请求在客户机会话里再问一次, 这时管家会换一个进程回答; act、eval 这类有副作用的不重试.
**页面暂时不在** (2026-11-23, `npm/src/driver/gone/`): 管家找不到页面时不转发请求, 直接回 `<op>: no page <web>` (acdes 的桌面进程崩溃或连接先断后由会话重新拉起, 热客户机上 1 到 3 秒,
没有 GPU 的客户机冷启动更久); 宿主窗口的页面还没起来时 shot 回 `window N has no page`. 这两种请求都没送到页面, 所以 driver 对所有请求 (含 act、eval) 每 200 ms 再发一次,
最多等 20 秒 (`Gone.WAIT_MS`), 超过时报原来的错并写明等了几秒、页面没回来. 上面那条"再问一次"也在同一处 (`Gone.ask`): 只对客户机里的只读请求、只问一次;
送到页面之后失败的 act、eval 不重发. 原来 screenshot 自己等 5 秒的循环并进了这里.
