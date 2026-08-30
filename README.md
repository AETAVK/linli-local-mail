# 林离本地回信桥

这是一个由社区维护的 Windows 本地桥接项目，用于在用户已经合法持有的
`BSide Olivia Lin Test 0.0.9.627` 客户端中恢复本地写信、文本回信、历史导入、模型配置，
以及已有视频回信的本地归档与原生播放能力。

本项目不是官方项目，不隶属于、未经原游戏开发商或发行商认可。仓库和安装包均不包含游戏本体、
官方启动器、图片、音乐、视频、字体、DLL、历史信件或其他官方资源。使用者必须自行准备原版客户端。

当前公开源码版本为 `0.9.4`。该版本在 `0.9.3` 的基线逆向重建之上，修复了安装器解压阶段的一个失败：
当游戏目录中已有的文件（如 `tools/backup.mjs`）被旧安装残留变成目录时，安装器会先清理这类冲突、
优先用系统内置 bsdtar 解压，不再让安装中止。图片导入仍是占位功能，不包含 OCR，也不会生成视频或
转写音频。当前可下载的稳定版为 `v0.9.4`。

## 快速安装与启动（零基础）

### 准备

你需要：

- 一台 Windows 10 或更新版本的电脑；
- 已经安装并可以启动的 `BSide Olivia Lin Test 0.0.9.627`；
- 一个可以通过 API 调用的大模型账号，以及该服务提供的 Base URL、API Key 和模型 ID。

本项目不提供游戏本体、模型账号、API Key 或模型调用额度。

> **使用前请先备份游戏文件。** 建议先将完整游戏目录复制到其他位置，至少备份
> `0.0.9.627/` 和 `launcher.exe`。安装器会建立可恢复的客户端备份，但它不能替代玩家自己的完整备份；
> Steam 更新、文件验证或误操作都可能覆盖或改变游戏文件。

### 第一步：下载安装程序

- [Gitee 国内镜像：直接下载一键安装程序（v0.9.4）](https://gitee.com/sforlife/linli-local-mail/releases/download/v0.9.4/LinliLocalMail-0.9.4-Setup.exe)
- [Gitee：查看 v0.9.4 更新说明和 SHA-256 校验值](https://gitee.com/sforlife/linli-local-mail/releases/tag/v0.9.4)
- [GitHub：直接下载一键安装程序（v0.9.4）](https://github.com/AETAVK/linli-local-mail/releases/download/v0.9.4/LinliLocalMail-0.9.4-Setup.exe)
- [GitHub：查看 v0.9.4 更新说明和 SHA-256 校验值](https://github.com/AETAVK/linli-local-mail/releases/tag/v0.9.4)

普通玩家只需要下载 `LinliLocalMail-0.9.4-Setup.exe`，不需要下载页面下方的 `Source code`、
`.json`、`.sha256` 或 `.cer` 文件。

### 第二步：找到游戏目录

在 Steam 游戏库中右键游戏，选择“管理”→“浏览本地文件”。打开的目录中应当同时看到：

```text
0.0.9.627/
launcher.exe
```

把刚下载的 `LinliLocalMail-0.9.4-Setup.exe` 移动到这个目录。这样安装器可以自动识别游戏，
不需要手动选择路径。

### 第三步：安装

双击运行 `LinliLocalMail-0.9.4-Setup.exe`，等待“安装完成”提示。

安装器使用自签名证书，因此 Windows 可能显示“Windows 已保护你的电脑”或“未知发布者”。
请先确认文件来自本仓库的 Release 页面；确认无误后，可以点击“更多信息”→“仍要运行”。
如果文件来自网盘、群文件或陌生转发，请不要绕过警告。

安装过程会：

- 把本地服务安装到游戏目录下的 `linli-local-mail` 文件夹；
- 安装写信、回信、历史导入和模型设置界面；
- 在修改客户端文件前保存兼容备份；
- 保留原启动器，并把游戏根目录的 `launcher.exe` 配置为联合启动入口。

### 第四步：第一次启动并配置模型

安装完成后，双击游戏目录中的 `launcher.exe`。它会先启动本地回信服务，再打开原游戏启动器。

进入游戏后：

1. 打开“设置”→“本地回信”→“模型管理”。
2. 点击添加供应商，按照模型服务商提供的信息选择 API 格式并填写 Base URL 和 API Key。
3. 在该供应商下添加模型 ID，保存后把它设为当前模型。
4. 根据模型能力选择思考档位；不确定时先使用默认档位。
5. 打开信箱写一封测试信。回信稍后变为未读状态，即表示配置成功。

以后启动游戏只需双击游戏根目录中的 `launcher.exe`，不需要再次运行安装程序。

`0.8.1` 及更早版本仍需手动安装一次 `0.9.0` 或更高版本。从 `0.9.0` 开始，游戏加载约 8 秒后会自动检查稳定版；
也可在右上角用户菜单中“设置”下方的“检查补丁更新”手动检查。检测到更高版本时会先
弹窗确认，确认后才下载、校验并启动安装程序。程序文件会更新，但不会主动删除已有信件、模型设置、
日志或备份。

## 功能范围

- 在本机启动 HTTP 服务，接管客户端的写信与回信请求。
- 使用 SQLite 保存信件、异步生成状态和本地记忆。
- 配置多个兼容 OpenAI、Anthropic 或 Gemini 风格接口的模型供应商。
- 在信箱页批量导入 JSON 文件；图片文件可以选择，但在接入 OCR 前会明确报告未支持。
- 通过仍然有效的官方分享链接导入用户自己的历史信件。
- 从本机官方客户端日志中只读检测当前登录会话，并在用户确认后恢复本人官方历史信件。
- 对导入历史中官方已经提供的视频回信进行本地保存、完整性校验和原生 Range 播放；不生成视频、不转写音频。
- 将前端补丁安装到已有的 `0.0.9.627` 客户端，并保留可恢复备份。
- 安装启动包装器，使游戏启动时同时确认本地服务已经运行。
- 自动或手动检查项目的 GitHub/Gitee 稳定版；用户确认后限制下载域名和大小、核对 SHA-256，再启动安装器。

当前只支持 Windows。API Key 通过当前 Windows 账户的 DPAPI 加密保存在本机，
不会写入 SQLite、备份 JSON 或源码仓库。

官方历史恢复依赖仍可访问的官方接口；`0.9.4` 源码已通过自动测试、脱敏日志检测，以及视频归档和本地
Range 播放的源码级验证，但真实远端历史导入仍需使用者在自己的客户端上人工确认。该功能只接受官方
Olivia 域名、固定请求头白名单和本机日志中的会话信息，不会把 Token 写入数据库、日志、导出文件或
模型上下文。视频归档只保存官方已经返回的既有视频，不生成视频、不转写音频。

## 从源码运行

要求：

- Windows 10 或更新版本；
- Node.js 24 或更新版本；
- 已有的 `BSide Olivia Lin Test 0.0.9.627` 游戏目录。

将本仓库克隆或复制为游戏根目录下的 `linli-local-mail` 文件夹，使目录结构如下：

```text
游戏根目录/
├─ 0.0.9.627/
├─ launcher.exe
└─ linli-local-mail/
   ├─ Install.cmd
   ├─ server.mjs
   └─ tools/
```

然后双击 `linli-local-mail/Install.cmd`。安装脚本会检查游戏版本、导入兼容基线、
安装前端补丁和启动包装器。安装前会为被修改的客户端文件建立本地备份。

也可以在仓库目录运行：

```powershell
node server.mjs
node tools/doctor.mjs
```

## 构建一键安装包

维护者还需要 Rust MSVC 工具链、Git for Windows/OpenSSL 和网络连接。构建过程会下载并校验指定版本的
Node.js 运行时与签名工具，然后从 `native/*.rs` 编译启动包装器和安装器：

```powershell
npm run installer:build
```

公开构建使用 `package.json` 和 `SOURCE_CODE.md` 中记录的 GitHub 仓库地址。
如果维护者派生或迁移本项目，必须同步更新这两个位置；默认构建会拒绝带占位符的发布包。

当前构建使用临时自签名证书。自签名只能证明同一个安装包在签名后没有被修改，不能消除 Windows
SmartScreen 的未知发布者提示，也不能替代受信任的商业代码签名证书。

### 自动发布（维护者）

正式版本由 GitHub Actions 在 Windows Runner 上只构建一次，并自动发布到 GitHub Release。工作流文件位于
`.github/workflows/release.yml`，只服务于发布流程，不会进入游戏运行载荷。

每个版本发布前必须新增对应的 `.github/release-notes/v<版本>.md`，内容应只描述该版本相对上一已发布版本的
实际用户可见改动；中间没有单独创建 Release 的版本变更，应合并到实际发布标签的说明中。说明文件为空或
缺失时工作流会拒绝发布。重新运行既有标签的工作流会同时更新 GitHub Release 正文，不会继续保留旧的通用模板。

Gitee 使用同一批已构建文件，不在 Gitee 上重复编译、签名或生成另一份校验值。由于 GitHub-hosted
Runner 到 Gitee 附件上传接口的网络连接不稳定，Gitee 同步脚本
`.github/scripts/publish-gitee-release.mjs` 不再作为 GitHub 工作流的必经步骤；它应在维护者本机或
Gitee Go 流水线中运行。脚本会创建或复用同名 Gitee Release，替换四个发布附件，并检查远端附件清单。
令牌只通过运行环境注入，不要写入 YAML、日志、Issue 或提交。

发布新版本时，先让 `package.json` 的版本与标签一致，再提交代码并推送标签：

```powershell
git tag v<版本>
git push gitee main v<版本>
git push origin main v<版本>
```

例如版本为 `0.9.4` 时使用 `v0.9.4`。先把同一提交和标签推到 Gitee，可以让 Gitee Release 的源码标签
与 GitHub 保持一致；随后推到 GitHub 才会触发工作流。工作流会检查标签格式和版本一致性，执行语法检查、
运行时白名单检查、安装器构建、SHA-256 校验并发布 GitHub Release。重复运行同一标签会只替换 GitHub
Release 中的同名附件，不会删除其他附件；也可以通过 `workflow_dispatch` 手动选择一个已经存在且版本
匹配的标签重新发布。如果失败原因是标签对应的 CI 脚本本身需要修复，可把可选的 `source_ref` 设为已
修复的 `main`，仅用于修复该标签，不能借此把版本不匹配的源码发布为该标签。

GitHub Release 成功后，再在已经下载该版本四个附件的本机或 Gitee Go 环境执行 Gitee 同步脚本。脚本
要求工作目录中的 `dist/` 包含以下文件：安装器 EXE、同名 `.sha256`、同名 `.json` 和
`LinliLocalMail-SelfSigned.cer`；将 `GITEE_TOKEN` 作为临时环境变量注入，完成后立即清除。当前
`v0.9.4` 已按此方式验证 GitHub 与 Gitee 的四个附件一致。

## 数据与隐私

运行后生成的数据库、日志、备份、模型密钥和下载运行时位于被 `.gitignore` 排除的目录中。
请勿提交这些目录，也不要在问题报告中上传未经脱敏的日志、信件或 API Key。

## 许可与边界

本仓库中由项目维护者编写的源码采用 [MPL-2.0](LICENSE) 许可。
角色名称、游戏名称及原游戏相关内容仍属于各自权利人；MPL-2.0 不对这些第三方内容授予权利。
详情见 [NOTICE.md](NOTICE.md) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

分发可执行版本时，必须同时提供对应版本的公开源码位置。参见 [SOURCE_CODE.md](SOURCE_CODE.md)。
