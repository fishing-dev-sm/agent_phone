# 开源发布记录（2026-09-30）

- 公开仓库：https://github.com/fishing-dev-sm/agent_phone
- 首次提交：`96af4ee` "Initial public release"（全新 git 历史，不含上游私有历史）

## 发布前审计结论

- `.gitignore` 已保护、未外泄：`.env`（SPEECH_API_KEY）、`client/phone-report.env`（PHONE_RPC_TOKEN 真实值）、`.runtime/`（HT802 配置备份、日志、汇报存档）、`node_modules/`
- `test/` 中的 token 与 IP 均为假值；`src/` 默认地址 `192.168.82.x` 本来就是占位值

## 脱敏方案（只记录占位映射，真实值永不入库）

| 角色 | 文档/代码中的占位 |
|---|---|
| companion 主机 | `192.168.1.10`（SIP 5090 / RTP 15004 / RPC 5091） |
| HT802 设备 | `192.168.1.150` |
| 语音/LLM GPU 主机 | `192.168.1.20`，叙述中称 `gpu-host` |
| 设备 MAC | 只保留 OUI 前缀 `14:4C:FF`（HT802V2 批次通用），后三段 `xx:xx:xx` |

涉及文件：`README.md`、`docs/verification.md`、`skills/phone-report/SKILL.md`、`ht802-configure.py`（默认值）、`client/phone-report.mjs`（默认 host）、`client/phone-report.env.example`、`.env.example`、`src/phone-transcription-http.mjs`（注释）。

## 决策记录

- 内网信息**全部匿名化**（不留真实 RFC1918 地址与主机名）
- README 英文为主；`docs/` 保留中文
- 上游 `codex-redline` 为本地私有仓库：文字署名、不附链接、MIT 许可保留
- LICENSE 版权行两行：`Codex REDLINE contributors` + `fishing-dev-sm`

## 仓库配置（换机器/重克隆时注意）

- remote：`git@github-fishing:fishing-dev-sm/agent_phone.git` —— 走 `~/.ssh/config` 的 `github-fishing` 别名（专用 key `id_ed25519_fishing_dev_sm`）。直推 `git@github.com` 会用默认 key 认证成另一账号而被拒
- 仓库本地身份：`git config --local user.name fishing-dev-sm`、`user.email fishing-dev-sm@users.noreply.github.com`

## 维护纪律（后续提交）

- 新文档/代码一律使用上表占位地址；真实拓扑只写 `.runtime/` 或私人笔记
- 凭据只进 `.env` / `client/phone-report.env`（均已 gitignore）；提交前可用 `grep -rn '192\.168\.2\.' --exclude-dir=.git .` 复查
- 电话通话内容、转写、reportId 不写入项目任何产物（纪律见 `skills/phone-report/SKILL.md`）

## 待办

- GitHub 网页确认仓库可见性为 Public
- 补 About 描述与 topics（建议：`sip` `tts` `stt` `grandstream` `coding-agent`）
