# Dev Blackbox

[English documentation](README.md)

AI 코딩 에이전트를 위한 로컬 실행 기록기입니다. 프로젝트의 개발 명령을
터미널 기록기와 로컬 네트워크 collector를 통해 실행하고, 실패 정보를
마스킹된 구조화 인시던트와 Markdown 보고서로 남깁니다.

## 설치 및 자동 연결

```bash
npm install --save-dev dev-blackbox
npx dev-blackbox init --auto
npm run dev
```

`init --auto`는 다음 작업을 수행합니다.

- `.dev-blackbox/config.yml`을 만들고 `.dev-blackbox/`를 `.gitignore`에 추가
- AI 에이전트 규칙을 `CLAUDE.md`와 `AGENTS.md`에 추가
- 기존 `dev` 명령을 `dev:original`로 보존
- `dev`를 `dev-blackbox dev -- npm run dev:original`로 변경

의존성이 사용자 프로젝트를 몰래 변경하지 않도록 `npm install`만으로는
스크립트를 수정하지 않습니다. 로컬 실행 파일
`node_modules/.bin/dev-blackbox`가 없으면 `init --auto`도 `package.json`을
변경하지 않고 설치 안내를 출력합니다.

`start` 등 다른 npm 스크립트에 연결하려면 다음처럼 실행합니다.

```bash
npx dev-blackbox init --auto --script start
```

이미 존재하는 `<스크립트>:original`은 덮어쓰지 않으며 초기화 명령을 여러
번 실행해도 중복 설정되지 않습니다.

연결 후에는 평소 명령 하나로 모두 실행됩니다.

```text
npm run dev
  -> Dev Blackbox 기록기
     -> 127.0.0.1:4319 로컬 collector
     -> 프로젝트의 원래 dev 명령
     -> Node.js fetch 자동 계측
```

## 오류와 네트워크 보고서

프로세스·빌드·테스트 실패는 중복 제거되는 인시던트를 생성합니다.

```text
.dev-blackbox/reports/incidents/INC-20260718-001.md
```

수집된 네트워크 요청이 실패하면 다음 보고서들이 서로 연결됩니다.

```text
.dev-blackbox/reports/incidents/INC-20260718-002.md
.dev-blackbox/reports/network/REQ-20260718-001.md
.dev-blackbox/reports/NETWORK.md
```

실패별 `INC-...md`와 `REQ-...md`는 즉시 생성됩니다. 전체 요약인
`NETWORK.md`는 요청마다 전체 로그를 다시 읽지 않도록 최대 5초에 한 번만
갱신하며 collector 종료 시 마지막 내용을 강제로 반영합니다.

Markdown은 사람이 보기 편한 재생성 뷰입니다. AI와 CLI가 사용하는 원본은
JSONL 데이터와 압축·마스킹된 로그입니다.

## AI 에이전트 작업 흐름

생성된 에이전트 규칙은 버그 수정 전에 기존 근거를 먼저 확인하도록
안내합니다.

```bash
npx dev-blackbox incident list --format json
npx dev-blackbox incident show <INC-ID> --format json
npx dev-blackbox network list --failed --format json
npx dev-blackbox network show <REQ-ID> --format json
```

에이전트는 기록을 확인한 후 코드를 수정하고, 같은 명령을 Dev Blackbox로
재실행해 검증한 다음 인시던트를 해결 처리해야 합니다. 기록만으로 원인을
확정할 수 없다면 소스 코드, 원본 로그, 재현 테스트까지 추가로 조사해야
합니다.

## 네트워크 수집 범위

자동 연결된 `dev` 세션은 Node.js 전역 `fetch`를 자동 계측합니다. 요청이나
응답 스트림을 소비하지 않고 메서드, URL, 헤더, 상태 코드, 실행 시간과
오류 메타데이터를 collector에 전달합니다. 기록 전 비밀번호, 토큰, 인증
헤더, 쿠키와 설정된 본문 키를 마스킹합니다.

브라우저의 fetch/Axios 트래픽은 Node.js preload로 가로챌 수 없습니다.
프론트엔드 통신에는 [`examples/`](examples/README.md)의 fetch 또는 Axios
인터셉터를 추가해야 합니다. Spring과 FastAPI 예제도 포함돼 있습니다.

모든 어댑터는 `http://127.0.0.1:4319/events/network`로 이벤트를 전송하며,
프론트엔드와 백엔드 요청을 연결하려면 `X-Dev-Blackbox-Trace-Id`를
전파해야 합니다. collector는 외부에 노출되지 않도록 `127.0.0.1`에만
바인딩됩니다.

## 자동 보존 및 삭제

자동 정리는 기록 명령 종료와 collector 시작 시 확인하고, collector가 오래
실행되면 24시간마다 확인합니다. 매 명령마다 전체 파일을 스캔하지 않도록
최소 실행 간격은 5분이며, 프로세스 간 maintenance lock으로 동시에 두
prune이 실행되지 않게 합니다. collector 종료 시에는 성공 응답 본문을 바로
제거하기 위해 마지막 강제 정리를 한 번 수행합니다.

기본 보존 정책은 다음과 같습니다.

- 성공 명령 세션: 3일
- 성공 네트워크 메타데이터: 3일
- 성공 네트워크 본문: collector 세션 종료 시 제거
- 실패 네트워크 본문: 30일 후 제거
- 해결됐고 고정되지 않은 인시던트와 연결 보고서: 90일
- 미해결 또는 고정 인시던트: 자동 삭제하지 않음

기본 용량 제한은 500MB입니다. 제한을 초과하면 성공 명령 세션, 성공
네트워크 이벤트, 해결된 비고정 인시던트 순서로 정리합니다. 미해결 또는
고정 데이터만으로 제한을 넘는 경우에는 해당 데이터를 보존합니다.

수동 확인과 정리는 항상 즉시 실행되며 5분 스로틀을 적용하지 않습니다.

```bash
npx dev-blackbox storage status
npx dev-blackbox storage prune
npx dev-blackbox storage prune --older-than 30d
```

설정 파일은 `.dev-blackbox/config.yml`입니다.

```yaml
storage:
  maxTotalSizeMB: 500
retention:
  successfulCommandDays: 3
  resolvedIncidentDays: 90
  successfulRequestDays: 3
  failedRequestBodyDays: 30
  autoPruneIntervalHours: 24
  autoPruneMinIntervalMinutes: 5
```

## 주요 CLI

```bash
dev-blackbox init [--auto] [--script dev] [--agent-files] [--hooks claude-code]
dev-blackbox dev [--port 4319] -- <command>
dev-blackbox run [--timeout <초>] -- <command>

dev-blackbox incident list [--format json] [--all]
dev-blackbox incident show <ID> [--format json] [--log-lines <개수>]
dev-blackbox incident report <ID>
dev-blackbox incident resolve <ID>
dev-blackbox incident pin <ID>

dev-blackbox collect [--port 4319]
dev-blackbox network list [--format json] [--trace <id>] [--failed]
dev-blackbox network show <REQ-ID> [--format json]
dev-blackbox network replay <REQ-ID> [--allow-unsafe] [--base-url <url>]
dev-blackbox report network [--last 30m]

dev-blackbox start --name <이름> -- <command>
dev-blackbox process list [--format json]
dev-blackbox process logs <이름> [--lines <개수>]
dev-blackbox process stop <이름>

dev-blackbox storage status [--format json]
dev-blackbox storage prune [--older-than 30d]
dev-blackbox mcp
```

잘못된 collector 포트는 실행 전에 검사하며 1부터 65535까지의 정수만
허용합니다. `run`은 직접 실행한 자식 프로세스의 종료 코드를 전달하고,
`dev`는 원래 개발 명령을 포그라운드에서 실행한 뒤 종료 시 collector도
함께 닫습니다.

## 저장 구조

```text
.dev-blackbox/
├── sessions/commands-<sessionId>.jsonl
├── incidents.jsonl
├── network.jsonl
├── blobs/logs/
├── reports/
│   ├── incidents/INC-....md
│   ├── network/REQ-....md
│   └── NETWORK.md
├── processes/
└── config.yml
```

## MCP와 Claude Code 훅

```bash
claude mcp add dev-blackbox -- npx dev-blackbox mcp
npx dev-blackbox init --hooks claude-code
```

MCP 서버는 명령 실행, 인시던트, 네트워크 조회, replay, 보고서 도구를
제공합니다. 선택 사항인 Claude Code `PreToolUse` 훅은 감싸지 않은 빌드와
테스트 명령을 Dev Blackbox를 통해 다시 실행하도록 안내합니다.

## 개발

```bash
npm install
npm test
npm run typecheck
npm run build
```

Node.js 20 이상이 필요합니다. 출력 캡처는 PTY가 아닌 pipe를 사용하며,
Windows의 `.cmd`/`.bat` 실행 파일은 shell fallback으로 처리합니다.
