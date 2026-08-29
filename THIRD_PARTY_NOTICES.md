# Third-Party Notices

本项目的源码不包含原游戏文件。运行和构建过程会使用下列第三方组件：

## Node.js

一键安装包内置 Node.js Windows x64 运行时。Node.js 由 OpenJS Foundation 及其贡献者维护，
采用其发行包中列出的许可。构建脚本会把官方 Node.js 发行包内的 `LICENSE` 原样保存为
`runtime/Node.js-LICENSE.txt`。

官方网站：https://nodejs.org/

## osslsigncode

维护者构建自签名安装包时使用 `osslsigncode`。它是构建工具，不会作为本项目运行时服务的一部分安装。
其许可证与源码由上游项目提供。

上游项目：https://github.com/mtrojnar/osslsigncode

## Rust 与 Windows 系统组件

安装器和启动包装器由 Rust 编译，并调用 Windows 提供的进程、证书和 DPAPI 能力。
相应组件仍受各自许可或系统条款约束。
