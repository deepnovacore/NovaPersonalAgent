# Nova Personal Agent 改名与兼容范围

v0.4 将项目名称统一为 Nova Personal Agent，仓库目标为 `deepnovacore/nova-personal-agent`。

- npm：`nova-personal-agent`、`nova-personal-agent-server`；内部工作区统一为 `@nova-personal-agent/*`。
- 命令：`novapersonal`、`novapersonal-server`；仅保留 `novaaudio`、`novaaudio-server` 两个安装命令别名。
- 用户数据继续使用 `~/.nova-audio-agent`。桌面加密设置身份、app ID 与 CLI 安装回执保持稳定，不复制或重新加密密钥。
- 现有环境变量没有带旧品牌的 `NOVA_AUDIO_*`；`NOVA_*`、模型提供方、路径与密钥变量保留原名。`.env.example` 和环境变量契约继续核验。
- v0.3.x Release 资产及可执行文件保持原名；从 v0.4 开始使用新文件名。历史版本与记录不重写。
- DEB 新包替换并冲突声明旧桌面包，避免两个安装同时管理同一应用身份。
- GitHub 改名全局影响所有分支。官网构建以实际仓库名生成 Pages 路径，仓库限制临时接受旧、新地址。

仓库内修改不会自动发布 npm、部署官网或修改 GitHub 仓库名。正式改 GitHub 后更新本地远端：

```sh
git remote set-url origin git@github.com:deepnovacore/nova-personal-agent.git
```

已安装旧 npm 包时，先运行 `npm uninstall --global nova-audio-agent nova-audio-agent-server` 再安装新包，以避免旧命令别名的全局链接冲突；用户数据不会随包卸载删除。

现有本地 checkout/worktree 目录无需移动；`internal-origin` 与个人 fork 不随公共仓库改名。本次不合入公司试点或改写 Git 历史。

## 本次验证（2026-10-11）

- 运行时完整测试：3,647 项，3,638 通过、9 跳过、0 失败。
- 桌面构建通过；桌面完整测试：1,257 项，1,253 通过、3 跳过。唯一失败是未修改的 `macos-gui-native.test.mjs` 编译 Swift 夹具超过 60 秒；隔离重跑仍超时，未宣称该原生测试通过。
- Codex 权限配置名称补齐后重新编译，相关 30 项测试通过；TypeScript 与相关 ESLint 检查通过。
- CLI 与服务端命令 35 项测试通过；实际 CLI tarball 安装后新、旧命令均可读取版本。
- 环境变量契约检查通过；官网以新 base path 构建成功，70 页面与 3,140 本地链接/资源引用检查通过。
- 无头服务打包明确限定 Linux x64，本机 macOS 未构建 Linux/Windows 安装器；未发布 npm、未部署官网、未改 GitHub 仓库名。
