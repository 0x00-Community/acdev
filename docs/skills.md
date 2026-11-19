# Skill 与文档 (`skills/acdev/`, `scripts/skill.ts`, `src/skills.ts`, `src/agents.ts`, `install.md`)

> 路径相对 CLI 包根 `npm/`。

对外的说明只有一份来源: `skills/acdev/`, 一个 [Agent Skills](https://agentskills.io/specification) 格式的 skill. 它随安装包发给用户的编码 agent
(`acdev skills install`), docs.dopame.ai 的英文页也由它生成 (www 仓库 `docs/scripts/skill-sync.ts`, 一个 reference 对一页:
`references/guide/files.md` → `/guide/files/`; 中文页在 www 里照英文翻译). 所以:

- 命令、参数、配置字段、清单、`acde:` 模块、测试 API、MCP 工具、对外可见的行为变了, **同一个提交里改 skill**. 不去改 www 里生成的英文页
  (那边的检查会拦). libacde 一侧的变化 (模块、平台差异、Web 兼容性) 也改在这里.
- skill 只写对外的用法 (怎么用、会看到什么), 不写实现; 实现和取舍写在本仓 `docs/` 的对应文件.
- skill 里引的输出要是工具真的打出来的, 按它出现的场合逐字引 (2026-11-11 对着 acdert 0.0.9 加当天宿主层的修复重跑过, macOS, headless): 拒绝必需能力时
  单应用的 `acdev dev` 日志是 `acdert app <id>: <名字>: "<能力>" is denied by the user; acdert app asks for it again the next time it runs`, 桌面里
  `apps.open()` (触发提示的那次和之后每一次) 以 `<名字>: "<能力>" is denied by the user` (403 `denied`) 拒绝, 不再有 `<名字> needs "<能力>" (denied by
  the user)` (404) 这一句; `needs "…" (…)` 只剩平台没有和服务没跑两种 (404 `unsupported_app`). 要批准的能力按状态分开说 (`acde:capabilities` 的
  `not-asked` / `asking` / `available` / `denied`): 被批准挡住的调用都是 403 带 `capability`, `code` 是 `not_asked` (`… is not asked for yet; ask for it
  with acde:capabilities request("…")`)、`asking` (`… is waiting for the user's answer`) 或 `denied` (`… is denied by the user`); 可选模块的动态
  `import()` 以同样三句拒绝 (前面是 `acde:<模块>: `), 拒绝的是 `AcdeError` (`code: 'forbidden'`、`status: 403`、`module`; 提供它的服务停了时是
  `service_not_running` / 503, 见 libacde `src/host/modules.rs` 的 `import_error`), `load()` 只给 `null`.
  **摄像头和麦克风** (`reference/web.md`): 用运行时的假设备 `ACDE_CAPTURE=fake` 验的 (`Fake camera` / `Fake microphone`, `reference/env.md` 列了它):
  可选的由 `getUserMedia()` 自己触发提示 (先麦克风后摄像头), `permissions.query` 没答之前是 `prompt`, 拒绝或撤销后 `denied`. 「批准之后回答的是系统
  自己对设备的权限」这半句照 libacde 的 `permits.ts` 写 (批准后转给原生的 `permission()`), 本机上假设备和真设备看到的都是 `granted`; macOS 系统自己的
  授权对话框没验. 撤销不会结束已经在跑的轨道 (实测 `readyState` 仍是 `live`), skill 没写这一条.
  **不能最小化的窗口**: 单应用会话的主窗口在 macOS 的宿主窗口和 headless 上验过 (`minimizable` 假、`minimize()` 409 `unavailable`、
  `act w1 minimize` 退出 1), skill 只写这两种; Linux 宿主和 Windows (宿主自己有控件) 没验, 没写.
  `inspect --find` 的窗口行是另一种格式 (`w1 notes "Notes":`, 桌面 `w0 desktop:`). `inspect --all` / `--find` 跳过的是窗口行标了
  `[minimized]` 的窗口, 即不在屏幕上的窗口: 状态是 `minimized` 的 (`act w1 minimize`、页面的 `minimize()`、桌面的 `requestState`), 和桌面
  `windows.hide()` 藏起的. 判断在运行时 (libacde `inspect.ts` 的 `Inspect.#offScreen`), acdev 原样打它的文字: 窗口表里这样的窗口 `hidden` 为真
  (`state` 是运行时的状态), 点名它时树是空的加一行 `(minimized; act restore on it to see its elements)`, 对它的指针动作回
  `w1 is minimized; act restore on it first` (退出码 1), `query` 照样找它的元素但 `visible` 为假 (`Format.matches` 标 `[hidden]`), `act w1 restore`
  让它回来. 所以 driver 的 Locator 在最小化的窗口里一个元素都找不到 (按角色的走语义树, 按 CSS 的只留 `visible` 的), `restore()` 之后又有.
  (2026-11-11 libacde 的 `fix(inspect): mark a window the runtime minimized` 之前运行时只看隐藏标记: 宿主窗口会话里 `act w1 minimize` 后窗口
  没有标记, `--all` 照列, Locator 照样找得到.)
- 窗口 ref 的 `fill` / `fullscreen` (acde#65, 运行时 acdert 0.0.9 起, 提交 0bfaafa): `ACTIONS`、帮助的 `WINDOW_ACTIONS`、MCP 的 act 说明、
  `AppWindow.fill()` / `fullscreen()` 都有; `restore` 把这两种状态设回 `normal`. 桌面和铺满宿主的窗口 (单应用会话) 由运行时拒绝, acdev 照转原因.
  `acdev check` 的错误里应用 id 有的带引号有的不带 (`app "notes":` / `app notes:`), 两种都出自 SDK (`Manifest.check` 带, `Manifest.app` 不带), 文档照实.
  **Windows 上的后端**: skill 现在写「能跑」, 依据是两边的源码和说明 (`docs/contract-with-libacde.md` 的「Windows 后端契约」、libacde AGENTS.md 同名一节和它的验收脚本
  `scripts/check-backends.sh`), 没有在 Windows 上重跑; `tools.md` 里 cmd 的引号写法 (`\"`) 也只是按 MSVC 的命令行规则写的, 没在 Windows 上试.

**结构**

```
skills/acdev/SKILL.md                    入口: frontmatter (name、description) 加正文
skills/acdev/references/<组>/<页>.md     组是 start / guide / reference; 路径就是文档的地址
```

- `SKILL.md` 的 `description` 决定 agent 什么时候载入它: 写「做什么」和「什么时候用」, 带上会出现的词 (acdev、libacde、Dopame OS、
  `acde.config.jsonc`、`acde:` 模块). 正文是 agent 每次都读的, 只放: 先查环境 (acdev、运行时)、和浏览器不一样的地方、工作循环 (建、跑、看、测)、
  规则, 最后一节 `## References` 列出全部 references. 这一节里的顺序就是文档侧栏里的顺序. 细节一律放 references, 按需读.
- 一个 reference 讲一件事, 单独读得懂 (agent 多半只读其中一个); 示例要是真能跑的命令和代码.

**写法规则** (`scripts/skill.ts` 的 `skillProblems()`; `bun scripts/skill.ts` 单独跑, `bun test` 和 `scripts/dist.ts` 都跑, 不过就不出包):

- `SKILL.md`: frontmatter 只有规范里的键 (`name`、`description`、`license`、`compatibility`、`metadata`、`allowed-tools`), 每个值写在一行;
  `name` 是目录名 (小写字母、数字、单个连字符, ≤ 64); `description` 1 到 1024 字符; 全文 ≤ 500 行.
- reference: 英文; 路径 `references/<组>/<页>.md`, 两段都是小写连字符; 第一行 `# 标题` 加一个空行 (就是文档页的标题), 没有 frontmatter,
  没有第二个一级标题; 只用普通 Markdown: 代码之外没有 HTML / JSX 标签、`:::` 指令、MDX 的 import / export; LF, 末尾恰好一个换行.
- 链接: 指向 skill 里别的文件时写相对路径到 `.md` 文件 (reference 之间 `../guide/files.md#errors`, `SKILL.md` 里 `references/guide/files.md`),
  不写站点根路径 (`/guide/files/`), 不写 `https://docs.dopame.ai/…`; 目标文件要在, `#锚点` 要是目标里某个标题的 slug (GitHub 的算法:
  小写, 去掉标点, 空格换 `-`). 每个 reference 都要列在 `SKILL.md` 最后的 `## References` 一节里.
- 和代码对得上 (`test/skills.test.ts`): 用法文字里的每个命令和每个 `--参数` 都出现在 `references/reference/cli.md`; `src/mcp.ts` 注册的每个工具都出现在
  `references/guide/mcp.md`. 加命令、加参数、加工具而没写进 skill, 测试就红.

**`acdev skills`** (`src/skills.ts`): 不带动作是 `status`, 另有 `install`、`remove`、`path`.

- skill 在哪: `Skills.SOURCE` 是 `cli` 上一级的 `skills/acdev` (检出时是仓库里的, 安装后是 `lib/acdev/skills/acdev`). 链接的目标是 `Skills.stable()`:
  全局安装时换成经 `<安装根>/current/` 的路径, 所以升级 acdev (换 `current`) 后装过的链接自动指向新版本的 skill.
- 装到哪 (`src/agents.ts` 的 `Agents.all()`): 一张表, 每行是 agent 的 id、名字、全局 skills 目录、「有这些目录之一就算装了这个 agent」的目录.
  表取自 [vercel-labs/skills](https://github.com/vercel-labs/skills) 的 `src/agents.ts` (MIT, 2026-11-10 的版本), 含它认的环境变量
  (`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`XDG_CONFIG_HOME` 等). 第一行 `agents` 是 `~/.agents/skills` (Codex、Cline、Zed 等共用的约定目录), 总是装;
  其余只装检测到的. 同一个目录的几行并成一处. `--agent a,b`: 只装这些, 不管检测没检测到; `--dir D`: 只装进 `D/acde` (表里没有的 agent, 或工程自己的
  `.agents/skills`). 要支持新的 agent 就在表里加一行.
- 怎么装: 默认建链接 (Windows 上是 junction, 不要权限), `--copy` 拷贝 (拷贝不会跟着升级, 升级后重跑). 都是先做成 `acde.new-<pid>` 再换上去.
  目的地已有 `acdev` 时: 是链接就换; 是目录且 `SKILL.md` 的 `name` 是 `acdev` 才换 (旧的拷贝); 别的一律报错不动 (`not the acdev skill`),
  一处不行就一处都不装.
- `status` 每处一行: `link` / `copy` 加 `current` (链接指向这份 skill; 拷贝逐文件字节相同) / `outdated` / `broken` (链接的目标没了),
  检测到 agent 但没装的写 `not installed`, 同名但不是这个 skill 的写 `another skill`. `remove` 只删认得出是 acdev skill 的 (和断掉的链接).
- `install` 建 skills 目录时 (`mkdirSync` 递归, 返回建出的第一层) 把它新建的每一层记进 `<XDG_DATA_HOME 或 ~/.local/share>/acde/skills.json`
  (`{created: [绝对路径]}`); `remove` 删掉 skill 后从那一处往上, 只删记过且已空的目录, 删了就从记录里去掉. 用户原有的目录 (没记过的) 和
  里面还有别的东西的目录都不动. 记录放 acdev 自己的数据目录, 不在 agent 的 skills 目录里留文件.

**`install.md`** (仓库根的 `scripts/`, 发布到 `https://pkgs.dopame.ai/acdev/install.md`): 写给 agent 的安装步骤. 用户只要把一句话交给自己的 agent:
`Read https://pkgs.dopame.ai/acdev/install.md and follow it to set up acdev on this machine.` 步骤是: 查 Bun / Node.js、跑安装脚本、确认
`acdev` 能跑、`acdev skills install`、`acdev doctor` 查一遍 (找到的运行时、它的 GPU 自检等; 安装器已把配对的 acdev runtime 装在 acdev 旁边; `acdev runtime` 那项是错误时先重跑安装器, 安装器在这台机器上用不了时才问用户, 同意了只照 skill `start/install.md` 的「Install the runtime by hand」从 pkgs 装, 不编、不找别的来路)、建一个工程 check 和 build 再 `acdev dev --headless`
截图、汇报. 步骤放在这个文件里而不是 prompt 里, 改步骤不用改用户手里的那句话. 安装脚本的行为、`acdev skills`、运行时怎么找变了, 这个文件一起改;
要验证时在临时 `HOME` 里照着走一遍 (`ACDEV_DIST` 指向本地 `dist.ts --out` 的目录).
