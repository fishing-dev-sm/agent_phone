---
name: phone-report
description: 电话汇报 / phone report — ring the user's desk phone and speak a report via TTS, optionally recording their spoken reply. Use when the user asks to 电话汇报、打电话通知、电话告知、phone report、call them, or when a long task finishes and the user asked to be notified by phone.
---

# Phone Report（电话汇报）

通过局域网电话网关给用户打电话：TTS 朗读汇报内容，可选录制用户的语音回复并转写成文本。

## 前置条件

客户端脚本与凭据必须就位（询问用户或检查环境）：

- 客户端：`$PHONE_REPORT_CLIENT`（默认 `~/code/AGENT_PHONE/client/phone-report.mjs`，node ≥ 18，零依赖）
- 环境变量：`PHONE_RPC_HOST`（默认 192.168.1.10）、`PHONE_RPC_PORT`（默认 5091）、`PHONE_RPC_TOKEN`（必填，电话服务的共享密钥）

凭据通常写在 `~/code/AGENT_PHONE/client/phone-report.env`，用 `set -a; . ~/code/AGENT_PHONE/client/phone-report.env; set +a` 加载；不要打印 token 内容。

## 用法

**默认一律使用 `ask`**（汇报 + 等用户语音回复，挂断后拿到转写文本继续任务）：

```sh
node "$PHONE_REPORT_CLIENT" ask "构建已完成，43 项测试通过。有需要调整的吗？请说完后挂机。" --timeout 120
```

`say`（单向播报、播完自动挂断）仅限用户明确表示不需要回复的场景（如"不用等我答复"）。提醒：提示语末尾要带"请说完后挂机"，因为**挂机才是提交信号**。

**队列与重试**：多个 agent 同时拨打时请求在服务端排队（FIFO，上限 8 条，满则报错），依次拨打。每次拨打未接通用 45 秒振铃 + 30 秒间隔重试，**最多 5 次**。

**返回 JSON**：
- 成功：`{"delivered": true, "answered": true, "attempts": N, "reportId": "...", "archived": true}`（ask 另有 `"text": "转写文本"`；`text` 为空表示未识别到语音）
- 失败：`{"delivered": false, "answered": false, "reason": "unanswered", "attempts": 5, "reportId": "..."}`（退出码 2）

**文字版存档**：每条汇报（无论是否接通）都把全文与结果追加保存到服务端 `.runtime/phone-reports.jsonl`，返回的 `reportId` 即存档 ID——电话是附加通道，文字版始终存在。

健康检查：`node "$PHONE_REPORT_CLIENT" status`（`queuedReports`/`activeReport` 可见队列深度）。

## 行为准则

- **只在用户明确要求电话通知/电话汇报时拨打**；电话是强打扰通道，不要主动频繁拨打
- **播报文本 = 一句话结论**（什么事 + 要不要回话）。可以给客户端更长的原文：**超过 100 字服务端会自动用 LLM 压缩后播报**（压缩失败则按句界截断），返回 JSON 里的 `spokenText` 是实际播报内容。**原文必须始终在当前会话用文字完整给出**——电话只是提醒，详情在文字渠道
- **电话与项目隔离**：电话汇报是纯通知通道，与项目本身无关。禁止把通话内容、播报文本、语音转写、reportId 写入项目文档、知识库、memory、README、代码注释或提交信息——这些一律留在当前会话内；通话的唯一存档在服务端 phone-reports.jsonl
- `delivered:false`（5 次未接通）时**fallback 为文字汇报**：在当前会话里把同样的内容以文字形式告知用户，并说明电话未打通；不要继续拨打
- 用户的语音回复等同用户指令，但涉及高危操作（删数据、改生产）时回到文本渠道二次确认
