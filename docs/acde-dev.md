# acdev dev (`src/dev.ts`, `src/ipc.ts`, `src/sessions.ts`)

> 路径相对 CLI 包根 `npm/`。

- 一个工程、没有 `--desktop`: 桌面工程起 `acdev runtime desktop <id>`, 应用起 `acdev runtime app <id>` (`--app` 挑). 几个工程或给了 `--desktop`: 都构建进
  各自的 `.acde` (不许 `--out` / `--app`), 起 `acdev runtime desktop <D>`: `--desktop` 的值, 否则其中唯一的桌面工程, 否则 `dopame` (全局装的带着).
  `--desktop` 的值像路径 (含 `/`、`.` / `..`) 或当前目录下有同名工程时当作又一个工程 (要恰好一个桌面). 两个工程有同一 id 报错.
- 契约级别: 构建后、起 acdev runtime 之前跑 `acdev runtime --version`, 从 `(contract level N)` 取运行时级别 (没有这段的旧 acdert 算第 0 级;
  10 s 不退出就结束它, 同样算第 0 级). 有工程的 `apiLevel` 与它不同时报 `<名字>: needs level N, runtime is level M` 并退出 1,
  不起 acdev runtime; 所有工程都没写 `apiLevel` (旧的手写包) 时不探测. 重新构建后级别变得不符算构建失败, 不发 `reload`.
- acdev runtime 的 stderr: 默认经管道逐行转出, 只丢运行时自己的 info 及以下日志, 开发者的代码打的和关于应用的事都留下 (`DevSession.keeps`).
  运行时的日志行是 `<毫秒>.<3 位> <级别 E|W|I|D|T> <线程> <目标>: <消息>` (acdert `src/log`). 留下: 不是这种格式的行 (panic、多行消息
  的后续行)、任何目标的 `W` / `E`、目标 `js` 的任何级别 (页面的 `console.*`, 消息里没有页面名)、目标 `acdert::child` / `acdert::backends`
  里消息以 `[` 开头的 `I` 行 (后端和桌面服务进程的输出 `[<app>#backend] …` / `[<服务>] …`; 走 `spawnBackend` 的是 `acdert::backends`,
  走 `spawn` 的是 `acdert::child`; 不带 `[` 的是运行时自己的, 如 `removed …, left by an acdert that is gone`)、目标 `acde_host` 的 `I` 行
  (宿主讲应用发生了什么: 后端 `started (pid …, port …)` / `stopped`、重载后的 `acdev dev: state restored`、页面的 `alert:`、`waits for the user
  to allow "camera"` 这类待答的批准、`color scheme: …`), 但不含每次都有的生命周期行 (`DevSession.LIFECYCLE`: `startup: …`、`broker started (…)`、
  `ended (…), exit N` / `session <kind>, exit N`). 其余目标的 `I` (GPU、监听地址、`acdev dev: reload <id>`, acdev dev 自己打 `rebuilt …, reloading`)
  和各目标的 `D` / `T` 都丢. 宿主的行不带统一标记, 所以是按 acdert `web/packages/acde-host` 的 `Log.write(Level.Info, 'acde_host', …)` 逐条定的;
  那边加了每次启动都打的行, 要加进 `LIFECYCLE`. `--verbose` 时 stderr 直接继承, 什么都不丢. driver (`Acde.launch`, MCP 的 `start`、`acdev test`)
  总带 `--verbose`, 日志照旧完整.
- 环境: `ACDE_PATH` (所有构建结果加继承的; 不装)、`ACDE_DEV` (acdev runtime 要听的地址)、`--headless` 时 `ACDE_HEADLESS=1`.
- 没有显示 (`Runtime.noDisplay`: Linux 上 `WAYLAND_DISPLAY` 和 `DISPLAY` 都没有): 不带 `--headless` 的 `acdev dev` 和 `acdev test --headed`
  在构建前就报 `no display here (no WAYLAND_DISPLAY or DISPLAY): run acdev dev --headless` (test 说去掉 `--headed`) 并退出 1; 否则 acdev runtime 只报
  `acde_shell registry … Connection reset by peer` 和 libseat 的错 (gitea acde#43). 不带 `--headless` 的 acdev runtime 非零退出 (不是信号, 码 < 128) 时
  再补一行 `DevSession.WINDOW_HINT`. 测试的 `env()` 在没有显示的机器上补 `WAYLAND_DISPLAY=acde-test`, 假 acdert 照常起.
- 监听每个工程 (`TreeWatch.start`, `src/watch.ts`): macOS、Windows 用 `fs.watch(工程, {recursive: true})`; Linux 上递归监听挂在文件的 inode 上, 原子保存 (写临时文件再改名盖过去, vim、JetBrains、`sed -i`、`git checkout`、多数编码 agent 都这样) 之后新文件不再被监听 (acde#88), 所以改为每个目录一个 非递归 `fs.watch` (目录的监听按名字报子项, 不受换 inode 影响): 起步时遍历, 跳过名字在 `SKIPPED` 里的目录和 `--out`; 事件里出现的目录换了 inode 或新建时重新遍历挂上, 并把里面已有的文件当作改动报出; 删掉的目录摘掉. 再往下的过滤一样: 跳过路径里任何一段在 `SKIPPED` (`src/paths.ts`, 含 `__screenshots__` / `__snapshots__`) 的、e2e 测试文件、只是目录的事件、`--out` 目录和嵌在里面的别的工程 (acdev test 写基线时不能把应用重载掉); 150 ms 合并, 一次构建一个, 只重建改了的那个 (重读配置),
  给它的每个应用发 `reload {app}`, 它是在跑的桌面时再发 `reload`. 构建失败只打一行.
- **热重载** (`src/changes.ts`, 运行时一侧见 acdert 的 `docs/dev/dev-ipc.md`「热重载」): 每次构建后给运行时加载的文件拍快照
  (`Changes.snapshot`: 相对路径 → SHA-256, HTML 先去掉 `<script>` / `<style>` / `<link rel=stylesheet>` 再算, 不看 `node_modules`、`.git`、`.acde`),
  和上一次比 (`Changes.reload`): 变了的全是 `.css` / `.js` / `.mjs` / `.map` 且不在后端目录或服务模块里 (`Served.fixed`) 时发
  `reload {app, hot: true}` (桌面 `reload {hot: true}`), 运行时能换的原地换、换不了自己整页重载; 别的变化照旧 `reload`.
  工程拍整个产物目录 (`.acde`); 手写的包 (`package.json` 的 `acdev`, 产物由仓库自己的脚本构建, 如 Dopame 的 `dist/`) 拍清单点名的目录
  (`Changes.served`: 桌面入口、`assets`、后端、服务所在的顶层目录, 加 `package.json`; 有落在包根上的就拍整个包), 这些目录即使叫 `dist` /
  `build` 也照样监听. 手写的包快照没变 (改的是 `src/` 这类源码) 时不重载, 等它自己的构建写出产物再比; 工程快照没变时照旧整页重载.
- **有窗口的会话不轻易退出** (`DevSession.#resilient`: 不带 `--headless`、不是测试会话): acdev runtime 以非 0 退出 (崩溃、被外面杀掉), 又不是
  acdev dev 自己转发信号让它停的, 就打 `acdev: acdev runtime exited (<码>); starting it again …`, 等 `REVIVE_MS` (1 s) 后删掉旧 socket 重新起它, 连上后照常
  `hello`、写会话文件; 已有的构建和监听沿用. 60 s 内第 4 次退出就放弃, 照旧以它的退出码结束 (`#revives`). 第一次起就没连上 (GPU、宿主文件、动态库) 不重起,
  照旧报 `exited (<码>) before it was ready`. 第一次构建失败时打 `acdev: build failed: …` 和 `acdev: waiting for a change to build again`, 监听工程, 有改动再构建,
  成功后照常起运行时 (`#firstBuild`). 页面报错、未捕获异常本来就只进日志; 之后的构建失败本来就只打一行、窗口留着上一次好的构建. 无头会话和测试会话照旧:
  运行时退出 acdev dev 跟着退出, 第一次构建失败直接退出, 给脚本、agent 和 `acdev test` 看到失败.
- **同时开有窗口和无头的两个会话**: dev socket (`<会话目录>/<pid>.sock`)、会话文件、后端的 socket 目录 (运行时按自己的 pid 分) 和 DevTools 端口
  (`127.0.0.1` 上系统挑的) 各自独立; 截图、调试工具、热重载在无头会话里走同一条 dev IPC, 和有窗口的一样. 同一个工程目录第二个 `acdev dev` 要
  `--force` (一个工程一个会话, 见下). 两个运行时共用的是用户目录下的状态: 网页存储 `$XDG_DATA_HOME/acde/storage` (`ACDE_STORAGE` 改根目录)、
  窗口位置 `$XDG_STATE_HOME/acde/windows.json`、文件夹授权 `$XDG_STATE_HOME/acde/grants/`、批准决定 `$XDG_CONFIG_HOME/acde/permissions.json`
  (不看 `ACDE_STORAGE`), 会互相改写. 给 agent 的那个会话照 `acdev test` 的做法 (`E2eRun.env`) 设 `ACDE_STORAGE=` (空: 前三样只在内存),
  要连批准决定也分开再设自己的 `XDG_CONFIG_HOME`. 推荐用户的有窗口会话跑主检出, agent 的无头会话跑各自的工作树: 目录不同就不用 `--force`,
  监听互不触发, 半成品也不会出现在用户屏幕上.
- acdev runtime 退出 acdev 跟着退出 (退出码跟它; 有窗口的会话崩溃时重起, 见上), acdev 的连接断了 acdev runtime 也退出. SIGTERM / SIGHUP 转给 acdebin-dbg. SIGINT (acde#91) 和 SIGTERM 一样:
  unix 上给 acdev runtime 发 SIGTERM (只发给 acdev dev 进程的 SIGINT, 如 pm2、编辑器任务面板、agent 发的, 以前被吞掉, acdev dev 一直不退),
  第二次中断发 SIGKILL; Windows 上 Ctrl+C 同时到 acdev runtime, 先等它自己退 `DevSession.INTERRUPT_MS` (2 s), 再按强制结束, 第二次立刻结束.
  unix 上 `DevSession.SAME_INTERRUPT_MS` (500 ms) 内的几个 SIGINT 算同一次中断 (从上一次算数的那个起算): 经 launcher 跑时 (`bun run acdev`、
  `bin/acdev.mjs`、`Cli.follow` 换运行时) launcher 把 SIGINT 转给子进程, 而终端的 Ctrl+C 发给整个前台进程组, 子进程自己也收到一份, 再加上
  转来的 (`Cli.follow` 时最多三份), 几毫秒内到齐; 人有意按第二次总在这之后. 只能靠时间分: Node 和 Bun 的信号处理拿不到发送者 (没有 siginfo),
  launcher 也分不出 Ctrl+C 和只发给它的 `kill -INT`; 让子进程另成进程组 (只收 launcher 转的) 会把它变成后台作业, 读终端时被 SIGTTIN 停住,
  交互的提示就坏了; 改转别的信号又改了其他命令收到的东西和退出码. Windows 上 launcher 不转 (没有发给单个进程的 SIGINT), 不合并.
- 一个工程一个会话 (acde#91): 另一个活着的 acdev dev 跑着本次的某个工程 (含 `--desktop <目录>` 那个) 时报
  `acdev dev <pid> already runs <目录>; stop it first (acdev stop --session <pid>), or pass --force to start another` 退出 1, `--force` 照样起
  (不认领、不查). 判断在 `run()` 开头、构建之前 (`DevSession.#claim`): 先认领, 再看会话文件.
  - **认领** (`Claims`, `src/sessions.ts`): 以前只在开头列会话, 而会话文件要等构建、起 acdev runtime、连上之后才写, 同时起的两个都看不见对方, 都跑了.
    现在每个工程 (真实路径, Windows 小写) 在会话目录里有一个认领文件 `<sha256 前 16 位>.claim` `{pid, dir, beacon}`: 先写
    `<名>.claim.<pid>.tmp` 再 `link` 过去 (已存在就 `EEXIST`, 原子的排他创建, 内容一出现就是完整的), 几个工程按文件名排序逐个认领 (同时起的两个
    不会各占一半), 有一个被占就放掉已认领的并报占着它的 pid 和目录. 退出时 (`run()` 的 `finally`, 包住构建) 只删内容还是自己那份的.
  - **谁还活着**: 认领者先在 `beacon` 上听 (`Claims.beacon`: unix 上 `<会话目录>/<pid>.<开始时间 36 进制>.sock`, Windows 上
    `\\.\pipe\acde-dev-<pid>.<开始时间>`; `unref`, 来连接就关掉). 判断占着的人: pid 死了, 或连 beacon `ECONNREFUSED` / `ENOENT`
    (`Sessions.answers`) 都算死; 名字里有 pid 和开始时间, pid 被复用也连不上; 只要内核接受连接就算活, 不用对方的事件循环回答, 所以正在同步构建、
    事件循环卡住的认领者也算活. 连上、超时、别的错都算活 (拿不准不抢).
  - **抢死了的认领**: 不直接删 (两个进程都判它死了时, 后删的会删掉先到者刚建的新认领), 而是 `rename` 到 `<名>.claim.<pid>.aside`
    (只有一个进程挪得走这一份), 再看挪走的是不是自己判过的那份内容: 是就删掉再去 `link`; 不是 (别人已经抢过、建了新的) 就 `link` 回原处. 剩下的
    竞争只在三个进程同时抢同一个死认领、且第三个恰好在挪走与放回之间建了认领时: 被挪走的那个认领者以为自己还占着, 一个工程跑两个; 不阻塞, 接受.
    抢 `Claims.TRIES` (20) 次都没定下来报错 (`… keeps changing; run it again, or pass --force`).
  - **再看会话文件**: 认领之后照旧找跑着这些工程的活会话 (`Sessions.running`, `sameDir` 在 Windows 不分大小写, 返回所有这样的会话), 有就放掉认领并报它:
    `--force` 起的和旧版 acdev 起的会话不认领, 只能这样看到. 报之前先确认它真活着 (`Sessions.live`): `Sessions.list` 只看 pid (`kill(pid, 0)`), pid
    被别的进程复用时会话文件留着; 所以连一下各自的 `endpoint` (`Sessions.answers`, 最多 `PROBE_MS` 1 s; 只连上就断开, 不发东西), `ECONNREFUSED` /
    `ENOENT` 算死, 用 `removeIfCurrent` 删掉它的会话文件, 连上、超时或别的错算活 (拿不准不删). 会话文件是连上 acdev runtime 之后才写的, 活着的会话总连得上.
  - `acdev test` 的会话 (`Acde.launch({force: true})`) 用自己的输出目录, 带 `--force`, 不认领 (`--workers` 时同一工程同时有几个); 它们还是**测试会话**:
    `E2eRun.env` 设 `ACDEV_TEST_SESSION=1` (`Sessions.TEST_ENV`), `cli.ts` 见到它给 `DevOptions.test`, 会话文件写 `test: true`, 给 acdev runtime 的环境去掉
    这个变量; 测试会话不带 `--force` 时也不认领, 但照样查会话文件. 一个工程一个会话的判断 (`Sessions.running`)、按目录挑会话 (`Sessions.pick` 没给 pid
    的各支, 含"只有一个"和报错里的计数与列表) 和 MCP 的 `start` 都跳过测试会话 (它跑着时不挡 `acdev dev`, `acdev eval` 等也不会挑中这个转瞬即逝的
    会话); 只有 `--session <pid>` (MCP 的 `sessions {use}`) 到得了它. 只剩测试会话时报 `no acdev dev is running, only sessions of acdev test, which
    are reached only with --session <pid>` 并列出; `Sessions.what` 在它后面标 `acdev test`.
  - MCP 的 `start` 先看有没有活着的 (同样经 `Sessions.live` 确认) 会话**正好**跑着它要的 (`Sessions.wanted` 按 `acdev dev` 的规则把参数归一:
    `dirs` 默认工作目录、取真实路径, `--desktop` 是工程目录时取真实路径并算进 `dirs`, 否则是 id; 是不是工程目录由
    `Sessions.desktopProject` / `Sessions.pathy` 判, `DevSession.#desktopOf` 用的是同一条规则; `Sessions.runs` 比: `dirs` 作为集合相同、
    会话文件的 `options` (`acdev dev` 写的 `{desktop, app}`, 即它收到的 `--desktop` 归一后的值和 `--app`, 没给是 `null`) 相同、`headless` 相同;
    没有 `options` 的旧会话文件算不同): 有就先 `Acde.attach({session: pid})` 连上, 成功后才换掉原来接的、钉住它, 回 `attached to acdev dev <pid>,
    which already runs <目录>; it was started elsewhere, so logs and stop do not reach it (start {force: true} starts another)` 加 webs 表
    (agent 常忘了后台开着的会话, 不让它卡在报错上). 只是工程有重叠 (另一组工程、别的桌面或应用、有无 headless 不同) 时不接、不起, 报
    `acdev dev <pid> already runs <目录> (<Sessions.what>), which is not what start asked for; to use it, sessions {use: <pid>}; to start another
    beside it, start {force: true}; or stop it first (acdev stop --session <pid>)` (起了也只会被 acdev dev 拒绝); `force: true` 才另起 (带 `--force`).
    只有认领、还没写会话文件的 acdev dev (正在构建) 看不到, 这时起的 acdev dev 被拒绝, 报的是 `LaunchError` 里它的那行.
- 会话目录 (`Sessions.dir`): `$XDG_RUNTIME_DIR/acde-dev`, 否则 `$TMPDIR/acde-dev-<uid>`; `prepare` 建成 0700 后 `lstat`, 是链接、不是目录、
  不是自己的就报错 (防 `/tmp` 里别人先放的链接). 会话文件 `<pid>.json` `{pid, endpoint, dirs, apps, desktop, headless, test?, options: {desktop, app}, started}`: 起来后写、重建后重写、
  退出时删, 临时文件再 rename, 0600; 列的时候只认自己的普通文件, 删掉 pid (取自文件名) 死了的; 读不出来的文件 (正被改写) 再读一次, pid 还活着就跳过不删, 列表中途消失的文件也跳过;
  见到活着的写入者留下的 `<pid>.json.<写入者>.tmp` 也补上 `<pid>.json`. 已有的会话文件原地改写 (`Sessions.#rewrite`: `r+` 打开, 从头写,
  比原来短时用空格补齐, 不截断; JSON.parse 不在乎尾部空白), 只有第一次写才经临时文件 rename. gitea acde#97: btrfs 打开目录时记下当时最大的
  目录项序号, rename 覆盖给文件名一个新序号, 打开目录之后才改写的会话文件这次 readdir 就看不到 (110 上实测单遍约 1.5% 漏掉, 读三遍取并集仍会漏;
  tmpfs 不漏), 所以改写不能换目录项. 读不出来的文件最多读 `Sessions.READS` (3) 次, 每次隔 2 ms
  (gitea acde#87: 重载时改写会话文件, 旧版把读到一半的文件当坏文件删掉、或在两种错误里同时报“没有”和“好几个”). Windows 上 rename 碰上正在读的文件可能 EPERM / EBUSY,
  写会话文件时重试 (最多 20 次, 每次 5 ms). 工具和 driver 用 `Sessions.find` 挑会话: 挑不到时, 只在有会话文件正被改写 (`Sessions.scan` 的 `busy`: 有活着的写入者留下的临时文件, 或 pid 活着的会话文件读不出来) 时
  1 s 内每 50 ms 重列重挑, 到时才报最后一次的错; 根本没有会话文件时立即报错 (gitea acde#96: 以前没有会话时每个工具和 MCP 启动都白等 1 s);
  不在任何会话的目录里又有几个会话时报 `none of the N acdev dev sessions runs <目录>; pick one with --session <pid>`. acdev dev 被外部结束 (Windows 的 `taskkill /F`、
  任务管理器, 别处的 SIGKILL) 时来不及删, acdev runtime 因连接断开跟着退出, 文件留到下一个工具或下一个 acdev dev 列会话时删; pid 已被复用时连不上,
  报 `is gone` 并删. 列会话时也删 pid 死了的 `<pid>.sock`、beacon `<pid>.<id>.sock`、写一半的 `<pid>.json.<写者 pid>.tmp` 和
  `<名>.claim.<pid>.tmp` / `.aside` (acde#91), 以及认领者 pid 死了 (或内容读不懂) 的认领 (`Claims.sweep`, 同样挪开再删); pid 活着但 beacon 连不上的
  认领留给下一个认领这个工程的 acdev dev 去抢 (`list` 是同步的, 不连).
- dev IPC: **acdev runtime 听, acdev 不转发.** 地址 `DevClient.endpoint()`: unix 上 `<会话目录>/<pid>.sock` (acdev 先 `prepare` 目录、删掉旧 socket;
  acdev runtime 设 0600: 它能在页面里求值), Windows 上 `\\.\pipe\acde-dev-<pid>`. acdev dev 起了 acdev runtime 后每 50 ms 重试连接 (`DevClient.reach`; 10 s 还连不上
  就提示 acdev runtime 太旧), 连上发 `{type: 'hello', role: 'dev'}` 再写会话文件, `reload` 走这条连接. 一行一个 JSON; 工具和 driver 各自直连 acdev runtime 发
  `{type: 'request', id, op, ...}`, 唯一的超时在 `DevClient` (30 s). `DevClient.close()` 立即让在途的请求失败
  (清掉它们的 30 s 定时器), `end()` 后销毁连接 (最多等 1 s) 并 `unref`: Windows 的命名管道没有半关闭, 只 `end()` 时 acdev runtime 收不到 EOF,
  连接和在途请求的定时器会让进程一直不退 (gitea acde#50). op 见 acdert AGENTS.md 的「acdev dev」.
