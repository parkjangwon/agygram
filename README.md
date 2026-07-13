# agygram

[한국어](README.ko.md) · [Latest release](https://github.com/parkjangwon/agygram/releases/latest) · [Install details](docs/MANAGED_INSTALL.md)

Run Google Antigravity CLI (`agy`) from Telegram on macOS, Linux, or Windows.

agygram is for the “I have a server, an `agy` CLI, and I want to drive it from my phone” workflow: no IDE, no daily desktop session, and first OAuth authentication from Telegram.

## 3-minute setup

You need three things:

1. A Telegram bot token from [@BotFather](https://t.me/BotFather).
2. Node.js 22 or 24.
3. `agy` installed and working for the same OS user that will run agygram.

Then run the installer for your OS.

macOS or Linux:

```sh
(umask 077; f=$(mktemp "${TMPDIR:-/tmp}/agygram-install.XXXXXXXX") || exit; trap 'rm -f "$f"' 0 HUP INT TERM; curl -qfsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 10 --max-time 120 --retry 3 -o "$f" https://github.com/parkjangwon/agygram/releases/latest/download/install.sh && sh -n "$f" && sh "$f" --setup)
```

Windows PowerShell:

```powershell
& { $ErrorActionPreference = 'Stop'; $d = Join-Path ([IO.Path]::GetTempPath()) ("agygram-install-{0}" -f [Guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $d | Out-Null; $f = Join-Path $d 'install.ps1'; Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri 'https://github.com/parkjangwon/agygram/releases/latest/download/install.ps1' -OutFile $f; powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $f --setup; Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
```

The command is long on purpose: it downloads the installer into a private temporary file, checks it, and then runs it. No `curl | sh`.

The wizard will ask for your bot token, ask you to send `/start` to the bot, auto-detect your private chat/user IDs, find `agy`, write a private config, and install a user-level background service when the platform checks pass.

Then open Telegram:

1. Send `/menu`.
2. Tap `🔐 Auth`.
3. Open the OAuth URL, paste the authorization code back into Telegram.
4. Send a normal message and let `agy` work.

Success looks like this:

- `/menu` shows a button panel.
- `/info` shows the running agygram version.
- `/auth` sends only the useful URL/code prompts, not the noisy Antigravity terminal UI.

If you are handing this repo to another coding agent on a remote server, this prompt is usually enough:

```text
Install agygram from https://github.com/parkjangwon/agygram.
Use the managed installer, configure my Telegram bot token, start the user service,
then verify from Telegram that /menu opens and /auth starts headless OAuth.
```

## What You Get

- Telegram-native control for `agy`: chat, plan/apply, a `/menu` button panel, button-based model/agent/skill/mode switching, uploads, jobs, retries, and result recovery.
- Headless OAuth designed for remote Linux servers and other no-IDE environments.
- Managed per-user service: launchd on macOS, systemd user service on Linux, Task Scheduler on Windows.
- Verified release installer/updater and data-preserving uninstaller.
- Conservative defaults: sandbox on, owner-only auth/update, allowlists, execution limits, storage limits.

## Day-Two Commands

After the launcher directory printed by the installer is on `PATH`:

```sh
agygram --version
agygram doctor
agygram service status
agygram setup
```

Rerun the same install command any time to update or repair the managed installation. Owners can also use `/update` and `/update apply` in Telegram from a managed release install or a clean source checkout.

To uninstall while keeping your config, runtime data, workspace, and Antigravity credentials, use the matching uninstaller from [Install details](docs/MANAGED_INSTALL.md#uninstall).

## Telegram Commands

| Command | Purpose |
| --- | --- |
| Plain text | Send a request to `agy` in the selected workspace. |
| `/menu` / `/help` | Open the Telegram button control panel. `/help full` prints the full text command list. |
| `/plan <request>` / `/apply [notes]` | Create a plan, then apply it in sandboxed code mode. |
| `/new`, `/workspace`, `/project` | Start fresh or change project context. |
| `/model`, `/agent`, `/skills`, `/mode`, `/sandbox`, `/yolo` | Open Telegram buttons to inspect or change execution settings. `/skills query` searches long skill lists. |
| `/status`, `/jobs`, `/last`, `/retry` | Inspect or recover work. |
| `/auth` / `/cancel` | Authenticate or cancel the current request. |
| `/update` / `/update apply` | Check and apply an official immutable release. |
| `/info`, `/clear`, `/reset`, `/help` | Inspect state, clean recent chat messages, reset session state, or show help. |

Documents and photos are stored in an isolated upload directory for the single request that uses them.

`/clear` deletes recently tracked bot/user messages when Telegram permits it. In private chats it also sweeps a bounded recent message-ID range so clutter created before message tracking was enabled can usually be cleaned once. It is a chat cleanup tool; it does not reset agy conversation state. Use `/reset` only when you want to clear the current session, uploads, and local conversation context.

## Important Notes

- Use a dedicated low-privilege OS account and a narrow workspace. This is a trusted-operator tool, not a multi-tenant sandbox.
- One OS user/keyring means one effective Antigravity account shared by every allowed chat on that bot instance.
- Keep `ALLOW_UNSANDBOXED_RUNS=false` unless you deliberately accept unsandboxed agent execution. `/yolo` additionally requires `ALLOW_UNSANDBOXED_AUTO_APPROVE=true`.
- Windows service installation requires a config/data ACL review before `WINDOWS_ACL_VERIFIED=true`; the wizard prepares the config but does not fake that attestation.

Full installer options, rollback behavior, release verification, Windows ACL commands, and troubleshooting live in [Managed install, update, and uninstall](docs/MANAGED_INSTALL.md). Service paths and platform operations are in [Cross-platform operations](docs/CROSS_PLATFORM_OPERATIONS.md).

## License

[MIT](LICENSE)
