# 本地代码行数图

需要 Python 3、Git、Matplotlib；不需要 Codex、模型或网络。若缺少绘图库：`python3 -m pip install matplotlib`。

在仓库根目录运行：

```sh
python3 scripts/code-map.py
# 查看 runtime 各一级模块
python3 scripts/code-map.py --scope runtime/src --depth 1 --output dist/runtime-map.png
# 查看指定 worktree
python3 scripts/code-map.py --repo .worktrees/slim-plan --output dist/slim-map.png
# 展开更多目录、使用物理行数（包括空行）
python3 scripts/code-map.py --depth 4 --top 50 --metric physical
```

默认输出饼状图 `dist/code-map.png` 与同名 JSON。输出路径相对于执行命令的当前目录。

- 读取目标仓库 `git ls-files` 的当前工作区内容，包含已跟踪文件的未提交修改；不包含未跟踪文件、符号链接或已删除文件。
- 按代码扩展名筛选，支持 TS/JS、Swift、C/C++、Python、Shell、SQL、CSS/HTML 等；不包含 Markdown、JSON/YAML、图片。不是全仓库文本大小统计，也不自动排除已跟踪的生成代码。
- 默认统计非空行，注释也计入；`--metric physical` 包含空行。不是去注释后的逻辑代码行数。
- 模块按相对 `--scope` 的路径深度分组；普通文件合并到所属目录，scope 根目录文件合并为 `(root module)`。达到 1,000 行的 TS/TSX 文件独立显示，并从所属模块扣除，避免重复计数；用 `--large-ts 2000` 调整阈值，`--large-ts 0` 禁用。阈值使用当前行数口径。最大的 15 个模块/大型文件显示，其余合并；JSON 保留完整模块和逐文件统计。
- 测试/fixture、评测、脚本按目录名及测试文件名识别，剩余归入 production；分类保留在 JSON 中；饼图每个扇区代表模块或大型 TS 文件。这是路径分类，不是依赖或业务架构分析。
- 二进制或非 UTF-8 代码文件跳过，并列入 JSON 的 `skipped`。

运行计数回归检查：`python3 scripts/test_code_map.py`。
