# 要做 (CLI)

1. 框架工程用框架自己的 `build --watch` (热重载 `reload {hot: true}` 已经发了, 见 `acde-dev.md` 的「热重载」).
2. `acde.config.jsonc` 加 `compatibility_date`、environments、vars / secrets、服务名 ↔ capability 的显式 binding.
3. `acdev types` (按 capabilities 生成 d.ts)、单元测试跑在 acdert 的 isolate 里、`acdev deploy --to <主机>`、包签名和仓库之后 `acdev publish`.
4. 分发: 发布流水线按 `release.yml` 建立 (见 `release-distribution.md`). 远端已有 `v0.0.5` 标签 (指向 `7ff42fc`), 它不是由新流程打的, 因此新流程不能再发布 `v0.0.5`, 要发更高的版本号. 首次正式发布前先用预演跑一遍.
5. 用户工程里 `acdev/test` / `acdev/driver` 的编辑器类型 (运行时 `acdev test` 已替它解析): 发一个只有类型的包, 或 `acdev new` 带上依赖.
6. e2e 在 CI 上跑 (要有 GPU 的 runner, 比如 GitHub 的 macOS runner).
