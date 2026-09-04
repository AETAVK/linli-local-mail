# Corresponding Source Code

Repository: https://github.com/AETAVK/linli-local-mail

本安装包对应的源码位于上述公开仓库。安装包版本取自 `package.json`，对应源码使用同版本 Git 标签
`v<version>` 标记；正式安装包 `0.11.2` 对应标签 `v0.11.2`，标签提交为
`c95936635f75eddf4ee3bb835a87e62835ef7df3`。

`v0.11.2` 已于 2026-09-04 正式发布到
[GitHub](https://github.com/AETAVK/linli-local-mail/releases/tag/v0.11.2) 与
[Gitee](https://gitee.com/sforlife/linli-local-mail/releases/tag/v0.11.2)。GitHub Actions 生成的正式安装器
SHA-256 为 `6cc3600000d47c9c8e57b768c6379a05e09a3d814c2157f48d102d508463c898`，Gitee 镜像使用
同一批附件。

用户验收的是从私有提交 `a010efca60df30cb1b3dd2da04904b3ce333f3f5`、公开候选提交 `151237a`
构建的发布前本地候选。正式标签相对该公开候选只包含发布文档、投影元数据和 CI 治理修正，不包含
运行时代码变更；正式 CI 安装器没有单独重复实机安装，因此两者的构建哈希不得混用。
`0.11.1` 曾生成一个未安装、未推送、未打标签、未发布的本地
候选安装包；它对应私有提交 `5e1834c765ace9d63ad510f907f336cd4f716627`，不得作为当前 `0.11.2` 的
对应源码或发布物。更早的 `0.11.0` 本地候选也已被后续版本取代。

`v0.10.9` 已于 2026-09-02 正式发布，是 `v0.11.2` 之前的正式版本。已发布标签用于固定该版本安装包的对应源码，不得移动、删除或重写。
发布后的 README、Release Notes 或其他说明文字勘误可以继续提交到 `main`；这类修订不改变既有标签、
安装包及其 SHA-256。需要修改运行代码或发布附件时，应递增版本并创建新标签。

派生或迁移本项目时，应同步更新本文件与 `package.json` 中的仓库地址，并为分发的可执行版本提供相应源码。

源码依据 Mozilla Public License 2.0 提供，完整许可文本见同目录 `LICENSE`。
