# 烘焙文档基础集验收（2026-11-04）

> 注：文中链接的 `evidence/` 原始验收证据（设备报告、截图、输出 PDF、日志）因含第三方论文全文及大量重复运行副本，未随公开分支发布；
> 保留在 `feat/cjk-pdf-default-font` 分支历史中，文档中的数字与哈希仅作记录。
> Note: the `evidence/` files linked below (device reports, screenshots, output PDFs, logs) are not part of the public tree; they remain on the `feat/cjk-pdf-default-font` branch.

范围：`feat/bake-python-rootfs`，无 push、无真机安装、无 Feeds/Host 协议改动。
这是新镜像的证据；[上轮文档测量](mobile-document-validation.md)是旧镜像联网安装历史，
不能作为本轮设备验收。

## 选型与输入

Docker daemon 29.2.0 实测可用，构建机 Apple Silicon macOS。采用 A/B 组合：
主机下载并校验固定 SHA-256，`docker run --platform linux/arm64 --network=none`
在临时 Linux 文件系统内解包、验签、离线 APK 安装、离线 pip 安装、导出；不用设备快照。
两端使用各自 minirootfs 及匹配版本、固定 digest 的 Alpine 容器。

- [实际 Alpine 版本表、例外理由与完整命令](../tool/linux/documents/README.md)。
- 锁：`tool/linux/documents/locks/{ios,android}.json`（各29个 APK，含传递依赖）；
  `wheels.json`（6个运行库+构建期fontTools），`font.json`（来源/许可/子集/审批）。
- Python **3.12.16-r0**，保留 py3-pip 和完整标准库。三库版本严格为
  openpyxl 3.1.5 / pypdf 6.1.1 / ReportLab 4.4.4；不用 fpdf2。
  openpyxl 的 Alpine APK 虽同版，却拉入 pandas/numpy/openblas/lxml 等约60包，
  经批准例外使用 wheel。Pillow13.0.0、charset-normalizer3.5.2 使用
  CPython3.12 musllinux_1_2_aarch64 wheel，et_xmlfile2.0.0是纯Python wheel。
- APK 文件 SHA-256、签名及其 signed APKINDEX 控制校验和均验证；保存 index 来源哈希。
  不能因上游删除旧 APK 而改装新版本；需保留输入缓存/后续建立持久内容寻址镜像。
- pip：`--no-index --require-hashes --only-binary=:all: --no-deps --no-compile`，
  依赖闭包显式固定，`pip check` 两端均 `No broken requirements found.`。
- 静态400字体由17,772,300B缩为 **2,357,940B**，只保留一个常规字重；
  默认路径 `/usr/share/fonts/nova/NovaDocumentSansSC-Regular.ttf`。
  精确子集 SHA256 `88f7c79e5b9b132c8b455ad2ff8e943d36b5f65aef653c6327e604646f0617e9`。
  所有者2026-11-04会话内批准这一确切衍生物，见[审批及OFL证据](../../../docs/ASSET_PUBLICATION.md#approved-mobile-document-font-subset-2026-11-04)。
  字符集/字重改变须重新审批；许可证/版权随rootfs、Android许可证目录和应用许可证列表保留。

## 实际构建及可复现性

输出均在内置盘：`~/Library/Caches/nova-build/5166e2db6a75/bake-worker-20261104/`，
其中路径哈希来自本worktree规范路径。Docker VM也必须由操作者保持在内置盘。
没有清理共享产物。Flutter SDK/pub/Gradle缓存使用本会话克隆/隔离目录。

执行成功：

```sh
python3 clients/flutter/tool/linux/ios/build_runtime.py \
  --output-root "$SESSION/ios" --sdk iphonesimulator \
  --docker /opt/homebrew/bin/docker --verify-reproducible
python3 clients/flutter/tool/linux/android/build_runtime.py \
  --session-root "$SESSION" --ndk "$HOME/Library/Android/sdk/ndk/28.2.13676358" \
  --docker /opt/homebrew/bin/docker --verify-reproducible
```

每端分别从同一锁输入在两个全新临时容器文件系统完成安装（非复用已装rootfs），
APK清单/Python清单/文件级清单及规范化tgz哈希均完全一致。
删除pyc，禁止smoke写pyc，规范化tar顺序/mtime/owner名称及gzip时间戳；保留uid/gid/mode/link。
原始文件清单在隔离输出的 `attempt-{1,2}/files.json`；摘要及包清单存于
[`evidence/baked-rootfs/`](evidence/baked-rootfs/)。

| 平台 | 文件级清单 SHA256（两次相同） | tgz SHA256（两次相同） |
| --- | --- | --- |
| iOS/Alpine3.21 | `0f28f4c230885fb74027cac54a97f1dce7182ff3f23305dda945f81c2d420143` | `f5ccd1950df63ebe4d9bdfe6ede91406320ad9c9774a0c1bc7a07c7e1fa35023` |
| Android/Alpine3.22 | `7d7f1ecf1b0d4aca870df70265b1f5fbbf52e443e97906d38d355ff6547e6ec3` | `d127d5e2e6760dce05e546ce94e9637e17617ffda514ec6f948bcf8ce60732fb` |

以上是加入 ReportLab 默认字体 `sitecustomize` 钩子**之前**的哈希。加入钩子并修复其重复注册问题后
（见 [device-e2e-validation.md](device-e2e-validation.md#中文方块根因与修复2026-11-04-续)），
字体字节/哈希不变，钩子 SHA-256 为 `ad54aaa3f008f6f6602952febe9c7d1f35d2a3c39ddbeaf973311bf1696a055e`，
两端各两次独立构建仍一致：

| 平台 | 文件级清单 SHA256 | tgz SHA256 | 烘焙后字节 |
| --- | --- | --- | ---: |
| iOS/Alpine3.21 | `b8351586c9a19acbbdebee9f5b7bf36cbb9e33da6960069ccb05185e2d1faa9e` | `08ec30721c6e441dfdd5a5e460f198a226f7be7c62c276c323abfbe19ef6d143` | 27,580,750 |
| Android/Alpine3.22 | `1b3bf216527fc5b077af554bdabe7c2f966477b43f1a5d79b9b4e1b42e284527` | `4ca0d98938f0829af15732ed6b089f454ed5eeb91ff4b42237439bc21410023c` | 27,949,752 |

## 体积（字节，不是估算MiB）

| 平台/产物 | 裸镜像 | 烘焙后 | 增量 |
| --- | ---: | ---: | ---: |
| iOS rootfs tgz | 3,851,686 | 27,578,681 | 23,726,995 |
| Android rootfs tgz | 3,981,043 | 27,947,489 | 23,966,446 |
| iOS fakefs全部普通文件逻辑字节 | 8,304,959 | 79,955,633 | 71,650,674 |
| iOS fakefs meta.db | 94,208 | 675,840 | 581,632 |
| iOS rootfs普通文件字节 | 8,173,086 | 79,241,859 | 71,068,773 |
| Android rootfs普通文件字节 | 8,507,120 | 81,066,360 | 72,559,240 |
| Android同代码Debug APK（新建ZIP，非增量残留） | 73,802,486 | 97,635,946 | 23,833,460 |
| iOS同代码模拟器.app ZIP（非IPA） | 45,157,812 | 70,364,106 | 25,206,294 |

fakefs裸基线使用同一已构建converter重新从锁定minirootfs转换，非旧设备目录。
Android对照包：仅把本会话runtime副本中的rootfs.tgz/sha256换回固定裸镜像，
其余代码/Flutter资源/许可证不变，构建但**不安装**；之后恢复烘焙配置并重新构建。
为避免AGP增量ZIP保留空洞，分别只删除本会话 `app/intermediates/incremental/packageDebug`
与 `app/outputs/apk/debug` 后打包，未运行共享clean。两份烘焙APK SHA256也相同。
iOS对照是复制同一未签名模拟器.app，只换 `NovaAlpine` 为同converter裸基线，再以
`ditto -c -k --keepParent` 分别ZIP；仅用于控制资源压缩比较，**不是重新构建的裸镜像app、
不是IPA、从未安装**。实际iOS IPA/App Store压缩/安装增量仍未测量。
包字节数/哈希见 [`package-sizes.json`](evidence/baked-rootfs/package-sizes.json)。

## 容器内离线 smoke（实际执行）

`smoke.py` 用最终rootfs的Python导入三库，生成fixture后以read_only/data_only读取
1000行XLSX（总和1001000），读取20页文本PDF，使用**包内字体**生成中文PDF，
再由pypdf读回 `中文汇总：总和 1001000`。容器网络为none；不是宿主Python代跑。
原始JSON在上述证据目录的 `*-rootfs.json`，下面是首次构建的测量秒数。

| 运行环境 | import | XLSX | 20页PDF | 中文生成/读回 | total | maxrss KiB | passed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| ARM64 Docker Alpine3.21 | 0.3415 | 0.0195 | 0.0068 | 0.0144 | 0.3822 | 68300 | true |
| ARM64 Docker Alpine3.22 | 0.4396 | 0.0268 | 0.0071 | 0.0130 | 0.4865 | 68556 | true |

容器native速度不代表iSH或手机性能。RSS是进程高水位，不是各阶段增量。

## 静态/回归验证

- `PYTHONPYCACHEPREFIX="$SESSION/pycache" python3 -m py_compile` 两构建器与documents脚本：通过。
- 两构建器及baker `--help`：通过；实际拒绝相对输出，baker也拒绝 `/Volumes/forbidden`。
- `bash -n tool/linux/ios/package_runtime.sh`：通过。
- `python3 -m unittest discover -s clients/flutter/tool/linux/documents -p 'test_*.py' -v`：8通过。
- `cd clients/flutter && flutter analyze --no-pub`：No issues found（6.6秒）。
- `flutter test --no-pub test/document_font_license_test.dart test/agent_core_test.dart
  test/agent_workspace_test.dart test/document_workspace_test.dart test/workspace_registry_test.dart
  test/workspace_shell_test.dart`：43通过。
- 最终再加 `test/local_chat_documents_test.dart test/local_workspace_test.dart
  test/workspace_posix_test.dart` 一起运行：**50通过**；最终analyze再次No issues found（5.4秒）。
- 没有修改或宣称修复基线无关的9个失败测试。

## 升级路径与尚未核实项

已安装rootfs持久保留，应用升级**不会**替换或混合新系统文件；没有破坏性迁移。
工作区外 `/usr/share/nova/document-base.json` 标记新镜像，agent仍需检查实际库/字体。
旧用户缺库时仍按需经授权联网安装；不保证升级旧安装后离线可用，不擅自删除数据/重装。
首次新安装无需APK/pip/字体下载即可使用基础集。字体不涵盖全CJK，先核所需glyph。

本轮未push。字体精确子集已获批准，不再是未审批阻塞项；不同衍生版本仍须重新审批。
**Apple审核2.5.2对于内置Python执行模型生成脚本的态度，以及rootfs内可执行代码政策均未核实**，
不能由构建/smoke通过推导审核许可。

**CI已知风险：iOS Actions尚未配置Docker daemon/烘焙镜像，会因缺daemon失败。**
按协调决定不改workflow，后续任务可选支持Docker的runner或锁驱动预构建rootfs工件缓存。
未声称本revision CI通过。Docker缺失时baker清晰报错，绝不回退到裸镜像。

## iOS 模拟器应用验收（实际执行）

指定UUID `634EA281-3D38-40A7-97BD-B2D8F24277EF` 不在本机simctl可用设备集。
经协调批准，创建本会话独立 **Nova-Bake-5166e2db6a75-iPhone15**，
UUID `37CBE59C-D5D5-41A6-999E-575714406AFE`，iPhone15 / iOS27.2 (24B8117)。
本机没有18.x runtime，已获准使用现有27.2，不下载新runtime。不复用其他会话模拟器，
没有触碰iPhone真机；取得报告后只终止、关闭并删除了这个本会话模拟器。

先用隔离SDK执行 `flutter build ios --simulator --debug --no-pub --config-only
--target=test/support/workspace_device_acceptance.dart`，再执行：

```sh
xcodebuild build -workspace ios/Runner.xcworkspace -scheme Runner \
  -configuration Debug -sdk iphonesimulator -destination "id=$SIM" \
  -derivedDataPath "$SESSION/ios-derived" -resultBundlePath "$SESSION/ios-app.xcresult" \
  NOVA_LINUX_ROOT="$SESSION/ios" FLUTTER_BUILD_DIR=build \
  CLANG_MODULE_CACHE_PATH="$SESSION/clang-app-cache" \
  COMPILATION_CACHE_CAS_PATH="$SESSION/compilation-cache" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
xcrun simctl install "$SIM" "$SESSION/ios-derived/Build/Products/Debug-iphonesimulator/Runner.app"
xcrun simctl launch --console "$SIM" com.nova.novaMobile
```

**BUILD SUCCEEDED，fixture所有9项通过**。新app首次rootfs安装，未设置APK/PyPI镜像，
默认fixture禁Python socket连接，不运行APK/pip/字体下载或网络探针（本地WebView桥仍使用loopback）。
原报告为 [`ios-device.json`](evidence/baked-rootfs/ios-device.json)。

| 平台 | 首次三库import秒 | XLSX秒 | 20页PDF秒 | 中文PDF秒 | smoke总秒 | RSS KiB | passed |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| iPhone15 / iOS27.2 / iSH | 12.1098 | 1.2363 | 0.2706 | 0.5777 | 14.1943 | 不可用(null) | true |

shell工具端到端wall为20.088秒（含Python启动/桥接），不把它混为脚本内部smoke计时。
未签名Debug模拟器.app普通文件逻辑字节为213,838,275（du约210MiB）；
它不是IPA，也没有相同代码的裸rootfs app基线，因此不声称完整iOS安装包增量已测量。


## Android 模拟器应用验收（实际执行）

最终设备 **emulator-5580 / ARM64 / Android16**，所有adb操作均显式 `-s emulator-5580`。
隔离包名 `com.nova.nova_mobile.autonomy`，`-PnovaAutonomyTest=true`；新验收space
由 `NOVA_ACCEPTANCE_SPACE_ID=bake-python-rootfs-20261104` 指定，避免混用旧rootfs。
默认没有设置APK/PyPI镜像，没有启用 `NOVA_ACCEPTANCE_ON_DEMAND`。

构建使用隔离SDK/pub/Gradle目录和included Flutter Gradle插件输出重定向init script：

```sh
# 于 clients/flutter/android；TARGET为fixture的绝对路径，DEFINES是上述space define的base64。
NOVA_ANDROID_LINUX_RUNTIME="$SESSION/android/linux-runtime" \
GRADLE_USER_HOME="$SESSION/gradle-home" PUB_CACHE="$SESSION/pub-cache" \
./gradlew --no-daemon -Dorg.gradle.internal.http.connectionTimeout=8000 \
  -Dorg.gradle.internal.http.socketTimeout=8000 \
  --init-script "$SESSION/gradle-isolation.gradle" \
  --project-cache-dir "$SESSION/android-project-cache" \
  -PnovaAutonomyTest=true -Ptarget="$TARGET" -Ptarget-platform=android-arm64 \
  -Pdart-defines="$DEFINES" assembleDebug
adb -s emulator-5580 install -r "$SESSION/android-baked-acceptance.apk"
adb -s emulator-5580 shell am start \
  -n com.nova.nova_mobile.autonomy/com.nova.nova_mobile.MainActivity
adb -s emulator-5580 exec-out run-as com.nova.nova_mobile.autonomy \
  cat files/spaces/bake-python-rootfs-20261104/nova-workspace/acceptance-report.json
```

完整构建45秒成功。最初错误JAVA_HOME路径和相对Flutter target已改为实际JDK21/绝对target；
初次无超时联网解析曾停滞，offline尝试明确失败于缺少AndroidX2.10/1.4缓存，
随后正常HTTPS带有限连接/读取超时构建通过（未关闭TLS、未改库版本）。
上述构建网络仅发生在**主机**；设备文档fixture仍禁Python socket且不执行包安装/下载。

首次 `install -r` 因空间不足失败，只读检查得到：

| 操作时点 | /data总KiB | 已用KiB | 可用KiB |
| --- | ---: | ---: | ---: |
| 首次失败后、清理前 | 6,082,144 | 5,548,348 | 391,584 |
| 经授权仅卸载旧autonomy包后 | 6,082,144 | 5,077,628 | 862,304 |
| 用户随后告知已腾空间，再次只读确认 | 6,082,144 | 5,308,036 | 631,896 |
| 按最新指示直接install-r成功后 | 6,082,144 | 5,403,332 | 536,600 |

时间线：先前协调明确授权后，**只卸载旧验收隔离包**（其data453,584KiB，APK94,424KiB），
清除了它的旧workspace；df显示释放470,720KiB，新包安装成功并完成首次离线验收。
没有卸载正式包或其他包，没有wipe、没有清理sdcard。nova相关包只读列表仅发现autonomy。
之后收到“用户已自行腾空间、先df再install-r、不要再清理”的指示，按上表再次检查并
直接重装相同烘焙APK成功，**没有再清理任何东西**；不把用户操作或其他系统变化归为
本任务卸载释放的数值。未启用备用AVD方案，未关闭emulator-5580。

**所有9项通过**，原报告 [`android-device.json`](evidence/baked-rootfs/android-device.json)。
首次干净rootfs上的测量（不是之后install-r保留rootfs后的热运行）：

| 平台 | 首次import秒 | XLSX秒 | 20页PDF秒 | 中文PDF秒 | smoke总秒 | maxrss KiB | passed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| emulator-5580 / Android16 / PRoot | 0.9548 | 0.0476 | 0.0111 | 0.0232 | 1.0367 | 67888 | true |

工具端到端wall1.611秒，RSS是进程高水位。XLSX1000行总和1001000，PDF20页，中文生成/回读
`中文汇总：总和 1001000`，无下载、无手机端pip/apk安装。此结果不是大文件性能保证。
