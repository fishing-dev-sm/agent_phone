# 验收记录（2026-09-19/20，实机）

环境：companion @ 192.168.1.10（Linux, Node 26）；HT802V2 @ 192.168.1.150（路由器 DHCP 静态预留）；语音服务 @ 192.168.1.20:8300（gpu-host, RTX 5090, SenseVoice-Small + Kokoro-82M, systemd `ht802-speech.service`）。

## M1 设备配置
- `ht802-configure.py inspect` 只读回显通过；MAC 校验正反向正确
- `configure` 写入 + 回读校验 + 重启通过；原配置备份于 `.runtime/ht802-original.json`
- 踩坑：V2 写配置后会话失效（已修，校验前重登）；FXS1 出厂未激活（P271=0，摘机忙音）

## M2 companion 启动
- `start` 幂等，`status` 显示 `sip: 192.168.1.10:5090 / peer: 192.168.1.150`，日志 `ready`

## M3 来电（上行）
- 摘机 → HT802 Off-hook Auto Dial 263 → INVITE 到 5090 → companion 200/ACK → 提示音 → 挂机 BYE
- 日志：`handset_up` / `handset_down{reason:hangup}`，多轮一致

## M4 去电（下行）
- 初始失败：`test-ring` 45s 无应答。定位链：5060 ICMP unreachable → 抓包发现设备信令源端口 13026（V2 随机端口）→ 关 `P20501/P20505` 后仍闭 → 发现 `P31` 在 V2 是注册开关被误关 → 置 1 + companion 补 REGISTER 200 应答后 5060 开始监听
- 修复后：振铃节奏正确，摘机听到 880+660Hz 双音；修复了 test 分支未清 `confirmTimer` 导致接通 8 秒被误挂的问题

## M5 语音闭环
- TTS：`test-say` 30 字 → 摘机听到 Kokoro（zf_xiaoxiao）清晰播报；服务端实测 200 字合成 0.208s
- STT：`test-transcription` → 摘机 → 提示音 → 说话 → 挂机 → `status` 返回「你好，这是一个测试。」；服务端实测 33.7s 电话音频识别 0.184s
- 踩坑：RTP warmup 吞掉 0.3s 提示音（已垫 0.5s 静音修复）；布防窗口 120s 需注意

## 单元测试
- `npm test`：46 项全绿（含 phone-report 客户端协议 3 项）

## M6 引擎迁移 + 网络 RPC + 通用 skill（2026-09-20）
- companion 迁移至独立主机 192.168.1.10，systemd 用户服务 `agent-phone.service`（enable --now，重启自愈）
- 新增 TCP RPC（5091，timingSafeEqual token 鉴权）：错误 token 拒绝、正确 token 通过、LAN 外由 ufw 拦截（规则按源收敛：5091 限 LAN，5090/15004 限 HT802 IP）
- 新增生产方法 `say`（振铃≤45s，摘机 TTS 播报）与 `ask`（同通电话录音，挂机返回转写，超时/未接听结构化返回）
- HT802 P47 重指向 192.168.1.10:5090（configure 备份可回滚至旧指向）；开发机旧实例已停
- 端到端实机：`client → 192.168.1.10 → HT802`，`say` 播报清晰；`ask` 返回 `{"answered":true,"text":"向通话非常好，测试测试成功非常好。"}`（用户口述"双向通话非常好，测试成功"），转写首字有损（SenseVoice 对起音剪切敏感，可接受）
- skill 安装：`~/.agents/skills/phone-report`（Kimi）与 `~/.codex/skills/phone-report`（Codex CLI）symlink 就位

## M7 占线策略（2026-09-20）
- 新增 `src/phone-reports.mjs`：FIFO 汇报队列（上限 8，满则明确报错），串行化单 FXS 线路上的 say/ask
- 未接通自动重试：45s 振铃 + 30s 间隔，最多 5 次；5 次失败返回 `{delivered:false, attempts:5, reportId}`（客户端退出码 2），SKILL.md 规定 agent fallback 为文字汇报
- 每条汇报（无论成败）全文+结果追加存档至服务端 `.runtime/phone-reports.jsonl`，`reportId` 可溯源
- say 接通播完后自动挂断释放线路；ask 在播报后录音，挂机返回转写（超时 10–300s 可配）
- 顺带修复初版 say/ask 的共享音频槽竞态（忙线检查与 dial 之间隔着 TTS 网络请求，并发请求会互相覆盖文本）——队列串行化后该类竞态消除
- 实机：`say` 1 次接通、`say_complete` 自动挂断、存档记录完整（服务端 jsonl 核对一致）
- 单元测试：6 项队列测试（送达归档/重试成功/5 次失败/串行/队满拒绝/ask 转写），合计 52 项全绿

## M8 汇报纪律（2026-09-20，用户实测反馈）
- 问题：agent 把 200+ 字塞进播报（TTS 读了一分钟）；通话细节被写进项目知识库
- 收紧：say/ask 文本服务端硬上限 100 字（约 15 秒语音），超限报错"详细内容请走文字渠道"
- SKILL.md 新增隔离规则：禁止把通话内容/转写/reportId 写入项目文档、知识库、memory、代码注释；唯一存档在服务端 phone-reports.jsonl
- 默认一律 ask（双向）；say 仅限用户明示不需要回复
- 已同步各主机（companion 重启生效）；超限拒绝已实测

## M9 超长文本自动压缩（2026-09-20）
- 用户反馈：100 字硬拒绝不好——改为电话永远打，超长文本由服务端压缩后播报，原文随结果返回走文字渠道
- companion 主机 LiteLLM 中转 chat 路由损坏（模型不存在）→ 改用 gpu-host 的 llama.cpp（Qwen3.8-27B, ROCm），经 SSH 隧道 `127.0.0.1:8301 → 192.168.1.20:8080`（systemd agent-phone-llm-tunnel.service，主机间密钥已配）
- `compressForSpeech()`（src/phone-audio.mjs）：LLM 压缩（45s 超时）→ 失败回退句界截断；恒 ≤100 字
- 结果与存档含 `spokenText`/`compressed` 字段；SKILL.md 要求 agent 原文始终在会话文字给出
- 实机：130+ 字汇报被 Qwen3.8 压缩为"……压缩至百字内再播报……"（约 60 字），用户回复"方案不错，落盘稳当"
- 单元测试 5 项（短文本/截断/LLM 命中/失败回退/LLM 超长收敛），合计 57 项全绿

## 正名清理（2026-09-20）
- 用户指正"GLM 云端 ASR"名不副实——本项目全程无云端依赖：TTS=Kokoro-82M、STT=SenseVoice-Small、压缩=Qwen3.8-27B，全部自托管于 gpu-host
- `phone-transcription-glm.mjs` → `phone-transcription-http.mjs`（类 PhoneTranscriptionHttp，意为任意 OpenAI 兼容端点）
- `GLM_API_KEY` → `SPEECH_API_KEY`（代码保留 GLM_API_KEY 作为遗留 fallback，四台 .env 已切换）；TTS/STT provider 标识 'glm' → 'http'
- 默认模型名对齐自托管实况：STT=SenseVoice-Small、TTS=kokoro-82M/zf_xiaoxiao
- 57 项测试全绿；companion 重启后 RPC 实测正常
