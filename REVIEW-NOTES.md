# 코드 리뷰 기록

버그 수정 리뷰에서 나온 발견 사항과 처리 내역을 기록한다.
새 항목은 날짜 섹션을 추가해서 누적한다.

## 2026-10-05

### 변경 목표

"에이전트가 같은 자리를 맴도는 것"을 실제로 막도록 실패 요약과 hook을 손봤다.

### 기능 변경

- **실패 요약에 답을 직접 포함** (`src/summary.ts`): `Error`, `At`, `Earliest cause`, 그리고
  반복 실패 시 발생 사이에 바뀐 파일(`#1 → #2: changed src/format.ts — same failure`,
  `no file changes — re-run without edits`). 이전에는 ID만 주고 `incident show`를 한 번 더
  부르게 했다. 시각은 로컬 시간으로 표시.
- **발생 사이 변경 파일 추적** (`src/workspace.ts`): 실패마다 HEAD + dirty 파일의 git blob id를
  저장(`lastWorkspace`, 최대 300개)하고 직전 스냅샷과 비교해 `attempts`에 남긴다.
  `git hash-object --stdin-paths`로 해시해 autocrlf 환경에서도 커밋된 내용과 정확히 비교된다.
  git이 없거나 느리면(3초) 조용히 건너뛴다. `lastWorkspace`는 `publicIncident()`로
  CLI/MCP 출력에서 제외.
- **긴 로그 앞부분의 원인** (`RootCauseTracker`): 링버퍼와 별도로 모든 줄을 보며 첫 예외 체인의
  가장 깊은 `Caused by`를 보관한다(Gradle의 줄바꿈된 `Caused by:` 형식 포함). 링버퍼 밖으로
  밀려났으면 로그 blob 맨 앞에 별도 섹션으로 넣되 `ringBuffer.maxLines` 예산은 유지.
- **hook: 거부 → 재작성**: `updatedInput`만 반환하고 permission decision은 반환하지 않으므로
  사용자 권한 설정을 그대로 거친다. 복합 명령(`cd x && npm test 2>&1 | tail`)은 해당 단계만 감싸고,
  `npm run dev`/`bootRun`/`--watch`/heredoc/`$(…)`은 건드리지 않는다.
- **hook 실행 비용**: 로컬 설치 시 `node "${CLAUDE_PROJECT_DIR}/node_modules/dev-blackbox/dist/cli.js"`
  직접 호출(측정: npx 1.55s → 0.22s, 모든 Bash 호출마다 발생). 기존 npx hook 항목은 재실행 시 갱신.
- **비 Node 프로젝트**: 전역 설치를 감지해 규칙·요약에 `dev-blackbox`(npx 없이)를 쓴다 (`src/invocation.ts`).

### 수정된 버그

- `./mvnw`가 hook 패턴에 걸리지 않았다(`(mvn|mvnw)`만 허용).
- JVM의 `Exception in thread "main" java.lang.X: …` 줄을 예외로 인식하지 못했다.
- Vitest 코드 프레임(` ❯ test/x.test.ts:23:32`)을 위치로 인식하지 못해 `At`/fingerprint에 위치가 빠졌다.
- Java identity hash(`MergedContextConfiguration@30c1da48`)가 fingerprint에 남아 JVM을 재시작할
  때마다 같은 Spring 실패가 새 incident로 갈라졌다. 벤치 분석기가 이를 따로 마스킹하고 있었다.
- 위 세 건은 fingerprint를 바꾸므로, 업그레이드 직후 해당 형태의 기존 incident와는 한 번 병합되지 않을 수 있다.

### 미해결

- `tests/runner.test.ts` "kills descendants in the timed-out process tree"는 이 머신에서 변경 전에도
  실패했다(taskkill 포함 1.1~1.4초 > 1초 기준). 이번 변경과 무관.
- JDK가 없어 벤치 과제 a/b(Gradle)로는 검증하지 못했다. 과제 b의 출력 형식은 합성 픽스처로만 테스트됨.

## 2026-08-09

### 리뷰 대상

8-08~8-09 미커밋 변경분 전체(`storage.ts` 락 프로토콜 재작성, `runner.ts` stderr tail·프로세스 트리 종료,
`collector-server.ts` CORS 게이트, `fingerprint.ts` 라우트 정규화, `init.ts` settings 검증) 및 프로젝트 전반.

### 수정된 버그

#### `.recovery` 가드 누출 — incident 기록 영구 중단 (수정 완료)

- **증상**: 새 stale-lock 복구 프로토콜의 `<lock>.recovery` 가드에 staleness 판정이 없었다.
  `acquireLock`은 파일이 존재하기만 하면 무조건 대기한다. 가드를 만든 프로세스가 죽거나,
  `openSync` 성공 후 `writeFileSync`가 실패하면(catch 경로에 `rmSync` 없음) 가드가 영구히 남아
  **이후 모든 `withIncidentLock`이 10초 대기 후 예외**. runner가 기록 실패를 삼키므로
  사용자에겐 "실패할 때마다 10초 느려지고 incident가 안 쌓인다"로만 보인다.
- **수정**: `clearStaleRecovery()` 신설 — 가드에도 락과 동일한 pid/mtime 판정(`isStaleLock`)을 적용해
  주인이 사라진 가드를 제거한다. `acquireLock`의 전/후 두 검사 지점 모두에 적용하되, 후자에서
  가드를 치운 경우엔 이미 획득한 락을 놓지 않는다. `recoverStaleLock`의 실패 경로에도 `rmSync` 추가.
- **회귀 테스트**: `tests/storage.test.ts` — "clears a recovery guard abandoned by a dead process"
  (타임아웃이 아니라 즉시 획득하는지 검증), "clears an unreadable recovery guard once it ages out",
  "does not skip a maintenance pass because a live recovery guard exists"(살아있는 가드는 존중).

#### 타임아웃 시 `taskkill` 실패를 감지 못함 (수정 완료)

- **증상**: `spawnSync().error`는 **spawn 자체 실패에만** 설정된다. taskkill이 exit 1(권한 거부,
  트리 일부만 종료)로 끝나도 `!result.error`가 참이라 폴백 kill 없이 리턴했다. 프로미스는 `close`
  이벤트로만 resolve되므로 `run --timeout`이 무한 대기.
- **수정**: `!result.error && result.status === 0`일 때만 성공으로 간주하고, 그 외에는
  SIGTERM→SIGKILL 경로로 폴백.

#### 소프트 시그널 스캔이 두 시퀀스를 이어붙여 위치를 오검출 (수정 완료)

- **증상**: `detectSoftSignals([...stderrTail, ...textLines])`. 탐지기는 에러 줄 **다음 40줄**에서
  스택 프레임을 찾는데, 배열을 이어붙이면 stderrTail 끝의 에러가 링버퍼의 **가장 오래된 줄**을
  프레임으로 집어간다. 잘못된 `location` → `fingerprintFromError`가 다른 지문 생성 →
  **incident 병합이 어긋난다.** 정렬이 stable이라 오염된 쪽이 먼저 선택되기까지 했다.
- **수정**: `detection.ts`에 `bestSoftSignal(...groups)` 신설. 각 그룹을 **독립적으로** 스캔한 뒤
  rank가 가장 높은 것을 고른다(동점이면 앞 그룹 우선 = 링버퍼 우선). "이어붙이지 말 것"을
  호출부 규약이 아니라 API로 강제했다.
- **로그 blob도 함께 정리**: 기존 `preserveStderrSignals`는 evict된 줄을 **새 타임스탬프로 버퍼 끝에
  되밀어 넣어** 시간 순서를 망가뜨리고 매번 다른 줄을 evict시켰다. 이제 되밀지 않고, evict된
  stderr는 버퍼 창보다 **더 오래된** 줄이므로 전용 헤더와 함께 맨 앞에 배치한다. 대신 캡처 창이
  같은 수만큼 자리를 양보해 blob은 `ringBuffer.maxLines` 예산을 넘지 않는다(spec 4.2 유지).
- **회귀 테스트**: `tests/detection.test.ts` — "never reads a stack frame across a group boundary"
  (이어붙인 형태가 실제로 잘못된 위치를 내놓는 것까지 대조 검증),
  `tests/runner.test.ts` — "still finds an exception that heavy stdout evicted from the ring buffer".

#### `.claude/settings.json` 검증이 최상위 레벨만 (수정 완료)

- **증상**: `{"hooks": []}`, `{"hooks":{"PreToolUse":{}}}` 같은 "유효한 JSON이지만 확장 불가능한 형태"가
  통과해서 `preToolUse.push is not a function` 같은 불투명한 TypeError로 죽었다.
- **수정**: `readClaudeSettings()`로 분리하고 `hooks` / `hooks.PreToolUse` 슬롯까지 검증.
- **순서 문제 동반 수정**: 던지는 이 단계가 .gitignore·CLAUDE.md·AGENTS.md를 **이미 쓴 뒤**,
  `wrapPackageScript` **직전**에 실행돼 init이 절반만 적용된 채 죽었다. `runInit` 맨 앞에
  pre-flight 검증을 추가해 첫 쓰기 전에 거부한다.
- **회귀 테스트**: `tests/init.test.ts` — "refuses to write over %s"(4 케이스),
  "rejects bad settings before any other file is touched", "merges into valid existing settings...".

#### config 값 무검증 (수정 완료)

- **증상**: `mergeConfig`의 `pick`은 얕은 스프레드일 뿐이라 YAML 값이 그대로 흘러갔다.
  `sampling: {rules: {}}` 한 줄이면 `shouldStore`의 `.find`가 매 요청마다 던지고, collector가 그걸
  400으로 삼켜 **모든 네트워크 이벤트가 조용히 유실**된다. `ringBuffer.maxLines: "1000"`이면
  줄 수 기반 eviction이 비활성화된다. CLI 포트는 검증하면서 config 파일은 무검증이었다.
- **수정**: 섹션별로 `num`/`int`/`bool`/`stringList`/`samplingRules` 리더를 통과시켜
  타입이 틀린 값은 조용히 무시하고 기본값으로 강등한다.
- **회귀 테스트**: `tests/config.test.ts` (신규 파일, 6개).

#### 그 외

- `collector-server.ts`: 413 응답 후 버퍼된 chunk가 한 번 더 도착하면 `send()`가 재호출되어
  스트림 핸들러 안에서 `ERR_HTTP_HEADERS_SENT`가 발생할 수 있었다 → `data` 핸들러 진입부에 `rejected` 가드.
- `network.ts`: 샘플링 룰이 **첫 매치**라 `/api`가 `/api/health`를 가렸다 → 최장 접두사 우선.
  본문 절단이 `subarray`라 멀티바이트 문자가 깨졌다 → `TextDecoder` 스트리밍 모드(`sliceUtf8`).
- `fingerprint.ts`: `normalizeRoutePath`가 `v1`→`v<n>`으로 만들어 `/api/v1/x`와 `/api/v2/x`를
  한 incident로 병합했다 → 버전 세그먼트는 정규화 제외.
- 버전 중복: CLI `--version`과 MCP `serverInfo.version`("0.1.0", 실제 0.2.1과 불일치)이 하드코딩
  → `src/version.ts`가 package.json에서 읽는 단일 출처로 통합(src/dist 양쪽에서 동일 해석).
- `cli.ts`: `--timeout abc` → NaN → falsy → **경고 없이 타임아웃 해제**되던 것을 명시적 거부로 변경.
  `--older-than`도 동일.
- `register.ts`: 모든 outbound fetch에 trace 헤더를 주입하는데 파일 주석은 "never altered"라고
  적혀 있었다 → 실제 동작(외부 호스트 전파, CORS preflight 유발 가능)을 주석에 명시.
- `tests/storage.test.ts`에 남아 있던 "TEMP DIAGNOSTIC" 블록(임시 디렉터리에 덤프) 제거.
- `demo-project/`를 `.gitignore`에 추가.

### 추가 수정 완료 (2026-08-29)

- `tests/fixtures/timeout-tree.cjs`를 변경 세트에 포함해 Windows 프로세스 트리 테스트가
  클린 클론에서도 실행되도록 했다. 새 파일이므로 커밋할 때 함께 포함해야 한다.
- 참조되지 않던 `tests/fixtures/lockprobe.ts`, `tests/fixtures/stress.mjs`를 삭제했다.
- 러너와 프로세스 매니저의 stdout/stderr에 독립 Redactor를 할당해 스트림 간 private-key
  상태 오염을 막고, `StringDecoder`로 청크 경계에서 UTF-8 문자가 깨지지 않게 했다.
- 설정의 음수·0·범위 밖 샘플링 비율을 기본값으로 복구해 로그 즉시 삭제, 본문 제한 우회,
  과도한 자동 정리를 막았다.
- `package-lock.json` 버전을 0.3.0으로 맞추고 Windows/Linux × Node 20/22 CI를 추가했다.

## 2026-07-18

### 리뷰 대상

7-18 새벽 수정분: `src/security.ts`(시크릿 키 정규화 마스킹), `src/mcp-server.ts`(MCP initialize 버전 협상, run_command stdin 격리) 및 관련 테스트. 세 가지 수정 모두 방향 적절, 테스트 커버리지 양호로 판정.

### 수정된 버그

#### Redactor 상태 누수 — collector 이벤트 간 오염 (수정 완료, 2026-07-18)

- **증상**: `Redactor.redactLine`이 여러 줄에 걸친 private key 블록을 추적하려고 인스턴스 상태(`insidePrivateKey`)를 유지하는데, collector는 서버 수명 전체 동안 Redactor 하나를 모든 이벤트에 재사용한다(`collector-server.ts`). 어떤 이벤트 본문에 `-----BEGIN ... PRIVATE KEY-----`만 있고 END가 없으면 상태가 `true`로 남아, **이후 도착하는 모든 이벤트의 모든 문자열이 통째로 `[REDACTED]` 처리**되어 네트워크 로그가 조용히 파괴됨. (유출 방향이 아닌 과잉 마스킹이지만 데이터 손실.)
- **수정**: 상태 머신을 스트리밍 경로로 한정.
  - `redactLine` → 무상태로 변경. 자기완결적 텍스트(객체 필드, URL, argv) 전용. 완결된 키 블록은 통짜 정규식으로 마스킹하고, 홀로 있는 BEGIN/END 마커 줄도 그 줄만 마스킹하되 상태는 남기지 않는다.
  - `redactStreamLine` 신설 → 줄 단위 스트리밍(러너, 프로세스 매니저) 전용 상태 유지 변형. 스트림/실행 단위로 전용 Redactor를 쓰는 곳에서만 사용.
  - 호출부 변경: `runner.ts`, `process-manager.ts`의 스트리밍 캡처만 `redactStreamLine` 사용. collector/network 경로는 무상태 `redactLine` 유지.
- **회귀 테스트**:
  - `tests/security.test.ts` — "keeps redactLine stateless after a truncated private key"
  - `tests/collector.test.ts` — "survives a truncated private key without poisoning later events"

### 선택 사항 → 외부 리뷰 후 재평가 및 처리 (2026-07-18)

처음에는 세 건 모두 "미수정 백로그"로 분류했으나, 외부 리뷰에서 2·3번의 실제 영향도가
과소평가되었다는 지적을 받아 재평가 후 처리했다.

1. **`redactCommand`의 민감 플래그 뒤 인자 무조건 마스킹** — **의도된 동작으로 확정, 테스트로 문서화**
   `["curl", "--password", "--verbose"]`처럼 값이 생략되면 다음 플래그까지 `[REDACTED]` 처리된다.
   임의의 CLI를 다루는 이상 다음 인자가 플래그인지 `-`로 시작하는 진짜 시크릿인지 구분할 수 없고,
   보안 기능에서는 과잉 마스킹이 누락보다 낫다. 코드는 그대로 두고
   `tests/security.test.ts`의 "redacts the argument after a value-less secret flag" 테스트로
   보수적 동작임을 명시했다.

2. **`redactUrl`의 슬래시 없는 상대 URL 재구성** — **버그로 재분류, 수정 완료**
   처음엔 표시 문제로 봤으나, 저장된 URL은 `replay.ts`의 `resolveTarget`에서
   `new URL(record.url, baseUrl)`로 **실제 재실행 대상**이 된다. `api/x`가 `/api/x`로 바뀌면
   baseUrl에 경로가 있을 때(`http://localhost/v1/`) `/v1/api/x`가 아닌 `/api/x`를 호출한다.
   수정: 절대 URL만 `URL` 객체로 재구성하고, 상대 URL은 경로 원형(선행 슬래시, `./`, `../`, 없음)을
   그대로 두고 쿼리 문자열만 다시 쓴다.
   회귀 테스트: `tests/security.test.ts` — "preserves the recorded shape of relative URLs".

3. **MCP 메시지 루프 순차 처리** — **버그로 재분류, 수정 완료**
   `for await` 루프가 `tools/call`을 `await`하므로 `run_command`가 끝날 때까지 `ping`을 포함한
   모든 요청 읽기가 멈췄다. `timeoutSeconds`는 선택값이라 명령이 무기한일 수도 있어,
   ping 타임아웃이 있는 MCP 클라이언트는 연결을 끊게 된다.
   수정(`src/mcp-server.ts`): 입력 루프는 계속 읽고, `tools/call`만 별도 Promise로 디스패치.
   응답은 JSON-RPC `id`로 매칭되며, stdin 종료 시 진행 중인 작업을 `Promise.allSettled`로
   정리한 뒤 종료한다.
   회귀 테스트: `tests/phase3.test.ts` — "answers ping while a long run_command is still running"
   (1.5초짜리 run_command 직후 보낸 ping의 응답이 먼저 도착하는지 검증).

### 기타

- `.git` 폴더가 비어 있어 git 히스토리가 유실된 상태. `git init` 후 현재 상태를 커밋해 둘 것.
