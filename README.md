# 林离本地回信桥

林离本地回信桥是一个由社区维护的 Windows 本地桥接项目，用于在用户已经合法持有的
`BSide Olivia Lin Test 0.0.9.627` 客户端中恢复本地写信、文本回信、历史导入、模型配置，
以及已有视频回信的本地归档与原生播放能力。

本项目不是官方项目，不隶属于、未经原游戏开发商或发行商认可。仓库和安装包均不包含游戏本体、
官方启动器、图片、音乐、视频、字体、DLL、历史信件或其他官方资源。使用者必须自行准备原版客户端。

当前稳定版为 `0.11.6`。普通玩家可使用下方正式版安装器。

- [GitHub 0.11.6 正式发布页](https://github.com/AETAVK/linli-local-mail/releases/tag/v0.11.6)
- [Gitee 0.11.6 正式发布页（国内镜像）](https://gitee.com/sforlife/linli-local-mail/releases/tag/v0.11.6)
- [v0.11.6 发布说明](.github/release-notes/v0.11.6.md)

## 系统要求

- 64 位 Windows 10 或 Windows 11；不支持 32 位 Windows，ARM64 的 x64 模拟环境尚未单独验证。
- 已安装且可以正常启动的 `BSide Olivia Lin Test 0.0.9.627`。
- 一个可通过 API 调用的大模型账号，以及服务商提供的 Base URL、API Key 和模型 ID。

本项目不提供游戏本体、模型账号、API Key 或模型调用额度。

> **安装前请备份游戏文件。** 建议复制完整游戏目录，至少备份 `0.0.9.627/` 和
> `launcher.exe`。安装器会为受管文件建立事务快照，但这不能替代玩家自己的完整备份。

## 快速安装与启动

以下步骤适用于正式版 `0.11.6`。

### 1. 下载安装器

- [GitHub：下载 LinliLocalMail-0.11.6-Setup.exe](https://github.com/AETAVK/linli-local-mail/releases/download/v0.11.6/LinliLocalMail-0.11.6-Setup.exe)
- [Gitee：下载 LinliLocalMail-0.11.6-Setup.exe](https://gitee.com/sforlife/linli-local-mail/releases/download/v0.11.6/LinliLocalMail-0.11.6-Setup.exe)

普通玩家只需下载 `LinliLocalMail-0.11.6-Setup.exe`。Release 页面中的 `.sha256`、`.json` 和
`.cer` 文件用于完整性校验与签名信息核对；自动生成的 `Source code` 压缩包不是安装程序。

### 2. 放入游戏根目录

在 Steam 游戏库中右键游戏，选择“管理”→“浏览本地文件”。把安装器放到同时包含以下项目的目录：

```text
游戏根目录/
├─ 0.0.9.627/
└─ launcher.exe
```

### 3. 退出游戏并安装

完全退出游戏和官方启动器后，双击 `LinliLocalMail-0.11.6-Setup.exe`。安装器会自动识别当前目录，
部署内置 Node.js、本地服务、启动包装器和客户端补丁。

安装器采用自签名证书，Windows 可能显示“未知发布者”或 SmartScreen 提示。请先确认文件来自上述
GitHub/Gitee Release 页面并核对 SHA-256；不要对网盘、群文件或陌生转发的安装包绕过安全警告。

安装或修复会先建立事务快照，再部署、校验并提交；失败时会尝试恢复安装前状态。默认卸载会恢复官方
启动器和前端包，同时保留本地信件、模型设置、密钥、媒体、导入记录、日志与备份。只有在卸载确认框中
明确选择删除本地数据时，这些限定目录才会被删除。

### 4. 启动并配置模型

安装完成后，双击游戏根目录中的 `launcher.exe`。它会先确认本地回信服务运行，再启动原游戏。

1. 打开“设置”→“本地回信”→“模型管理”。
2. 添加供应商，选择兼容的 API 格式并填写 Base URL 和 API Key。
3. 添加模型 ID，保存并设为当前模型。
4. 按模型能力选择思考档位；不确定时使用默认档位。
5. 在信箱中寄出一封测试信，等待回信变为未读状态。

以后只需通过游戏根目录中的 `launcher.exe` 启动，无需重复运行安装器。

## 升级说明

- 从 `0.9.x` 或更早版本升级时，最稳妥的方式是完全退出游戏与官方启动器，再手动运行
  `0.11.6` 安装器。
- 新版内置更新器可以在游戏运行时下载并校验更新，但安装交接仍需退出游戏和官方启动器；安装器不会
  为继续安装而强制结束游戏进程。
- 升级默认保留信件、模型配置、API Key、媒体和备份。

## 功能说明

- 本地写信与 AI 文本回信，支持角色设定和历史通信参考。
- 多服务商、多模型配置与切换，支持思考档位调整。
- 历史信件导入：文字录入、JSON 备份、有效分享链接；支持待导入队列与批量导入。
- 已有视频回信的本地保存与播放。
- 自定义歌单、歌曲批量操作、音乐桌面一键清空，支持独立开关。
- “我的上传”曲库与本地定制演奏管理。
- 曲库 / 信箱页签切换、UID 水印隐藏、补丁更新检查。

## 校验正式发布文件

从 Release 页面下载与安装器同名的 `.sha256` 文件，并核对安装器的 SHA-256。若计算结果不同，
请勿运行安装器。

## 从源码运行

开发环境需要 64 位 Windows 10/11、Node.js 24 或更新版本，以及已有的 `.627` 游戏目录。将仓库放在
游戏根目录下的 `linli-local-mail/`，然后运行 `Install.cmd`；也可以在仓库目录执行：

```powershell
node server.mjs
node tools/doctor.mjs
```

前端可编辑源码位于 `frontend-src/local-mail-poc/`，`frontend/local-mail-poc.js` 是游戏实际加载的生成文件，请勿直接修改。改动片段后先组装，再核对生成物：

```powershell
npm run frontend:build
npm run frontend:check
```

## 构建安装包

维护者还需要 Rust MSVC 工具链、Git for Windows/OpenSSL 和网络连接。构建流程会下载并校验固定版本的
Node.js、Inno Setup 与签名工具，编译启动包装器并生成安装器：

```powershell
npm run installer:build
```

未配置固定 PFX 时会使用临时自签名证书。自签名不能消除 SmartScreen 或“未知发布者”提示，也不能替代
受信任的公共代码签名证书。

## 发布维护

正式版本由 GitHub Actions 在 Windows Runner 上构建一次，并发布安装器、SHA-256、构建清单和自签名
证书。Gitee 只镜像 GitHub 构建的同一批附件，不进行第二次编译或签名。每个标签必须与 `package.json`
版本一致，并提供 `.github/release-notes/v<版本>.md`。

已发布标签不可移动或重写。发布后的 README、状态文件或发布说明只在纠正事实错误、安全提示或文字
错误时更新，不得借此改变对应标签的源码和二进制内容。

## 数据与隐私

运行后生成的数据库、日志、备份、模型密钥和下载运行时位于 `.gitignore` 排除的目录中。报告问题时，
请先删除或遮盖个人路径、信件内容、UID、API Key 和其他敏感信息。

## 许可与边界

本仓库中由项目维护者编写的源码采用 [MPL-2.0](LICENSE) 许可。角色名称、游戏名称及原游戏相关内容仍
属于各自权利人；MPL-2.0 不对这些第三方内容授予权利。详情见 [NOTICE.md](NOTICE.md) 与
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。可执行版本对应的公开源码位置见
[SOURCE_CODE.md](SOURCE_CODE.md)。
