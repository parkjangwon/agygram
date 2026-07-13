# agygram

[English](README.md) · [최신 릴리즈](https://github.com/parkjangwon/agygram/releases/latest) · [설치 상세](docs/MANAGED_INSTALL.md)

Google Antigravity CLI(`agy`)를 Telegram에서 제어하는 헤드리스 봇입니다.

agygram은 “서버에 `agy` CLI가 있고, 나는 폰에서 Telegram으로 조종하고 싶다”는 흐름을 위해 만들었습니다. IDE 없이, 매일 데스크톱 세션을 열 필요 없이, 최초 OAuth 인증까지 Telegram에서 끝내는 것이 목표입니다.

## 3분 설치

필요한 것은 세 가지입니다.

1. Telegram [@BotFather](https://t.me/BotFather)에서 만든 bot token
2. Node.js 22 또는 24
3. agygram을 실행할 같은 OS 사용자에서 동작하는 `agy`

그 다음 OS에 맞는 설치 명령을 실행하세요.

macOS 또는 Linux:

```sh
(umask 077; f=$(mktemp "${TMPDIR:-/tmp}/agygram-install.XXXXXXXX") || exit; trap 'rm -f "$f"' 0 HUP INT TERM; curl -qfsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 10 --max-time 120 --retry 3 -o "$f" https://github.com/parkjangwon/agygram/releases/latest/download/install.sh && sh -n "$f" && sh "$f" --setup)
```

Windows PowerShell:

```powershell
& { $ErrorActionPreference = 'Stop'; $d = Join-Path ([IO.Path]::GetTempPath()) ("agygram-install-{0}" -f [Guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $d | Out-Null; $f = Join-Path $d 'install.ps1'; Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri 'https://github.com/parkjangwon/agygram/releases/latest/download/install.ps1' -OutFile $f; powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $f --setup; Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
```

명령이 긴 이유는 의도적입니다. 설치 파일을 private 임시 파일로 받은 뒤 검사하고 실행합니다. `curl | sh` 방식은 쓰지 않습니다.

설정 마법사는 bot token을 받고, 봇에게 `/start`를 보내도록 안내한 뒤, private chat/user ID를 자동 탐지합니다. 이어서 `agy`를 찾고, private config를 작성하고, 플랫폼 검사가 통과하면 사용자 단위 백그라운드 서비스를 설치합니다.

그 다음 Telegram에서:

1. `/menu` 전송
2. `🔐 인증` 버튼 선택
3. OAuth URL을 열고 authorization code를 Telegram에 붙여넣기
4. 일반 메시지를 보내서 `agy` 작업 시작

성공하면 이렇게 보입니다.

- `/menu`가 버튼 패널을 보여줍니다.
- `/info`가 실행 중인 agygram 버전을 보여줍니다.
- `/auth`가 Antigravity 터미널 UI 잡음 없이 필요한 URL/코드 안내만 보여줍니다.

원격 서버의 다른 코딩 에이전트에게 이 리포를 맡길 때는 보통 아래 프롬프트면 충분합니다.

```text
Install agygram from https://github.com/parkjangwon/agygram.
Use the managed installer, configure my Telegram bot token, start the user service,
then verify from Telegram that /menu opens and /auth starts headless OAuth.
```

## 제공 기능

- Telegram-native `agy` 제어: 대화, plan/apply, `/menu` 버튼 패널, 버튼 기반 model/agent/skill/mode 전환, 업로드, 작업 기록, 재시도, 결과 복구
- 원격 Linux 서버 같은 no-IDE 환경을 위한 headless OAuth
- 사용자 단위 native service: macOS launchd, Linux systemd user service, Windows Task Scheduler
- 검증된 릴리즈 설치/업데이트와 data 보존 언인스톨
- 보수적인 기본값: sandbox on, owner-only auth/update, allowlist, 실행/저장 한도

## 운영 명령

설치기가 출력한 launcher directory를 `PATH`에 추가한 뒤 사용할 수 있습니다.

```sh
agygram --version
agygram doctor
agygram service status
agygram setup
```

같은 설치 명령을 다시 실행하면 업데이트 또는 복구가 됩니다. managed 릴리즈 설치본 또는 clean source checkout에서는 owner가 Telegram에서 `/update`, `/update apply`도 사용할 수 있습니다.

설정, 런타임 데이터, workspace, Antigravity 인증 정보는 보존하면서 제거하려면 [설치 상세](docs/MANAGED_INSTALL.md#uninstall)의 uninstaller를 사용하세요.

## Telegram 명령어

| 명령 | 용도 |
| --- | --- |
| 일반 메시지 | 선택된 workspace에서 `agy` 요청 실행 |
| `/menu` / `/help` | Telegram 버튼 조작 패널 열기. `/help full`은 전체 텍스트 명령 목록 출력 |
| `/plan <요청>` / `/apply [추가 지시]` | 계획 생성 후 sandbox code 모드로 적용 |
| `/new`, `/workspace`, `/project` | 새 대화 또는 프로젝트 문맥 전환 |
| `/model`, `/agent`, `/skills`, `/mode`, `/sandbox`, `/yolo` | Telegram 버튼으로 실행 설정 조회/변경. `/skills 검색어`로 긴 skill 목록 검색 |
| `/status`, `/jobs`, `/last`, `/retry` | 작업 상태 확인/복구 |
| `/auth` / `/cancel` | 인증 또는 현재 요청 취소 |
| `/update` / `/update apply` | 공식 immutable 릴리즈 확인/적용 |
| `/info`, `/clear`, `/reset`, `/help` | 상태 확인, 최근 채팅 정리, 세션 초기화, 도움말 |

문서와 사진은 해당 요청에서만 쓰이는 격리 업로드 디렉터리에 저장됩니다.

`/clear`는 Telegram이 허용하는 최근 봇/사용자 메시지를 삭제하는 채팅창 정리 기능입니다. 개인 채팅에서는 메시지 추적 기능이 켜지기 전에 생긴 흔적도 정리할 수 있도록 제한된 최근 메시지 ID 범위를 넓게 훑습니다. agy 대화 상태는 유지됩니다. 현재 세션, 업로드, 로컬 대화 문맥까지 초기화하려면 `/reset`을 사용하세요.

## 중요 사항

- 전용 저권한 OS 계정과 좁은 workspace를 권장합니다. 이 프로젝트는 신뢰된 운영자용 도구이며 다중 테넌트 격리 서비스가 아닙니다.
- OS 사용자/keyring 하나에는 Antigravity 계정도 하나입니다. 같은 봇 인스턴스의 모든 허용 채팅은 그 계정을 공유합니다.
- unsandboxed 실행을 명시적으로 허용할 때까지 `ALLOW_UNSANDBOXED_RUNS=false`를 유지하세요. `/yolo`는 추가로 `ALLOW_UNSANDBOXED_AUTO_APPROVE=true`가 필요합니다.
- Windows 서비스 설치는 config/data ACL 검토 후 `WINDOWS_ACL_VERIFIED=true`가 필요합니다. 마법사는 설정을 준비하지만 이 보안 증명을 자동으로 꾸며내지 않습니다.

설치 옵션, rollback, 릴리즈 검증, Windows ACL 명령, 문제 해결은 [Managed install, update, and uninstall](docs/MANAGED_INSTALL.md)에 있습니다. 서비스 경로와 플랫폼 운영은 [Cross-platform operations](docs/CROSS_PLATFORM_OPERATIONS.md)를 참고하세요.

## 라이선스

[MIT](LICENSE)
