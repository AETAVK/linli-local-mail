# 林离本地回信桥

这是一个由社区维护的 Windows 本地桥接项目，用于在用户已经合法持有的
`BSide Olivia Lin Test 0.0.9.627` 客户端中恢复本地写信、文本回信、历史导入和模型配置能力。

本项目不是官方项目，不隶属于、未经原游戏开发商或发行商认可。仓库和安装包均不包含游戏本体、
官方启动器、图片、音乐、视频、字体、DLL、历史信件或其他官方资源。使用者必须自行准备原版客户端。

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

在首次公开构建前，必须把 `package.json` 和 `SOURCE_CODE.md` 中的
`SOURCE_REPOSITORY_URL` 替换为真实公开仓库地址。默认构建会拒绝带占位符的发布包。

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
