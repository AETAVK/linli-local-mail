# 林离本地回信桥

这是一个由社区维护的 Windows 本地桥接项目，用于在用户已经合法持有的
`BSide Olivia Lin Test 0.0.9.627` 客户端中恢复本地写信、文本回信、历史导入和模型配置能力。

本项目不是官方项目，不隶属于、未经原游戏开发商或发行商认可。仓库和安装包均不包含游戏本体、
官方启动器、图片、音乐、视频、字体、DLL、历史信件或其他官方资源。使用者必须自行准备原版客户端。

## 快速安装与启动（零基础）

### 准备

你需要：

- 一台 Windows 10 或更新版本的电脑；
- 已经安装并可以启动的 `BSide Olivia Lin Test 0.0.9.627`；
- 一个可以通过 API 调用的大模型账号，以及该服务提供的 Base URL、API Key 和模型 ID。

本项目不提供游戏本体、模型账号、API Key 或模型调用额度。

### 第一步：下载安装程序

- [直接下载一键安装程序（v0.6.0）](https://github.com/AETAVK/linli-local-mail/releases/download/v0.6.0/LinliLocalMail-0.6.0-Setup.exe)
- [查看最新版、更新说明和 SHA-256 校验值](https://github.com/AETAVK/linli-local-mail/releases/latest)

普通玩家只需要下载 `LinliLocalMail-0.6.0-Setup.exe`，不需要下载页面下方的 `Source code`、
`.json`、`.sha256` 或 `.cer` 文件。

### 第二步：找到游戏目录

在 Steam 游戏库中右键游戏，选择“管理”→“浏览本地文件”。打开的目录中应当同时看到：

```text
0.0.9.627/
launcher.exe
```

把刚下载的 `LinliLocalMail-0.6.0-Setup.exe` 移动到这个目录。这样安装器可以自动识别游戏，
不需要手动选择路径。

### 第三步：安装

双击运行 `LinliLocalMail-0.6.0-Setup.exe`，等待“安装完成”提示。

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

如果安装了新版本，可以把新版安装程序放到同一游戏目录重新运行；安装器会覆盖程序文件，
但不会主动删除已有信件、模型设置、日志或备份。

## 功能范围

- 在本机启动 HTTP 服务，接管客户端的写信与回信请求。
- 使用 SQLite 保存信件、异步生成状态和本地记忆。
- 配置多个兼容 OpenAI、Anthropic 或 Gemini 风格接口的模型供应商。
- 在信箱页通过 JSON 或仍然有效的官方分享链接导入用户自己的历史信件。
- 将前端补丁安装到已有的 `0.0.9.627` 客户端，并保留可恢复备份。
- 安装启动包装器，使游戏启动时同时确认本地服务已经运行。

当前只支持 Windows。API Key 通过当前 Windows 账户的 DPAPI 加密保存在本机，
不会写入 SQLite、备份 JSON 或源码仓库。

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

## 数据与隐私

运行后生成的数据库、日志、备份、模型密钥和下载运行时位于被 `.gitignore` 排除的目录中。
请勿提交这些目录，也不要在问题报告中上传未经脱敏的日志、信件或 API Key。

## 许可与边界

本仓库中由项目维护者编写的源码采用 [MPL-2.0](LICENSE) 许可。
角色名称、游戏名称及原游戏相关内容仍属于各自权利人；MPL-2.0 不对这些第三方内容授予权利。
详情见 [NOTICE.md](NOTICE.md) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

分发可执行版本时，必须同时提供对应版本的公开源码位置。参见 [SOURCE_CODE.md](SOURCE_CODE.md)。
