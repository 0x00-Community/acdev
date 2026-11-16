# Windows 上的应用后端不开 TCP 监听和命名管道

## 状态

已采纳 (2026-11-09 定).

## 背景

Node 在 Windows 上不能用文件系统 AF_UNIX; 命名管道的默认安全描述符给 Everyone / 匿名读、也接受远端打开.

## 决定

Windows 上应用后端运行期间没有 TCP 监听、没有命名管道, 套接字文件只有 SYSTEM 和当前用户能开. node 走通道模式, bun 走套接字模式.

## 后果

这份契约和 acde 的「和 acdert 的契约」是同一份, 两边一起发版. 见 `docs/web/backend.md`「Windows 后端契约」.
