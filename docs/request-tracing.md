# 요청 추적 구현·조사 기록

2026-10-19. 시작 상태: `bench-overhead`,
`a51f64b8becbbeafbac3a8cf0ffb4821f5dfa844`, 작업 트리 변경 없음.
현재 브랜치에서 구현했으며 배포·운영 변경은 하지 않았다.
빠른 실행은 [Spring 예제](../examples/spring-local/README.md)를 따른다.

## 기존 구현 판정

README가 아닌 다음 소스와 테스트를 직접 확인했다. 판정은 변경 전 기준이다.

| 기능 | 상태 | 확인 근거와 부족한 범위 |
|---|---|---|
| 명령 실행, stdout/stderr | 구현 완료 | `src/runner.ts`, `ring-buffer.ts`, `condense.ts`; `tests/runner.test.ts`, `condense.test.ts`. 종료 코드·타임아웃·스트림별 마스킹·원인 탐지 |
| HTTP 요청/응답 | 구현 완료 | `register.ts`, `network.ts`, `collector-server.ts`; `network.test.ts`, `collector.test.ts`. Node fetch/HTTP 및 언어 공통 JSON POST, body 한도·분류·샘플링 |
| 요청 ID/프론트·백엔드 연결 | 부분 구현 | 수집기 `requestId`, 전달받은 `traceId`, 프론트 예제 존재. JVM 내부 요청 문맥과 로그 연결 없음 |
| Incident/fingerprint | 부분 구현 | `incident.ts`, `fingerprint.ts`, `phase3.test.ts`. 명령 중복 처리는 존재. HTTP는 경로/분류 중심이라 동일 경로의 다른 원인을 구분하지 못함 |
| 로컬 저장/용량 | 부분 구현 | `storage.ts`, `retention.ts`, `storage.test.ts`. JSONL/gzip, 기간·용량 정리. 미해결/핀 사건은 보호하여 상한 초과 가능 |
| 민감정보 마스킹 | 구현 완료 | `security.ts`, `security.test.ts`. 저장 전 키·토큰·URL·PEM 처리. 새 프로파일에도 같은 경로 적용 필요 |
| CLI/MCP | 부분 구현 | `cli.ts`, `mcp-server.ts`, `phase3.test.ts`. 기존 목록/상세/재실행 도구 존재. 커서·응답 바이트 제한과 요청 프로파일 원문 구간 조회 없음 |
| Java/Spring | 부분 구현 | `examples/spring-filter.md`의 동기 POST 문서 예제만 존재. 실행 가능한 모듈·예외 체인·연결된 로그·유실 상태 없음 |
| 초기 설정/진단 | 부분 구현 | `init.ts`, `dev-session.ts`, `init.test.ts`. 설정·규칙·명령 wrapping 존재. 통합 연결/권한/포트/Java 진단 없음 |

## 선택한 구현

| 선택지 | 수집 범위/비용 판단 | 결정 |
|---|---|---|
| 기존 수집 확장 | 마스킹·저장·Incident·CLI/MCP 재사용 가능 | 채택: 기존 `/events/network`에 선택적 `profile` 추가 |
| 경량 Spring 어댑터 | Servlet 경계, MVC 예외 관찰, Logback, 명시적 비동기 문맥만 필요 | 채택: 복사 가능한 Java 파일 하나와 실행 예제 |
| 기존 계측 도구 | JDBC/HTTP client/Reactive까지 필요하면 OpenTelemetry 등 계측이 적합. 현재 최소 범위에는 추가 배포·설정 부담 | 다음 단계 |
| Scouter 어댑터 | 이미 설치된 사용자의 txid/profile을 가져오는 별도 매핑 필요 | 다음 단계, 기본 의존성에 넣지 않음 |
| 자체 Java agent | 여러 JVM/프레임워크 버전과 bytecode hook 유지보수 필요 | 구현하지 않음 |

추가 npm 런타임 의존성·LLM 호출은 없다. 수집 데이터는 기존 `network.jsonl`에 함께
저장한다. Scouter의 물리적 저장 포맷을 복제하지 않고, **조회 시 요약과 상세를 분리**했다.
정상 요청 목록에는 로그/스택을 넣지 않는다. 상세에는 최종 원인과 최대 5개 주요 프레임,
중복 문자열을 제거한 로그 미리보기 최대 5개만 넣는다. 원문은 사용자가 선택한 요청의
마스킹된 수집 원문이다. 수집 한도 밖에서 버린 내용을 복구한다는 뜻은 아니다.

## Scouter에서 실제로 확인한 구조

참조 저장소 `scouter-project/scouter`, HEAD
**`dee47fb5f4003cecbb146c5acfff8d2ebeaf07f5`** (커밋 날짜 2026-10-11).
전체 제품을 분석하지 않고 아래 경로만 확인했다. 아래 링크는 동일 커밋으로 고정했다.

| 확인한 사실 | 근거 파일/심볼 | 이번 설계에 적용한 점 |
|---|---|---|
| 시작 시 context, txid, 시작 시간, thread를 기록하고 종료 시 elapsed/error 등을 XLog로 보낸다 | [TraceMain.java](https://github.com/scouter-project/scouter/blob/dee47fb5f4003cecbb146c5acfff8d2ebeaf07f5/scouter.agent.java/src/main/java/scouter/agent/trace/TraceMain.java): `startHttp`, `endHttpService`, `endHttpServiceFinal` | 명시적 요청 시작/종료, 상태와 단조 시계 기반 처리 시간 |
| ThreadLocal 문맥과 txid별 map이 있으며 종료 시 정리한다. reactive/coroutine 별도 경로도 있다 | [TraceContextManager.java](https://github.com/scouter-project/scouter/blob/dee47fb5f4003cecbb146c5acfff8d2ebeaf07f5/scouter.agent.java/src/main/java/scouter/agent/trace/TraceContextManager.java): `getContext`, `start`, `clear` | 요청별 버퍼, 비동기 명시적 전달, finally 복원. Scouter 수준 자동 async 지원을 주장하지 않음 |
| SQL은 SqlStep3, 외부 호출은 ApiCallStep을 context.profile에 push/pop한다 | [TraceSQL.java](https://github.com/scouter-project/scouter/blob/dee47fb5f4003cecbb146c5acfff8d2ebeaf07f5/scouter.agent.java/src/main/java/scouter/agent/trace/TraceSQL.java), [TraceApiCall.java](https://github.com/scouter-project/scouter/blob/dee47fb5f4003cecbb146c5acfff8d2ebeaf07f5/scouter.agent.java/src/main/java/scouter/agent/trace/TraceApiCall.java) | 터미널 출력으로 SQL/외부 span을 추정하지 않음. 현재는 요청에 실제로 귀속된 로그와 예외만 |
| XLogPack은 txid/gxid/elapsed/error/sqlCount/apicallCount 등 요약이며 profile packet은 별도다 | [XLogPack.java](https://github.com/scouter-project/scouter/blob/dee47fb5f4003cecbb146c5acfff8d2ebeaf07f5/scouter.common/src/main/java/scouter/lang/pack/XLogPack.java), [DataProxy.java](https://github.com/scouter-project/scouter/blob/dee47fb5f4003cecbb146c5acfff8d2ebeaf07f5/scouter.agent.java/src/main/java/scouter/agent/netio/data/DataProxy.java): `sendXLog`, `sendProfile0` | 사건 목록 → 선택 발생 상세 → 원문 구간 |
| 해당 XLog/profile 전송 경로는 sendDirect → DataUdpAgent이며 크면 UDP 패킷을 나눈다 | [DataUdpAgent.java](https://github.com/scouter-project/scouter/blob/dee47fb5f4003cecbb146c5acfff8d2ebeaf07f5/scouter.agent.java/src/main/java/scouter/agent/netio/data/net/DataUdpAgent.java): `write`, `writeMTU` | 전송 형식은 재사용하지 않고 기존 로컬 JSON HTTP 사용 |
| 수신 패킷 종류별로 XLog/Profile 처리 경로를 나눈다 | [NetDataProcessor.scala](https://github.com/scouter-project/scouter/blob/dee47fb5f4003cecbb146c5acfff8d2ebeaf07f5/scouter.server/src/main/scala/scouter/server/netio/data/NetDataProcessor.scala): XLOG/XLOG_PROFILE/XLOG_PROFILE2 분기 | 수집 경로와 조회 투영 분리 |
| 상세는 날짜/txid로 별도 조회하며 XLog 목록 조회에는 시간·txid·page count와 이어받기 메타데이터가 있다 | [XLogService.scala](https://github.com/scouter-project/scouter/blob/dee47fb5f4003cecbb146c5acfff8d2ebeaf07f5/scouter.server/src/main/scala/scouter/server/netio/service/handle/XLogService.scala), [XLog-Profile-View.md](https://github.com/scouter-project/scouter/blob/dee47fb5f4003cecbb146c5acfff8d2ebeaf07f5/scouter.document/views/XLog-Profile-View.md) | 안정적인 발생 ID, 페이지·폴링 커서, 원문 재조회 |
| 프로파일 버퍼 크기 도달 시 분할 전송하고 종료 시 discard 모드에 따라 profile/XLog 전송을 결정한다 | [ProfileCollector.java](https://github.com/scouter-project/scouter/blob/dee47fb5f4003cecbb146c5acfff8d2ebeaf07f5/scouter.agent.java/src/main/java/scouter/agent/trace/ProfileCollector.java), TraceMain `findXLogDiscard` 호출부 | 요청별 크기 한도와 명시적 유실 표시. 정상 요청 기존 샘플링 재사용 |
| profile/XLog 보관 일수와 디스크 사용률에 따른 삭제를 분리한다 | [AutoDeleteScheduler.java](https://github.com/scouter-project/scouter/blob/dee47fb5f4003cecbb146c5acfff8d2ebeaf07f5/scouter.server/src/main/java/scouter/server/core/AutoDeleteScheduler.java), [Configuration.md](https://github.com/scouter-project/scouter/blob/dee47fb5f4003cecbb146c5acfff8d2ebeaf07f5/scouter.document/main/Configuration.md) | 기존 보관 정책을 profile에 확장하고 용량 부족 시 수집을 거부 |

`UDPDataSendThread.java`에는 1024 크기 큐가 있지만 위 XLog/profile 경로가 반드시
그 큐를 통과한다고 해석하지 않았다. 실제 확인한 `sendDirect` 경로와 구분했다.
표의 세 번째 열은 dev-blackbox의 설계 선택이며 Scouter의 실제 동작에 대한 주장이 아니다.

Scouter의 [LICENSE.md](https://github.com/scouter-project/scouter/blob/dee47fb5f4003cecbb146c5acfff8d2ebeaf07f5/LICENSE.md)와
참고 Java 파일 헤더는 Apache-2.0이다. 코드·패킷 구현은 복사하거나 번역하지 않았다.
따라서 이번 변경에 Scouter 파생 코드/NOTICE 파일은 추가하지 않았다. 이후 재사용 시
라이선스 사본, 저작권/관련 고지, 수정 고지 및 해당 배포물의 NOTICE 조건을 확인해야 한다.

## 데이터·조회 계약

기존 POST 필드에 다음 선택 필드를 추가했다. Java 외의 도구도 같은 JSON으로 보낼 수 있다.

```json
{
  "profile": {
    "exception": {
      "type": "java.lang.IllegalStateException", "message": "checkout failed",
      "stack": ["at app.Checkout.run(Checkout.java:10)"],
      "causes": [{"type":"java.lang.IllegalArgumentException","message":"inventory unavailable","stack":["at app.Inventory.load(Inventory.java:20)"]}]
    },
    "logs": ["INFO checking inventory password=[REDACTED]"],
    "droppedLogs": 0, "truncated": false, "incomplete": false
  }
}
```

causes 순서는 바깥 원인에서 안쪽 원인으로 간다. 문자열 배열은 저장 전에 검증·마스킹한다.
프로파일은 로그 500줄, 예외별 스택 256줄, 원인 16개, 문자열 4096바이트,
문자열 내용 총 128 KiB 한도다. 예외에는 최대 64 KiB를 배정하고 로그에 최소 64 KiB를 남긴다.
예외 종류(256바이트)·메시지(2048바이트)를 먼저 보존하고 가장 깊은 원인의 스택부터 배정한다.
프로토콜 JSON overhead는 별도이며 POST 전체 1 MiB 제한이 있다. 제한 초과는 `profile.truncated`로 알린다.
어댑터는 요청별 로그 500개/65,536 UTF-8 바이트, 메시지 8,192바이트, 전송 큐 64개로 제한한다.
오래된 일반 로그부터 버리며 ERROR를 우선 보존한다. ERROR만 한도를 채우면 오래된 ERROR도 버린다.
로그를 자르기 전에 비밀 값이 온전하게 마스킹되도록 어댑터의 과도한 단일 로그는 버린다.

| 단계 | CLI | 기존 MCP 도구 |
|---|---|---|
| 사건 목록 | `incident list` | `list_incidents` |
| 사건 상세 | `incident show INC-ID` | `get_incident` |
| 개별 발생 목록 | `network list --incident-id INC-ID` | `list_network_requests({incidentId})` |
| 특정 발생 상세 | `network show REQ-ID` | `get_network_request({requestId})` |
| 원문 구간 | `network show REQ-ID --view raw --section logs --start-line 10 --line-count 20` | `get_network_request({requestId,view:"raw",section:"logs",startLine:10,lineCount:20})` |
| 전체 수집 스택 | `network show REQ-ID --view raw --section stack` | 같은 도구의 `section:"stack"` |

공통 필터: `--since/--until`(발생 timestamp, 양끝 포함), `--service`, `--request-id`,
`--trace-id`(`network list --trace` 별칭 유지), `--incident-id`, `--error`(대소문자 무시 포함 검색).
MCP는 camelCase, CLI의 `--failed`는 MCP `failedOnly:true`다.
프로세스 사건은 시간·오류·사건 ID 필터를 지원하지만 요청/서비스/trace 필터 대상이 아니다.

`--limit` 기본 20/최대 200, `--max-bytes` 기본 16384/범위 4096–262144.
예산은 들여쓰기된 JSON 도구 **내용**의 UTF-8 바이트다. CLI 줄바꿈 1바이트와 MCP 외부
JSON-RPC/escape overhead는 별도다. 잘리면 `truncated`와 `nextCursor` 또는 `raw` 조회
안내가 나온다. raw 구간 안에서도 바이트 한도를 넘으면 cursor로 이어 읽는다.
기본 상세에서 빠진 로그·스택은 raw로 확인하며 수집 자체가 잘렸으면 복구할 수 없다.

목록 `nextCursor`는 같은 필터로 다음 페이지를 읽는다. 첫 페이지 시점의 수신 ID 상한을
고정하므로 새 요청이 페이지에 끼어들지 않는다. 필터를 바꾸면 거부한다. 전 페이지를
읽은 후 `pollCursor`를 `after`로 전달하면 이후 수신 요청을 조회한다. 그룹 목록 폴링도
새 발생을 받은 사건을 반환한다. 사건 총 횟수/상태는 현재 값이며 MVCC 스냅샷이 아니다.
`matchingOccurrences`는 필터/커서 안에 남아 있는 발생 수, `occurrenceCount`는 전체 누적이다.
프로세스 사건의 증분 폴링은 제공하지 않으며 요청 증분 조회는 `list_network_requests`가
기준이다. 보관 정리로 커서 기준 ID가 사라지면 명시적 expired 오류가 나므로 목록을
다시 시작해야 한다. 임의 데이터 파일 편집 중의 조회 일관성은 보장하지 않는다.

raw의 offset/totalCharacters는 JavaScript UTF-16 기준이며 커서는 surrogate pair를
분리하지 않는다. 전체 데이터 비교에서 보고한 characters는 Unicode code point 수다.
REQ ID high-water 파일과 날짜별 Incident ID high-water 파일을 보관해 정리 후 재사용을 막는다.
기존 ID가 포함된 저장 폴더를 수동 초기화하면 별도 데이터셋으로 취급해야 한다.

fingerprint는 서비스·HTTP 상태·메서드·정규화 경로·바깥 예외 종류·가장 깊은 원인의
종류/정규화 메시지·주요 애플리케이션 프레임을 사용한다. ISO 시각과 명시적으로 표시된
requestId/traceId, UUID, 숫자·라인 번호 변화는 제외한다. 서로 다른 원인/서비스는 분리한다.
동일 원인 텍스트/프레임의 서로 다른 업무 오류까지 구별하는 의미론적 분류기는 아니다.
기존 HTTP fingerprint보다 구분 기준이 늘어 이전 버전 사건과 첫 수집이 분리될 수 있다.
대표 발생과 최신 발생 ID를 목록에서 제공하고 모든 보관 중인 발생은 별도로 조회한다.

## 보안·상태·보관과 한계

- 수집기와 예제 앱은 loopback 기본값. 기존 Origin 검증/JSON content-type 제한 유지.
- 기존 Redactor로 저장 전에 객체·문자열·전체 스택/로그 블록을 마스킹한다. 원문에도
  마스킹 전 데이터는 저장하지 않으므로 조회 옵션으로 우회할 수 없다. 임의 자연어
  비밀 값까지 알아내는 탐지기는 아니다. 조직별 키는 `security.redactBodyKeys`에 추가한다.
- 수집기 health: accepted/rejected/sampledOut/incidentLinkFailures/storageFull/lastEventAt.
  어댑터 상태: queued/active/sent/dropped/sendFailures/lastSentAt. 어댑터 미전송 유실은
  수집기에서 알 수 없으므로 두 상태를 함께 확인한다. 카운터는 프로세스 재시작 시 초기화된다.
- HTTP 연결 300ms, 전체 전송 1초 timeout. 백그라운드 큐에서 전송하며 실패를 앱에
  던지지 않는다. 자동 재전송/디스크 spool은 없다. 요청마다 큐 삽입·문자열/스택 생성 비용은 있다.
- 정상 profile/body는 세션 종료 시 제거, 정상 메타데이터 3일, 실패 profile/body 30일.
  만료는 `profileExpired`로 표시한다. 미해결/핀 사건 메타데이터는 기존 보호 정책을 유지한다.
  수집기는 남은 공간에 레코드·보고서 여유분이 없으면 507로 거부하여 상태에 남긴다.
  같은 저장소의 다른 명령 기록 프로세스까지 원자적인 총량 quota를 제공하는 것은 아니다.
- 저장/조회는 기존 JSONL 전체 스캔 방식이다. 작은 로컬 프로젝트 대상으로 유지했으며
  많은 장기 기록은 SQLite 인덱스·별도 profile blob이 다음 단계다.
- SQL 파라미터/실행 시간, 외부 HTTP span, 자동 분산 부모/자식 span, WebFlux·임의 비동기는
  수집하지 않는다. 터미널 로그의 시간 근접성을 요청 연결 근거로 사용하지 않는다.
- 기록 없이 삼킨 Throwable, suppressed 예외, cause 16개/stack 256개 초과는 완전 수집이
  아니다. 상세의 rootCause는 **수집된** 가장 깊은 원인이다. truncated/incomplete를 함께 읽는다.

호환 변경: 네 가지 목록/상세 도구는 이제 bounded projection을 반환한다. `network show`의
자동 전체 trace 확장은 `network list --trace`로 옮겼다. `incident show`의 자동 log tail 대신
raw 명시 조회를 사용한다. 기존 기록/공개 `publicIncident`/report/replay 기능은 유지했다.
기존 소비자가 상세 JSON 전체 필드에 의존하면 raw event 조회로 전환해야 한다.

## 검증·실측

기존 테스트 최초 189개는 샌드박스에서 로컬 통신/임시 Git/rename 권한 제한으로 실패했고,
일반 로컬 권한으로 모두 통과했다. 새 테스트는 `tests/request-tracing.test.ts`, 실제 Java
통합 재현은 `examples/spring-local/verify.mjs`에 있다. 최종 수치와 fixture hash는
[request-tracing-measurement.json](request-tracing-measurement.json)에 저장한다.

최종 실행: TypeScript 빌드 성공, Vitest **17 파일/201 테스트 통과**.
JDK 21.0.11 / Node 22.17.0 / Spring Boot 3.5.3에서 Java 통합 검증 통과.

| 전달 데이터 | UTF-8 바이트 | Unicode 문자 수 |
|---|---:|---:|
| A: 전체 수집 기록 | 293,088 | 293,088 |
| B: 목록 + 선택 상세, 도구 내용만 | 3,684 | 3,684 |
| B의 두 요청 + JSON-RPC 응답 | 4,504 | 4,504 |
| 선택적 raw 호출의 request/response 기록 | 584 | 584 |
| 같은 상세를 다시 조회할 때 도구 내용 | 1,395 | 1,395 |

단계적 도구 내용은 이 fixture에서 98.74% 작았다. **바이트 비교이며 토큰/전체 대화 비용
절감률이 아니다.** 현재 fixture가 ASCII라 두 수치가 같다. 성공 수신 44, 전송 실패 0,
유실 0으로 시작했고 수집기 단절에서는 실패 2가 표시됐다. 느린 수신기에서 100개
추가 요청은 모두 HTTP 200, 대기 64/전송 중 1/유실 35로 관측됐다.

비교 A는 같은 44개 실행의 **수집된 전체 마스킹 JSON 기록**이다. 수집 이전에 버린
1500줄 중 초과분까지 포함하는 비교가 아니다. B는 실제 MCP stdout 응답의 목록과
선택한 한 사건 상세 내용만 합친 값이다. `/ok` 30, 같은 `/fail` 4, 동시 `/async` 8,
다른 원인 `/fail` 1, `/large` 1로 구성한다. 정상 로그와 반복 스택도 A에 포함된다.
부하/단절 추가 실험은 이 A/B fixture와 별도로 실행한다.

측정 순서: list_incidents → get_incident(반복 4회 사건) → 필요할 때만 get_network_request(raw logs).
세 번째 원문은 B에서 제외하고 별도 비용으로 보고한다. 선택 상세에는 요청 ID/시각/메서드/
경로/상태/처리 시간, `IllegalArgumentException: inventory unavailable`, DemoApplication.fail
프레임과 마스킹된 관련 로그가 유지됨을 assert했다. 전체 진단을 LLM으로 평가한 실험은 아니다.

앞선 통합 검증에서는 토크나이저를 사용하지 않았다. UTF-8 바이트와 Unicode 문자 수만 비교하며 토큰 절감률이나
전체 대화 비용 절감률로 해석하지 않는다. measurement에는 두 도구 요청+JSON-RPC 응답,
추가 raw 호출, 동일 상세 반복 호출 크기를 별도로 기록한다. initialize/tools-list, tool
schema의 모델 입력, 사용자의 대화, 모델 답변, 추론 비용, 클라이언트별 tool framing은
포함하지 않는다. 반복 조회하면 그 전달량은 다시 발생한다.

### 사용자 관점의 추가 토큰 실측 (수정 전, 2026-10-19)

별도 소스 복사본을 빌드하여 Spring 요청 44개를 실제 실행하고 MCP stdio의
`list_incidents` → `get_incident` 응답을 저장했다. 같은 기록으로 A/B를 비교한다.
A는 저장된 로그와 예외를 텍스트로 재구성하고 Java의 공통 스택 꼬리를 `... N more`로
접었다. 실제 터미널 출력 전체를 녹화한 값은 아니며, 수집 전에 버린 로그는 포함하지 않는다.
B는 오류 목록과 선택한 사건 하나의 상세다. 모든 사건을 진단하는 실험은 아니다.

`tiktoken 0.14.0`으로 실제 문자열을 다시 토큰화했다. 아래 토큰은 `o200k_base` 기준이다.
[측정 JSON](request-tracing-token-measurement.json)에 `cl100k_base` 교차 측정과
각 입력의 바이트·문자 수·SHA-256도 기록했다. 특정 모델의 청구 토큰을 뜻하지 않는다.

| 동일 기록의 비교 | A 바이트 / 토큰 | B 바이트 / 토큰 | 내용 토큰 절감률 |
|---|---:|---:|---:|
| Spring 44요청, 오류 4그룹 | 154,971 / 36,280 | 3,684 / 1,232 | 96.60% |
| Spring 실패 요청 1개 | 5,239 / 1,091 | 2,144 / 741 | 32.08% |
| 짧은 오류 1개 (직접 POST한 fixture) | 159 / 51 | 1,781 / 627 | 1,129.41% 증가 (12.29배) |

`cl100k_base` 결과도 각각 96.67% 절감, 33.36% 절감, 12.50배 증가였다.
저장 JSON 전체를 A로 쓰면 66,301 → 1,232 토큰으로 더 큰 절감률이 나오지만,
일반 로그 복사와 비교할 때 JSON 필드의 비용까지 절약 효과로 계산하지 않는 편이 적절하다.

별도 비용 (`o200k_base`): 전체 MCP 도구 정의 JSON 2,362토큰, 44요청 실험의 두 호출
이름·인자 JSON 합계 35토큰, 추가 원문 응답 101토큰, 동일 상세 재조회 응답 464토큰.
도구 정의를 한 번 더하고 호출 인자까지 단순 합산하면 B는 3,629토큰으로 A보다 90.00%
작다. 이는 참고 합산이며 클라이언트의 실제 schema 전달 형식·캐시·대화 이력 재전송·
RPC framing·모델 응답/추론 비용을 측정한 값이 아니다. 전체 대화 비용 절감률로 쓰지 않는다.

선택한 반복 오류의 요청 정보, `inventory unavailable` 원인, `DemoApplication.fail`
프레임, 연결된 로그는 유지됐다. 사람이 원인을 이미 알고 직접 고른 핵심 발췌는
106토큰으로 B보다 작았지만, 선택에 드는 수작업 시간은 측정하지 않았다.
또한 수정 전 별도 재현에서는 로그 한도 이후 ERROR와 `logger.error(message, throwable)`의
원인 정보가 누락됐다. 이 누락을 토큰 최적화의 성과로 취급하면 안 된다.

결론: 많은 정상·반복 로그에서 특정 오류를 조사할 때 절감이 크다. 짧은 로그에는
목록/상세 메타데이터와 도구 정의 때문에 비용이 증가할 수 있다. 원인 누락과 마스킹의
회귀 수정 및 동일 시나리오 재측정은 아래에 기록했다.
로컬 측정 입력/실행 기록은 `smoke-project/review-results/`, 재계산 스크립트는
`smoke-project/count-review.py`에 있다 (git 제외된 검증 산출물).

### 회귀 수정 및 재검증 (2026-10-19 06:22 UTC)

- 공통 Redactor가 시각/로거 접두사 뒤의 `password:`, `Authorization: Basic`, `api_key:`를
  마스킹한다. 저장 파일, CLI 상세, MCP 상세/원문에서 가짜 인증 값이 없음을 검증했다.
  이전 버전이 저장한 파일은 자동 재작성하지 않는다.
- Java 버퍼는 최신 일반 로그와 ERROR를 우선 보존하며 유실 수를 보고한다. 550줄 전후의
  ERROR 두 개가 모두 남았다. MVC/필터 예외가 없으면 마지막 ERROR의 Throwable 원인과
  스택을 수집한다. 긴 스택 때문에 로그 예산이 사라지지 않으며 상세 프레임은 512자로 제한한다.
- HTTP 목록은 최근 수신 발생부터 정렬한다. 25개 사건 중 오래된 사건을 다시 발생시켰을 때
  첫 페이지에 나타났고, 페이지 사이에 발생한 기록은 후속 poll에서 조회했다. 정렬 방식이
  바뀌었으므로 이전 버전 커서는 다시 조회하라는 오류로 거부한다.
- 소스 체크아웃에서 `init` 후 생성한 CLI 경로를 실제 실행했다. 전역 명령이 필요 없었다.
  `doctor`의 Maven 미설치/설치 상태를 모두 검증했다. Maven은 자동 설치하지 않는다.

44개 기본 요청 + 위 회귀 요청 3개, 수집기 단절 2개, 큐 초과 100개 요청을 실행했다.
단절/초과 시 HTTP 응답은 유지됐다. 기본 44개에 대해 CLI와 실제 MCP stdio의 목록→상세→원문
흐름을 확인했다. 모든 자식 프로세스를 종료했다. 검증 산출물은
`examples/spring-local/target/verification-Pbs3Nz/`에 있다.

최종 `tiktoken 0.14.0 / o200k_base` 측정: 같은 수집 기록의 텍스트 A **154,991바이트 /
36,504토큰**, 목록+선택 상세 B **3,684바이트 / 1,236토큰**, 내용 토큰 **96.61% 감소**.
`cl100k_base`는 37,001 → 1,232 (96.67%). 요청 시각·처리 시간과 보존하는 로그 구간이
달라져 수정 전과 바이트 단위로 같은 데이터는 아니다. 각 실행의 A/B는 동일 기록을 사용한다.

도구 정의는 compact JSON 1,407토큰, pretty JSON 2,362토큰이며 같은 정의의 표현 차이다.
두 호출 이름/인자 31토큰, 추가 원문 101토큰, 상세 재조회 466토큰을 별도 측정했다.
클라이언트가 모델에 전달하는 형식과 캐시, 대화 이력·응답 비용은 포함하지 않았다.
짧은 로그의 비용 증가라는 수정 전 측정 결과는 여전히 적용되는 한계다.
[최종 측정 JSON](request-tracing-token-after-fixes.json)과
[재계산 스크립트](../examples/spring-local/measure-tokens.py)를 함께 제공한다.

## 다음 단계

1. 신규 사용자에게 문서만 제공해 설정 시간·도움 요청·수동 로그 복사 횟수와 진단 성공을 검증.
2. 필요 앱에서 MVC async 완료·Reactor context, suppressed 예외를 확장.
3. JDBC/외부 호출은 기존 OpenTelemetry 계측과 같은 표준 span 수집을 검토한 뒤 어댑터 추가.
4. Scouter 사용자를 위한 읽기 전용 XLog/profile 어댑터를 별도로 제공하고 라이선스 재확인.
5. JSONL 스캔 비용이 실제 문제가 되는 규모에서 인덱스·원문 blob 분리, 원자적 다중 writer quota.
6. 사용 모델의 정확한 tokenizer로 재측정하고 전체 대화 실험을 별도로 설계.
