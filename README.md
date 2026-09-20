# AGENT_PHONE

[![GitHub License](https://img.shields.io/github/license/fishing-dev-sm/agent_phone)](./LICENSE)

Turn a Grandstream HT802 analog telephone gateway into a phone interface shared by coding agents across multiple LAN hosts: pick up the handset and speak to hand a task to an agent; when the agent finishes, the phone rings and the reply is read aloud.

**This repository is a fork of `codex-redline`** (a private upstream project; the upstream author keeps the MIT license — see [LICENSE](./LICENSE)). This fork retargets the architecture to **Kimi Code + multi-host sharing**, and replaces the OpenAI voice backend with **self-hosted open models** (SenseVoice + Kokoro) — no cloud dependency anywhere.

> Note: the milestone log and firmware notes under [docs/](docs/) are in Chinese.

## Verification status (on real hardware, 2026-09-20)

| Milestone | Content | Status |
|---|---|---|
| M1 | HT802V2 on the LAN (router DHCP reservation), provisioning script writes config and reboots | ✅ |
| M2 | companion daemon resident (SIP :5090 / RTP 15004) | ✅ |
| M3 | Inbound: off-hook → Off-hook Auto Dial → companion answers → prompt tone | ✅ |
| M4 | Outbound: `test-ring` rings on c=2000/4000 cadence → off-hook plays dual tone | ✅ |
| M5 | Voice loop: `test-say` TTS (Kokoro zf_xiaoxiao); `test-transcription` speak → hang up → SenseVoice returns text | ✅ |
| M6 | Engine on a dedicated host (systemd) + TCP+token RPC + phone-report skill (works for Kimi Code and Codex CLI); `say`/`ask` pass end-to-end | ✅ |
| M7 | Busy-line policy: server-side FIFO queue (cap 8) + auto-retry ×5 on no answer + text archive of every report (phone-reports.jsonl) | ✅ |
| M8 | Reporting discipline: default to `ask`; call details never written into project artifacts; hard length limit relaxed to soft compression | ✅ |
| M9 | Server-side LLM compression of overlong reports (Qwen3 via SSH tunnel); original + spoken version both archived | ✅ |

Unit tests: `npm test` — 57 tests, all green.

## Architecture

```
kimi / codex (any host)
  └─ skill "phone-report" → client/phone-report.mjs (node, zero dependencies)
        │ TCP + token (companion:5091)
        ▼
desk phone ─ FXS ─ HT802V2 ──LAN(UDP SIP/RTP)── companion (systemd agent-phone.service)
                                                │  HTTP (OpenAI-compatible)
                                                ├── TTS: http://speech-host:8300/v1/audio/speech         (Kokoro-82M)
                                                ├── STT: http://speech-host:8300/v1/audio/transcriptions (SenseVoice-Small)
                                                └── long-text compression: 127.0.0.1:8301 →(SSH tunnel)→ gpu-host llama.cpp (Qwen3)
```

- The companion is the single "line owner": one FXS port = one concurrent call, and an off-hook INVITE only goes to the configured SIP server
- The companion runs as a systemd user service and exposes two interfaces: a local unix socket (management) + LAN TCP RPC (port 5091, token auth) for agents on any host
- The speech service is deployed independently (any OpenAI-compatible endpoint works — SenseVoice + Kokoro are just the reference setup)
- Overlong reports (>100 chars) are compressed server-side by an LLM before being spoken (`compressForSpeech`; falls back to sentence-boundary truncation, always ≤100 chars). The compression LLM is reached over an SSH tunnel so llama-server stays bound to localhost; when `PHONE_CHAT_ENDPOINT` is unset, truncation is the fallback

## phone-report skill (agents calling you)

Works with both Kimi Code and Codex CLI; install with `skills/install.sh` (idempotent) into `~/.agents/skills/phone-report` and `~/.codex/skills/phone-report`. When the user says "电话汇报 / phone report / call me", the agent runs:

```sh
set -a; . /path/to/AGENT_PHONE/client/phone-report.env; set +a   # loads PHONE_RPC_TOKEN etc.
node /path/to/AGENT_PHONE/client/phone-report.mjs say "Build finished, 43 tests passed."        # one-way announcement
node /path/to/AGENT_PHONE/client/phone-report.mjs ask "May I wipe the test DB? Hang up when done." # announce + await spoken reply
node /path/to/AGENT_PHONE/client/phone-report.mjs status
```

`ask`/`say` return `{"delivered":bool,"answered":bool,"spokenText":"what was actually spoken","compressed":bool,"attempts":N,"reportId":"..."}` (`ask` adds `"text":"transcript"`). Hanging up is the submit signal; overlong originals are compressed automatically, and the agent must always give the full text in the session.

## Quick start

```bash
npm ci
cp .env.example .env   # fill in SPEECH_API_KEY (Bearer key of your speech service) and your LAN addresses
set -a; . ./.env; set +a
node src/phone-control.mjs start
```

Self-check commands (no agent binding needed):

```bash
node src/phone-control.mjs status                    # daemon and line state
node src/phone-control.mjs test-ring                 # ring twice; pick up to hear a dual tone
node src/phone-control.mjs test-say "text to speak"  # ring; TTS plays after pickup
node src/phone-control.mjs test-transcription        # arms for 120s; speak after the beep, hang up, read text via status
node src/phone-control.mjs stop
```

## HT802 provisioning

`ht802-configure.py` targets the **HT802V2 new firmware** (SPA management interface — not compatible with the older model's API):

```bash
HT802_PASSWORD=<label password> HT802_EXPECTED_MAC=14:4C:FF:xx:xx:xx \
  python3 ht802-configure.py inspect     # read-only echo
  python3 ht802-configure.py configure   # write SIP config and reboot (backs up original config first)
  python3 ht802-configure.py restore     # roll back from backup
```

Key values written to the device: SIP server → companion (`P47`), User ID `redline` (`P4060`), account active (`P271`), SIP registration on (`P31`), fixed SIP/RTP ports (`P20501/P20505=0`), Off-hook Auto Dial 263 (`P71`), ring cadence (`P4010`). **All V2 firmware pitfalls are documented in [docs/ht802v2-firmware.md](docs/ht802v2-firmware.md)** (Chinese) — re-run `configure` after swapping or resetting a device.

## Roadmap (not done yet)

1. **Kimi Code hooks auto-reporting**: `[[hooks]]` in `~/.kimi-code/config.toml` (Stop/UserPromptSubmit events) → ring and read the reply when a task ends; voice input injected into the session via the `kimi web` REST API (`POST /api/v1/sessions/{id}/prompts`) — replacing upstream's macOS accessibility typing, so the whole `native/` Swift chain is unnecessary
2. **Multi-host binding arbitration**: open up `hostId` in binding records; single-active-binding policy (single-line hardware reality); the RPC already supports concurrent multi-host access with clear busy errors
3. Long-form transcription (server cap is currently 120 s), optional TTS upgrade to CosyVoice 3

## Layout

```
src/                    all companion source (telephony stack is agent-agnostic and reusable)
  phone-sip.mjs           SIP/RTP/DTMF protocol stack (incl. REGISTER handling)
  phone-control.mjs       daemon + CLI + RPC (unix socket management + TCP token network face; say/ask/test-*)
  phone-audio.mjs         μ-law codec, TTS (switchable provider), speech compression
  phone-transcription.mjs OpenAI realtime transcription (kept as an alternative)
  phone-transcription-http.mjs  file-based transcription (self-hosted SenseVoice or any OpenAI-compatible endpoint)
  phone-binding.mjs       binding records (hostId field reserved for multi-host)
  phone-replies.mjs       reply queue and ring playback
  phone-capture.mjs       one-shot transcription test
  phone-archive.mjs       reply audio archiving (WAV)
  phone-input/microphone/voice/followup.mjs  voice submission chain (pending Kimi-side rework)
client/phone-report.mjs   zero-dependency TCP RPC client (say/ask/status), invoked by agents via the skill
skills/phone-report/      Kimi/Codex-universal skill (SKILL.md); skills/install.sh installs idempotently
test/                     unit tests (node --test)
ht802-configure.py        HT802V2 provision / backup / rollback
docs/                     firmware pitfalls, acceptance log (Chinese)
```

Upstream content intentionally not migrated (not needed here): `native/` (macOS Swift: accessibility typing, BlackHole microphone bridge), `phone_hook.py` / `install-phone-hooks.py` (Codex hooks), `skills/redline-phone-bind` (Codex skill).

## Credits

- **codex-redline** — the upstream project this fork derives from (private repository; the upstream author's design, MIT license retained).
- [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) — speech recognition.
- [Kokoro](https://github.com/hexgrad/kokoro) — text to speech.
