# acde

acde 的开发者 CLI, 是 [acdebin-dbg](http://gitea.dopamine/AC/acdebin-dbg) 仓库的 `npm/` 子包 (原 gitea AC/acde-cli, 连历史并入); TypeScript,
跑在开发者已有的 bun ≥ 1.4 或 Node.js ≥ 22.3 上. 测试 `bun test`, 类型检查 `bun run typecheck`.

仓库规则 (第一原则、不写注释、只用英文输出、bun 和 Node 两边都跑、改对外行为同一个提交里改 skill、提交与推送) 和文件路由都在仓库根的
`../AGENTS.md`, 每次都先读它; CLI 的细节在 `../docs/` (`cli-*.md`、`acde-*.md`、`devtools-driver-mcp.md`、`release-distribution.md`、
`skills.md`、`contract-with-acdert.md`), 文件里的路径相对本目录.
