# 只有摄像头和麦克风要用户批准

用户决定 2026-11-11, 同浏览器: 只有 `camera`、`microphone` 在第一次 `getUserMedia` (或 `acde:capabilities` 的 `request`) 时问用户, 可撤销;
其余能力声明即有, 系统应用不问. 回答「否」只让这些调用失败, 应用照常启动、照常在列表里. 能力和批准是契约, 不是安全边界.
见 `docs/runtime/webs.md`「批准」.
