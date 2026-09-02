# Corresponding Source Code

Repository: https://github.com/AETAVK/linli-local-mail

本安装包对应的源码应位于上述公开仓库中。安装包版本取自 `package.json`，对应源码以同版本 Git 标签
`v<version>` 标记；例如安装包 `0.10.9` 对应标签 `v0.10.9`。当前 `0.10.9` 是待实机验收的未正式发布候选：真实安装日志已确认 `0.10.8` 的 `PrepareToInstall` 因旧版 `data/service.pid.json` 的单个 UTF-8 BOM 被 `readJson()` 直接交给 `JSON.parse()` 而失败，触发 `Unexpected token '﻿'` / `invalid_json`；本候选只兼容单个文件头 BOM，不放宽其它非法 JSON。真实 `.627` CEF 页签修复、内置更新交接和进程保护行为仍待实机验收。当前未确认构建完成，未安装、未推送、未打标签、未发布或上传；不登记安装器哈希或测试通过数量。自定义歌单、批量操作和原生 Gizmo 仍暂缓；`0.9.8` 仍是最后正式发布版本。

发布者在构建公开安装包前，必须确认上述仓库地址正确，并确保对应标签已经公开可访问。
派生或迁移本项目时，应当同步更新此文件与 `package.json` 中的仓库地址。

源码依据 Mozilla Public License 2.0 提供，完整许可文本见同目录 `LICENSE`。
