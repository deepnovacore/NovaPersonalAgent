# 移动文档验收（2026-11-04）

范围：独立模式，原有四个通用工具；不涉及 Feeds、Host 附件、OCR、XLSX 写入/图表。
本文区分上一 worker 的原始数据、本轮最终 fixture 和未完成项，不将编译代替真机验收。

> 历史测量：以下“未烘焙”描述指上轮按需安装验收。后续实现与新镜像实测见
> [烘焙验收](baked-rootfs-validation.md)，不要混用两轮性能/体积。

## 推荐与烘焙状态

推荐最小功能集：Python 3.12 + openpyxl 3.1.5（只读 XLSX）+ pypdf 6.1.1
（文本 PDF）+ ReportLab 4.4.4（PDF 生成）。原版 Noto Sans SC variable TrueType
的中文生成/提取可用。fpdf2 2.8.4 不进入基础集。

**本轮未烘焙 Python、库或字体，仍按需安装**（用户授权的 fallback）。两个构建器
都只从固定裸 minirootfs 打包；iOS 还要转换 fakefs。当前 macOS 构建环境没有
可复现、固定 APK 依赖闭包及 wheel 哈希的 guest 安装/重新打包阶段；本轮未在
合理范围内完成这一阶段，也未拿运行过的设备可变 rootfs 冒充可复现基础镜像。
原生运行时本轮使用上个 worker 已构建的只读产物，没有重新完整构建 rootfs。
两脚本 Python 语法已检查，Android 输出参数改为内置盘 `--session-root`，并实测
拒绝相对路径、`/`、`/Volumes/...`。这不是完整 rootfs 构建通过声明。

因此库/字体对打包 rootfs 的体积增量为 **0**（没有加入），不是未来烘焙体积估计。
候选字体原版 17,772,300 字节；尚无已发布子集。ReportLab 本体是纯 Python wheel，
但完整依赖包含 Pillow 13.0.0、charset-normalizer 3.5.2 的 CPython 3.12
musllinux aarch64 原生 wheel；两端实测安装成功，不能泛化到其它 Python/架构。

已测下载的 SHA-256（未来烘焙仍需锁定 APK 闭包、保留许可证、量体积并重跑验收）：

| wheel / 版本 | SHA-256 |
| --- | --- |
| openpyxl 3.1.5 | `5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2` |
| et_xmlfile 2.0.0 | `7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa` |
| pypdf 6.1.1 | `7781f99493208a37a7d4275601d883e19af24e62a525c25844d22157c2e4cde7` |
| reportlab 4.4.4 | `299b3b0534e7202bb94ed2ddcd7179b818dcda7de9d8518a57c85a58a1ebaadb` |
| pillow 13.0.0 cp312 musllinux_1_2_aarch64 | `4bd024d567eca931b668978d672dba914d4b8e2628e2c3073a2ad178de8a2620` |
| charset_normalizer 3.5.2 cp312 musllinux_1_2_aarch64 | `ae4f5fea5b8b8ccff88238cc8569303e5ee95efae67fa62922a311397a71f346` |

## fpdf2 的 `'fvar'` 根因

不是损坏字体，也不是误用 `add_font`。原字体同时含 `fvar`、`avar`、`gvar`；
fpdf2 2.8.4 的 `fpdf/output.py` subset 选项主动丢弃 `fvar`，却保留 `avar`。
fontTools 4.68.0 的 `_a_v_a_r.py:decompile` 需要 `ttFont['fvar'].axes`，
故在 `pdf.output()` 阶段抛 `KeyError: 'fvar'`。标准相同调用在静态实例化
`instantiateVariableFont(font, {'wght': 400})` 后可在 Android 成功，证实是
变量字体处理兼容问题；不是建议在手机上每次转换整份字体。ReportLab 原字体无需
此转换即能生成，并由 pypdf 提取回中文及正确总和。

## Android TLS 诊断

首次 `openpyxl` 失败完整原因是 `SSLEOFError: UNEXPECTED_EOF_WHILE_READING`，
不是 `CERTIFICATE_VERIFY_FAILED`。原始 Android minirootfs 已有
`ca-certificates-bundle 20250911-r0` 和 `/etc/ssl/certs/ca-certificates.crt`，
因此没有证据支持“缺 CA 导致该失败”。本轮另显式安装 `ca-certificates`，
报告记录 UTC 时间、OpenSSL、CA 数及对 pypi.org/所选镜像的标准验证 HTTPS 探测。
原失败的具体断连节点无法从旧日志定位，最窄结论是网络/对端中途断连，非已证实
证书或系统时间错误；不能声称安装 CA 就修复了该 EOF。

按需安装实测可行，但**不保证网络可靠性**。未使用 trusted-host、HTTP 或关闭 TLS。
库安装最终使用验收专用 Tsinghua PyPI index，APK 同样仅验收使用签名镜像，
生产仓库默认值不变。原 CDN/PyPI 和 GitHub 字体下载均可能慢/断连。
本轮中间两次字体 GET 分别 `IncompleteRead`（iOS）/read timeout（Android），
连带字体依赖的 PDF 检查失败；完整失败报告保留于隔离输出。最终 fixture
使用已核验 SHA-256 的测试缓存字体，**不是**把失败下载改成通过，也不是生产预装；
下载函数增加三次有界重试并始终验哈希。最终表明确标注 cache hit。

## 上一 worker 原始表的平台对应

已核对 `ios-report.json` / `android-report.json` 与原日志路径：慢的一轮是
`Nova-Documents-66bd-worker` iOS 27.2 / iPhone 18 Pro **模拟器**（Alpine 3.21），
不是 iPhone 真机；快的一轮是 `emulator-5580` ARM64 Android 16（Alpine 3.22）。
以下耗时均为秒；RSS 为进程累计高水位 KiB，非每项增量。iSH 无可用 ru_maxrss，
`—` 不是 0。installer 高水位另见最终表。

| 项目 | iOS 秒 / RSS / passed | Android 秒 / RSS / passed |
| --- | --- | --- |
| `install_openpyxl==3.1.5` | 26.026 / — / true | 2.173 / 19628 / true |
| `install_pypdf==6.1.1` | 15.483 / — / true | 2.229 / 19628 / true |
| `install_fpdf2==2.8.4` | 159.737 / — / true | 5.485 / 22000 / true |
| `install_reportlab==4.4.4` | 35.326 / — / true | 6.618 / 22000 / true |
| `xlsx_1000_summary` | 3.146 / — / true | 0.331 / 29144 / true |
| `pdf_20_pages_read` | 0.888 / — / true | 0.167 / 34060 / true |
| `download_measurement_font` | 53.763 / — / true | 72.295 / 48976 / true |
| `fpdf2_cjk_pdf_roundtrip` | 10.288 / — / false | 0.476 / 91984 / false |
| `reportlab_cjk_pdf_roundtrip` | 2.496 / — / true | 0.087 / 109356 / true |

两轮 overall 都是 **false**，仅变量字体的 `fpdf2_cjk_pdf_roundtrip` 失败；不是库全部不可用。60 秒对这些小输入的计算足够，但不覆盖安装（旧 iOS fpdf2 159.737 秒）、字体下载（旧 Android 72.295 秒）或大文件/iSH 字体转换。
