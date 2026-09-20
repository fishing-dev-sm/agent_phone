# HT802V2 固件坑位记录

本项目实测设备为 **HT802V2**（V2 硬件修订版，MAC 前缀 `14:4C:FF`）。它的管理面和 P 值语义与老 HT802（V1）差异很大，上游 codex-redline 的配置脚本不兼容。以下全部为本机实测结论。

## 管理 API（新 SPA 界面）

老接口（表单页 + `gnkey` + `update`）已不存在，新接口反而更干净：

| 用途 | 方法 | 说明 |
|---|---|---|
| 登录 | `POST /cgi-bin/dologin` | 参数 `username=admin`、`P2=base64(密码)`。**密码必须 base64**，明文会被拒且错误计数疑似不减 |
| 读配置 | `POST /cgi-bin/api.values.get` | 参数 `request=P47:P35:...`（冒号分隔），**cookie 与 `session_token` 两者都要**，缺一返回空 error |
| 写配置 | `POST /cgi-bin/api.values.post` | P 值 + `update=1`；**写后会话立即失效**，回读校验前必须重新登录 |
| 重启 | `POST /cgi-bin/rs` | 设备可能直接断连，忽略异常 |
| 设备信息 | `POST /cgi-bin/api-get_system_base_info` | 返回 `{"product":"HT802V2", ...}`，POST 必须带 `Content-Length`（哪怕为 0） |

登录响应：`{"session_token":..., "role":"admin", "default_auth":...}`，同时种 `session_id` cookie。会话几分钟即过期，脚本应现用现登。

新批次默认管理密码印在**机身标签**上（不再是 admin/admin）；连续输错会锁定（响应 `remain N` / `locked`）。

## 电话功能 P 值语义差异（V2 vs V1/上游假设）

| P 值 | V2 含义 | 本项目取值 | 备注 |
|---|---|---|---|
| `P271` | FXS1 Account Active（激活账号） | `1` | **V2 出厂为 0，摘机直接忙音**——首个坑 |
| `P47` | Primary SIP Server | `host:5090` | 与 V1 一致 |
| `P4060` | SIP User ID | `redline` | **V2 的 User ID 是 P4060 不是 P35**，对不上则来电静默丢弃（无 4xx） |
| `P31` | **SIP Registration 开关** | `1` | V1 语义是"重启时注销"，上游脚本置 0——**V2 上置 0 等于关闭注册，设备不开口监听** |
| `P20501` | Use Random SIP Port（FXS1） | `0` | **V2 出厂为 1**：信令走临时端口（实测 13026），向 5060 拨入 ICMP unreachable |
| `P20505` | Use Random RTP Port | `0` | 同上，固定住便于对端校验源端口 |
| `P40` | FXS1 Local SIP Port | `5060`（默认） | 固定端口生效后的监听口 |
| `P71` | Off-hook Auto Dial | `263` | 摘机自动拨叫的号码（companion 不校验被叫） |
| `P850` | DTMF payload type | `101`（默认） | RFC 4733 telephone-event |
| `P870` | （上游沿用） | `0`（默认） | |
| `P4010` | 振铃节奏 | `c=2000/4000;`（默认） | 响 2 秒停 4 秒 |
| `P4045` | （上游沿用） | `0`（默认） | |

## 排障手法（已验证有效）

1. **找不到设备 IP**：ping 扫段 → 按 MAC 厂商查（`api.macvendors.com`）→ 注意 V2 的 OUI `14:4C:FF` 不在常见 Grandstream 老前缀列表里
2. **判断 UDP 端口是否监听**：无 root 时用"connected UDP socket 连发两包再 recv"，收到 `ECONNREFUSED` = 对端发了 ICMP port unreachable = 端口关闭
3. **抓 SIP 包**：无 tcpdump 时用 Python UDP socket 起临时监听，自动应答 REGISTER/OPTIONS、对 INVITE 回 486——本次用它发现设备源端口是 13026 从而定位随机端口问题
4. **RTP 接通后的首个音频会被吞**：媒体路径 warmup 约几百毫秒，提示音前要垫 0.5–1 秒静音（companion 已处理）
