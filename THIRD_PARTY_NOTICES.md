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

## Inno Setup

Windows 一键安装程序与卸载程序由 Inno Setup 7 构建。构建脚本只从上游固定版本地址下载编译器并校验
SHA-256；安装包中包含 Inno Setup 生成的安装、事务调用和卸载运行代码，不会把 Inno Setup 开发环境
安装到玩家电脑。

官方网站与许可：https://jrsoftware.org/isinfo.php 、https://jrsoftware.org/files/is/license.txt

## Rust 与 Windows 系统组件

启动包装器由 Rust 编译。本地服务、安装器和包装器会调用 Windows 提供的进程、证书和 DPAPI 能力。
相应组件仍受各自许可或系统条款约束。

## Lucide 图标

更新入口使用 Lucide 1.8.0 的 Download、LoaderCircle、Clock3、CircleAlert 和 X 原始图标节点，
随前端源码内嵌；不加载远端图标资源或完整图标运行库。上游：https://github.com/lucide-icons/lucide

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
