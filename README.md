# Antigravity Telegram CLI Bot

[한국어](README.ko.md) · [Latest release](https://github.com/parkjangwon/antigravity-telegram-cli/releases/latest) · [Installation guide](docs/MANAGED_INSTALL.md)

Control Google Antigravity CLI (`agy`) from Telegram on macOS, Linux, or Windows. The bot runs headlessly as the current OS user; no IDE is required.

## What you get

- Telegram conversations, plans, sandboxed code execution, uploads, jobs, and retry/recovery.
- Full Telegram OAuth: open the displayed URL anywhere, send the code to the bot, and it completes/validates the first-run CLI setup.
- Owner-only `/update apply` for an official, clean source checkout.
- A per-user native service: launchd, systemd user service, or Task Scheduler.
- Safe defaults: plan mode, sandbox enabled, narrow allowlists, bounded execution and storage.

## Requirements

- Node.js **22 or 24**
- A native `agy` executable available to the same OS user as the bot (`agy.exe` on Windows)
- Telegram bot token, allowed chat ID, and owner user ID

Use a dedicated low-privilege OS account and a narrow workspace. This is a trusted-operator bot, not a multi-tenant sandbox.

## Install

Use the verified one-line installer from the [managed installation guide](docs/MANAGED_INSTALL.md). It keeps code, configuration, data, and workspace separate; rerunning it updates or repairs the installation.

On first run, edit the generated `.env` with at least:

```dotenv
BOT_TOKEN=123456:replace-me
ALLOWED_CHAT_IDS=123456789
OWNER_USER_IDS=123456789
AGY_BIN=/absolute/path/to/agy
WORKSPACE_DIR=/absolute/path/to/workspace
```

Then rerun the installer. On Windows, complete the documented ACL review and set `WINDOWS_ACL_VERIFIED=true` before service installation.

For a development/source checkout, see [Cross-platform operations](docs/CROSS_PLATFORM_OPERATIONS.md).

## First authentication

1. Send `/start` from an allowed chat.
2. In the owner's private chat, send `/auth`.
3. Open the OAuth URL on any browser and send the returned code as a normal Telegram message.
4. The bot completes the CLI's first-run setup and verifies the credential with a real headless request.

One OS user/keyring means one effective Antigravity account shared by every allowed chat on that bot instance.

## Telegram commands

| Command | Purpose |
| --- | --- |
| Plain text | Send a request to `agy` in the selected workspace. |
| `/plan <request>` / `/apply [notes]` | Create a plan, then apply it in sandboxed code mode. |
| `/new`, `/workspace`, `/project` | Start fresh or change project context. |
| `/model`, `/agent`, `/mode`, `/sandbox` | Inspect or change session execution settings. |
| `/status`, `/jobs`, `/last`, `/retry` | Inspect or recover work. |
| `/auth` / `/cancel` | Authenticate or cancel the current request. |
| `/update` / `/update apply` | Check for and apply an immutable official release (source checkout only). |
| `/info`, `/reset`, `/help` | Inspect, reset, or show help. |

Documents and photos are placed in an isolated upload directory for that single request.

## Security and operations

- Keep `ALLOW_UNSANDBOXED_RUNS=false` unless you deliberately accept unsandboxed agent execution.
- Group chats require `ALLOWED_USER_IDS`; only configured owners can authenticate or update.
- Do not put secrets in prompts: `agy --print` arguments can be visible to privileged local processes.
- Use `agygram doctor` and `agygram service status` for managed installations.

For limits, service behavior, threat boundaries, rollback, and platform-specific troubleshooting, read [Cross-platform operations](docs/CROSS_PLATFORM_OPERATIONS.md) and [design notes](docs/DESIGN.md).

## License

[MIT](LICENSE)
