# OpenRouter PR review / OpenRouter PR 审查

A focused, advisory review of the PR diff and relevant callers, with line-linked
findings and an overall summary in one updated comment. No style nitpicks,
whole-repository audit, automatic approval or merge gate.

审查 PR diff 及相关调用链，在同一条更新的评论中提供行号链接和总体总结。
不挑格式细节，不做全仓审计，不自动批准，也不作为合并门槛。

## Setup / 配置

1. Create a dedicated [OpenRouter key](https://openrouter.ai/settings/keys).
   Use a separate credit limit (the initial deployment uses **$2 per day**). Do not use a management key or an
   unlimited key shared with production. Billing is through OpenRouter; an
   OpenAI account/key is not required.

   创建 review 专用 OpenRouter key，单独设置额度（首次部署使用 **每天 $2**）。
   不使用管理 key 或生产环境共享的无限额 key。费用由 OpenRouter 结算，
   不需要 OpenAI 账号或官方 key。

2. Store it as the target repository's Actions secret `OPENROUTER_API_KEY`.
   Set Actions variable `PR_REVIEW_MODEL` to an explicit OpenRouter model ID;
   the default is `qwen/qwen3.8-flash`. Set `PR_REVIEW_ENABLED=true`
   only after configuring the capped key. Neither secrets nor local `.env`
   files belong in Git.

   在目标仓库 Actions secret 中保存 `OPENROUTER_API_KEY`。
   用变量 `PR_REVIEW_MODEL` 指定完整模型 ID，默认 `qwen/qwen3.8-flash`。
   配好限额 key 后再设置 `PR_REVIEW_ENABLED=true`。密钥和 `.env` 不提交到 Git。

3. The workflow must be on the default branch before its PR events/manual
   dispatch become available. If your organization blocks `pull_request_target`,
   an administrator must allow this reviewed workflow under its Actions event
   policy. Do not broadly disable organization security policies.

   workflow 需要先进入默认分支，PR 事件和手动触发才可用。如果组织策略禁用
   `pull_request_target`，管理员需按 Actions 事件策略允许此已审查 workflow，
   不要整体关闭组织安全策略。

4. Open a non-draft PR or use **Actions → AI PR review → Run workflow → pr**.
   The actor and rerun actor must both have repository write access. For an
   external contributor's PR, a maintainer dispatches it manually. Allowed
   target branches: `main`, `v0.2.0dev`, `v0.3.0dev`; public repositories only.

   创建非草稿 PR，或在 Actions 中选择 AI PR review，手动填写 PR 编号。
   原始触发人和重新运行者都必须有仓库写权限；外部贡献者的 PR 由维护者手动触发。
   仅允许公开仓库和上述公开目标分支。

## Cost and coverage / 成本与覆盖范围

- One agent run produces both sections. New PR revisions cancel older runs;
  successful base/head/model combinations are deduplicated using the bot comment.
  Delete that comment to deliberately review the same revision/model again.
- The review step has a 10-minute timeout, the job 15 minutes. The prompt asks
  for about 20 inspection commands and at most five meaningful findings.
  These are time/prompt controls, **not a per-run dollar or token cap**.
  Codex/provider retries and repeated context can still incur additional usage.
  The OpenRouter key credit limit is the spending backstop; already running
  requests/cancellation can incur charges. A cancellation does not refund usage.
- Inspect OpenRouter Activity to measure actual spend before raising limits.
  Exceeding budget or a model/API error fails the run; it never posts a clean
  review. Configure this workflow as advisory, not a required branch check.
- Reviewers state coverage gaps; they do not run tests or claim complete audit.
  The 200k context setting is a conservative model context assumption, not a
  total-usage cap. Recheck it when choosing a model with a smaller context.

一次 agent 运行生成两部分结果。新提交取消旧任务，同一 base/head/model 的成功结果
去重；如需重复评审，可删除原 bot 评论。超时和提示词约束不等于单次金额或 token
上限，实际支出以 OpenRouter 为准，key 限额作为最后防线。运行中的请求仍可能计费。
预算耗尽或 API 错误会使运行失败，不会伪装成“没有问题”。请勿将此 workflow
配置为分支必需检查。结果会注明覆盖不足，不声称运行过测试或完成全仓审计。

## Trust boundary / 信任边界

Executable scripts, prompts and configuration come from the workflow revision.
PR commits are fetched as Git objects but never checked out; Codex inspects them
using `git diff`, `git show` and `git grep`. The agent runs with read-only
permissions and `drop-sudo` on a disposable GitHub runner. It has no GitHub write
token. A separate publishing job validates the current base/head and updates
only this workflow's bot comment; model text is passed as data, never shell/JS.
PR code and instructions remain untrusted. Only public PR code is sent to
OpenRouter and the selected upstream provider; private remotes are never fetched.

脚本、提示词和配置来自可信 workflow 版本。PR 只作为 Git 对象读取，不 checkout，
不执行其代码。Agent 使用只读权限，不持有 GitHub 写入 token。独立发布 job
重新核对 base/head，且只更新本 workflow 的 bot 评论。模型文本只作为数据处理。
只向 OpenRouter 及所选上游提供商发送公开 PR 代码，不获取任何私有 remote。

## Local checks / 本地检查

```sh
node --test .github/scripts/pr-review.test.cjs
actionlint .github/workflows/pr-review.yml
```

These verify workflow logic/syntax, not live model quality or GitHub execution.
Pin the action and CLI versions together; verify Responses API/tool-call
compatibility before changing the selected model or upgrading the runner.

这些检查验证逻辑和语法，不代表真实模型效果或 GitHub 运行验收。
Action 和 CLI 固定版本；更换模型或升级前需验证 Responses API 和工具调用兼容性。

The Responses-only proxy can emit model-catalog/unknown-model warnings because
it does not serve `/models`. The pinned CLI/proxy has been smoke-tested with
`qwen/qwen3.8-flash` for shell tool calling and a synthetic boundary-bug review;
the explicit context setting avoids assuming the full advertised model window.
This does not establish GitHub Linux runner acceptance or real-PR review quality.

仅转发 Responses 的代理不提供 `/models`，可能出现模型目录或未知模型警告。
固定版本 CLI/proxy 与 `qwen/qwen3.8-flash` 已通过 shell 工具调用和模拟边界错误
评审测试；显式配置上下文大小，不直接假设完整的模型窗口。
这不等于 GitHub Linux runner 验收，也不代表真实 PR 的审查质量已验证。
