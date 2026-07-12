# Antigravity Telegram CLI Bot

[English](README.md) · [최신 릴리즈](https://github.com/parkjangwon/antigravity-telegram-cli/releases/latest) · [설치 안내](docs/MANAGED_INSTALL.md)

Google Antigravity CLI(`agy`)를 Telegram에서 제어하는 헤드리스 봇입니다. macOS, Linux, Windows에서 IDE 없이 현재 OS 사용자 계정으로 동작합니다.

## 핵심 기능

- Telegram 대화, 계획, sandbox 코드 실행, 파일 업로드, 작업 기록·재시도·복구
- Telegram만으로 OAuth 완료: URL 열기 → 코드 전송 → 최초 CLI 설정과 실제 headless 인증 검증
- 공식 source checkout에서 owner 전용 `/update apply` 업데이트
- launchd, systemd user service, Windows Task Scheduler 기반 사용자 단위 서비스
- 기본 plan 모드, sandbox, allowlist, 실행·저장 한도

## 요구 사항

- Node.js **22 또는 24**
- 봇과 같은 OS 사용자로 실행 가능한 native `agy` 실행 파일(Windows는 `agy.exe`)
- Telegram 봇 토큰, 허용 chat ID, owner user ID

전용 저권한 OS 계정과 좁은 workspace를 권장합니다. 이 프로젝트는 신뢰된 운영자용 도구이며 다중 테넌트 격리 서비스가 아닙니다.

## 설치

[관리형 설치 안내](docs/MANAGED_INSTALL.md)의 검증된 원라인 설치 명령을 사용하세요. 코드·설정·data·workspace를 분리하며, 같은 명령을 다시 실행하면 업데이트 또는 복구가 됩니다.

첫 설치 뒤 생성된 `.env`에 최소 다음 값을 넣으세요.

```dotenv
BOT_TOKEN=123456:replace-me
ALLOWED_CHAT_IDS=123456789
OWNER_USER_IDS=123456789
AGY_BIN=/absolute/path/to/agy
WORKSPACE_DIR=/absolute/path/to/workspace
```

그 뒤 installer를 다시 실행합니다. Windows에서는 문서의 ACL 검토를 끝내고 `WINDOWS_ACL_VERIFIED=true`를 설정해야 서비스를 설치할 수 있습니다.

개발용 source checkout 설치는 [Cross-platform operations](docs/CROSS_PLATFORM_OPERATIONS.md)를 참고하세요.

## 최초 인증

1. 허용된 채팅에서 `/start`
2. owner의 개인 채팅에서 `/auth`
3. 표시된 OAuth URL을 아무 브라우저에서 열고, 발급 코드를 일반 Telegram 메시지로 전송
4. 봇이 최초 CLI 설정을 마치고 실제 headless 요청으로 인증을 검증

OS 사용자/keyring 하나에는 Antigravity 계정도 하나입니다. 이 봇의 모든 허용 채팅은 그 계정을 공유합니다.

## Telegram 명령어

| 명령 | 용도 |
| --- | --- |
| 일반 메시지 | 선택된 workspace에서 `agy` 요청 실행 |
| `/plan <요청>` / `/apply [추가 지시]` | 계획 생성 후 sandbox code 모드로 적용 |
| `/new`, `/workspace`, `/project` | 새 대화 또는 프로젝트 문맥 전환 |
| `/model`, `/agent`, `/mode`, `/sandbox` | 세션 실행 설정 조회·변경 |
| `/status`, `/jobs`, `/last`, `/retry` | 작업 상태 확인·복구 |
| `/auth` / `/cancel` | 인증 또는 현재 요청 취소 |
| `/update` / `/update apply` | 최신 immutable 공식 릴리즈 확인·적용(source checkout 전용) |
| `/info`, `/reset`, `/help` | 상태, 초기화, 도움말 |

문서와 사진은 해당 요청에서만 쓰이는 격리 업로드 디렉터리에 저장됩니다.

## 보안과 운영

- unsandboxed 실행을 명시적으로 허용할 때까지 `ALLOW_UNSANDBOXED_RUNS=false`를 유지하세요.
- 그룹 채팅에는 `ALLOWED_USER_IDS`가 필요하며, 인증·업데이트는 owner만 실행할 수 있습니다.
- prompt에 secret을 넣지 마세요. `agy --print` 인자는 권한 있는 로컬 프로세스에 보일 수 있습니다.
- 관리형 설치에서는 `agygram doctor`, `agygram service status`로 점검하세요.

한도, 서비스 동작, 위협 경계, rollback, 플랫폼별 문제 해결은 [Cross-platform operations](docs/CROSS_PLATFORM_OPERATIONS.md)와 [설계 문서](docs/DESIGN.md)에 있습니다.

## 라이선스

[MIT](LICENSE)
