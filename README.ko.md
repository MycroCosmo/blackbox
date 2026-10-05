# dev-blackbox

**AI 코딩 에이전트가 같은 자리를 맴돌지 않게.**

[English](README.md) · [벤치마크](bench/README.md) · [고급 사용법 (영문)](docs/advanced.md)

- 에이전트는 실패할 때마다 처음 보는 에러처럼 여기고 같은 에러를 몇 번이고 다시 고칩니다.
- 중요한 한 줄을 찾으려고 수천 줄짜리 빌드 로그를 매번 다시 읽습니다.
- 세션이 끝나면 그 실패에 대해 알아낸 내용이 전부 사라집니다.

<!-- DEMO_GIF -->

<!-- BENCH_TABLE -->

측정 방법, 개별 실행 결과 전체, 재현 방법: [bench/](bench/README.md)

## 빠른 시작

Node 프로젝트:

```bash
npm i -D dev-blackbox
npx dev-blackbox init --hooks claude-code
```

그 밖의 프로젝트(Gradle, Maven, Go, Python 등)는 `package.json` 없이 전역 설치로 씁니다:

```bash
npm i -g dev-blackbox
dev-blackbox init --hooks claude-code
```

`init`은 `.dev-blackbox/`(git 제외)를 만들고, 빌드와 테스트를
`dev-blackbox run -- <명령>`으로 실행하라는 규칙을 `CLAUDE.md`에 추가합니다.
`--hooks claude-code`는 감싸지 않은 빌드·테스트 명령(`npm test`, `./gradlew test`,
`cd api && pytest` 등)을 `dev-blackbox run`을 거치도록 고쳐 쓰는 hook도 등록합니다.
에이전트가 규칙을 무시해도 동작합니다. 규칙만 원하면 이 옵션을 빼면 됩니다.
Node.js 20 이상이 필요합니다.

## 에이전트가 보는 출력

명령의 출력은 그대로 흘려보냅니다. 실패하면 dev-blackbox가 인시던트를 기록하고
끝에 짧은 요약을 덧붙입니다. 아래는 [벤치 과제 c](bench/tasks/c-vitest-shared-state)를
세 번 실행한 결과입니다. 처음엔 그대로, 두 번째는 아무것도 바꾸지 못한 `src/format.ts`
"수정" 뒤에, 세 번째는 수정 없이 다시 실행했습니다. 세 번째 요약을 편집 없이 옮겼습니다.

```text
✗ Command failed

Incident: INC-20261005-001
Type: PROCESS_FAILURE
Exit code: 1
Error: AssertionError: expected '3 items · $4,997' to be '3 items · $49.97' // Object.is equality
At: test/pricing.test.ts:23
Occurrences: 3 (first seen 21:51:15) — this failure happened before
  #2 → #3: no file changes — re-run without edits
  #1 → #2: changed src/format.ts — same failure
Report: .dev-blackbox\reports\incidents\INC-20261005-001.md
Details: npx dev-blackbox incident show INC-20261005-001 --format json
```

- **`Occurrences`**는 실행과 세션을 넘어 같은 실패를 셉니다. 예외 타입, 정규화한
  메시지, 최상단 애플리케이션 프레임이 같으면 같은 실패입니다. 줄 번호는 비교에서
  빼기 때문에 코드를 고쳐 줄이 밀려도 반복이 가려지지 않습니다.
- **들여쓴 줄**은 git에서 나옵니다. 두 실패 실행 사이에 바뀐 파일입니다.
  "changed `src/format.ts` — same failure"는 직전 시도가 효과가 없었다는 사실을,
  에이전트가 같은 발상의 변형을 시도하기 전에 알려 줍니다.
- **`Earliest cause`**는 출력의 첫 예외가 마지막 예외와 다를 때 나타납니다.
  예를 들어 Spring이 진짜 `NumberFormatException`을 한 번 찍고, 그 뒤로 수천 줄의
  "ApplicationContext failure threshold exceeded"를 쏟아내는 경우입니다.
  dev-blackbox는 마지막 부분만이 아니라 출력 전체를 따라가며 첫 예외 체인의 가장 깊은
  원인을 보관합니다.

`incident show <ID> --format json`은 다시 실행하지 않고 시도 내역과 원인 발췌를 포함한
전체 기록을 돌려줍니다. 인시던트는 `.dev-blackbox/`에 남기 때문에 다음 세션도 이 기록에서
시작합니다. 같은 명령이 성공하면 해당 인시던트는 해결 후보로 표시됩니다.

## FAQ

### 그냥 `| tail -50` 하면 되지 않나요?

`tail`은 이번 실행의 마지막 50줄만 보여 줍니다. 같은 실패가 벌써 두 번째 반복이라는 것,
방금 고친 파일이 아무 차이도 만들지 못했다는 것, 4,000줄 위의 첫 예외가 무엇이었는지는
알려 주지 못하고, 세션이 끝나면 사라집니다. dev-blackbox는 실패마다 마지막 1,000줄을
마스킹·압축해 fingerprint별로 저장하고, 실행과 세션을 넘어 반복 횟수를 세며,
`incident list`와 `incident show`로 JSON을 제공합니다.

앞부분 원인 추적은 예외 체인을 대상으로 합니다(Java/Kotlin `Caused by:`, Gradle의
full exception 형식 포함, JVM uncaught exception, JS/Python 에러).
[벤치 과제 b](bench/tasks/b-gradle-noisy-log)가 이 경우를 다룹니다. 예외가 아닌 원인,
예를 들어 평범한 로그 한 줄은 여전히 마지막 구간 밖으로 밀려날 수 있습니다.

### 데이터를 어디로 보내나요?

보내지 않습니다. 모든 기록은 프로젝트 안 `.dev-blackbox/`에만 쓰이고, `init`이
이 폴더를 `.gitignore`에 추가합니다. 텔레메트리도, 계정도 없습니다. 선택 기능인
네트워크 collector는 `127.0.0.1`에만 바인딩합니다. 디스크에 쓰기 전에 비밀 값을
마스킹합니다. 대상은 password·token·secret·API key 필드, `Authorization` 헤더, 쿠키,
Bearer 토큰, 개인 키 블록, 그리고 `.dev-blackbox/config.yml`에 지정한 본문 키입니다.

### 어떤 에이전트를 지원하나요?

- **Claude Code**: `CLAUDE.md` 규칙과 선택적 `PreToolUse` hook
  (`init --hooks claude-code`). hook은 빌드·테스트 명령을 dev-blackbox를 거치도록
  고쳐 씁니다. 고쳐 쓴 명령도 평소 권한 설정을 그대로 거치며, hook이 스스로 승인하는 일은 없습니다.
- **Codex, Cursor, Windsurf 등** `AGENTS.md`, `.cursorrules`, `.windsurfrules`를 읽는
  에이전트: `init --agent-files`로 같은 규칙을 추가합니다. hook이 없으므로 에이전트가
  규칙을 따르는지에 달려 있습니다.
- **MCP 클라이언트**: `npx dev-blackbox mcp` (고급 사용법 참고).
- **셸 명령을 실행할 수 있는 모든 도구**: CLI를 직접 호출하면 됩니다.

## 고급 기능

네트워크 수집, 요청 replay, 백그라운드 프로세스, MCP 서버, 보존 정책, 전체 CLI는
[docs/advanced.md](docs/advanced.md)(영문)에 정리되어 있습니다.

## 라이선스

MIT
