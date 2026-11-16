# 发布作业只在 debian12 runner 上跑, 产物传 S3 `dopame-pkgs`

用户定 2026-11-13: 发布工作流的 Linux 作业都在 `node:22-bookworm` 容器里跑, `runs-on` 一律 `debian12`, GitHub 上也是, 不用任何 Ubuntu runner.
用户定 2026-11-12: 产物从腾讯云 COS 改回 S3 桶 `dopame-pkgs` (经 CloudFront 发到 `https://pkgs.dopame.ai`), 上传凭据是角色
`dopame-acde-release`. 详见 `docs/release-distribution.md` 的「发布」.
