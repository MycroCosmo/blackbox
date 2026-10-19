# 로컬 Spring 요청 추적

필요 환경: Node 20+, JDK 17+, Maven 3.6.3+. 예제는 Spring Boot 3.5.3으로 고정했다.
기존 TypeScript 수집기에 선택적인 Servlet/Logback 어댑터를 붙인다. Scouter 설치나
Java 에이전트가 필요하지 않다. 아래 명령은 저장소 루트에서 실행한다.

```sh
npm ci
npm run build
node dist/cli.js init
node dist/cli.js doctor
mvn -f examples/spring-local/pom.xml package
node dist/cli.js collect
```

별도 터미널에서:

```sh
java -jar examples/spring-local/target/spring-local-1.0.0.jar
curl http://127.0.0.1:8080/ok
curl "http://127.0.0.1:8080/fail?marker=checkout"
node dist/cli.js incident list --service spring-local --format json
node dist/cli.js incident show <INC-ID> --format json
node dist/cli.js network show <REQ-ID> --view raw --section logs --start-line 1 --line-count 10
node dist/cli.js doctor
curl http://127.0.0.1:8080/blackbox-status
```

Windows PowerShell에서 `curl` 별칭이 다르게 동작하면 `curl.exe`를 사용한다.
포트 충돌 시 수집기는 `collect --port 4320`, Java는
`--dev.blackbox.collector=http://127.0.0.1:4320/events/network --server.port=8081`로 맞춘다.
종료는 각 터미널에서 Ctrl+C. 어댑터는 appender를 해제하고 전송 큐에 최대 2초를
준 뒤 남은 작업을 취소한다. 수집기는 연결·타이머·잠금 파일을 정리한다.

`init`은 `.dev-blackbox/config.yml` 및 AI 사용 규칙을 만든다. 기본 저장 한도는
500 MiB, 정상 요청 메타데이터 3일, 실패 상세 30일이다. `doctor`에서 쓰기 가능 여부,
Node/Java 런타임, Maven 설치 여부, 포트 사용 여부, 수집기 연결, 수신 건수·마지막 시각을 확인한다.
소스에서 실행한 `init`은 현재 CLI의 절대 경로를 규칙과 hook에 기록하므로 전역 설치가 필요 없다.
체크아웃을 옮겼다면 `init`으로 규칙을 다시 생성한다.
`/blackbox-status`는 전송 성공·실패, 유실, 대기 큐, 마지막 성공 전송 시각을 보여준다.
수집기에 도착하지 않은 유실은 어댑터 상태에서 확인해야 한다.

## AI 연결

MCP 클라이언트의 stdio 서버를 다음 값으로 등록한다. 절대 경로는 자신의 체크아웃
위치로 바꾸고, **작업 디렉터리는 수집기를 실행한 프로젝트 루트**로 지정한다.

```json
{
  "command": "node",
  "args": ["C:/path/to/blackbox/dist/cli.js", "mcp"],
  "cwd": "C:/path/to/blackbox"
}
```

클라이언트별 설정 파일 형식은 다를 수 있다. 위는 stdio 실행 속성이다.
AI에 “방금 발생한 spring-local 오류를 확인해줘. 목록과 선택한 사건 상세부터
조회하고 필요한 로그만 열어줘”라고 요청한다.

```text
list_incidents({service:"spring-local", since:"2026-10-19T00:00:00Z"})
get_incident({incidentId:"INC-..."})
get_network_request({requestId:"REQ-...", view:"raw", section:"logs", startLine:1, lineCount:10})
```

시간은 실제 실행 시각으로 바꾼다. 상세의 `event.requestId`가 원문 조회 ID다.
반복 발생 목록은 `list_network_requests({incidentId:"INC-..."})`로 확인한다.
`nextCursor`가 있으면 같은 필터와 `cursor`로 계속 조회한다. 모든 페이지를 읽은 뒤
`pollCursor`를 `after`에 넣으면 다음 수신 기록을 가져온다.

## 기존 앱에 붙이기

`BlackboxAdapter.java` 하나를 앱의 component scan 범위에 복사하고 패키지를 조정한다.
Spring Boot 3 MVC, Jackson, 기본 Logback을 사용한다. `local` 프로필과
`spring.application.name`을 지정한다. 요청·응답 body, 인증 헤더, 쿼리는 수집하지 않는다.
프론트가 `X-Dev-Blackbox-Trace-Id`를 보내면 그대로 전달하며 없으면 UUID를 만든다.
동일 trace ID의 두 요청도 로그 버퍼는 서로 다르다. trace ID 일치만으로 같은 발생
기록으로 합치지 않으며, 수집기가 각 요청에 별도 `REQ-...` ID를 부여한다.

MVC resolver는 처리된 예외도 관찰하되 `null`을 반환하여 기존 예외 처리를 유지한다.
요청 문맥 안의 `logger.error(message, throwable)`도 원인과 스택을 수집한다.
MVC/필터에서 관찰한 예외가 우선이며, 없으면 마지막 ERROR 로그의 Throwable을 사용한다.
요청 밖의 로그, 다른 로깅 backend, 기록하지 않고 삼킨 예외는 수집하지 않는다.
요청별 로그는 500개/64 KiB로 제한하며 오래된 일반 로그부터 버리고 ERROR를 우선 보존한다.
ERROR만 한도를 채우면 오래된 ERROR도 버리며 `droppedLogs`/`truncated`에 표시한다.

비동기는 `BlackboxAdapter.wrap(task)`로 실행 문맥을 전달하고 요청이 끝나기 전에
완료를 기다리는 작업까지 보장한다. `/async?marker=one`이 재현 예제다. 원래 스레드의
ThreadLocal/MDC를 `finally`에서 복원한다. 임의 executor, detached 작업, MVC Callable/
DeferredResult, Servlet async 완료, WebFlux/Reactor는 지원 범위 밖이다. Servlet async가
시작된 요청은 `incomplete:true`로 표시하며 필터 반환 시점 상태·시간만 수집한다.

## 실행 검증 및 데이터 비교

```sh
npm run build
mvn -f examples/spring-local/pom.xml package
node examples/spring-local/verify.mjs
```

JDK가 PATH에 없으면 JAVA_HOME 또는 JAVA를 지정한다. 검증기는 임시 포트를 사용하고
시작한 Java/MCP/수집기를 정리한다. Windows의 검증기 종료는 프로세스 종료이며 정상
Spring shutdown hook 실행을 검증하는 것은 아니다. 정상 종료 경로는 Ctrl+C를 사용한다.
결과는 `target/verification-*/`의 마스킹된 A/B 전달 데이터, MCP transcript, measurement.json에
남는다. 정상/실패/반복/동시 비동기/대량 로그/긴 스택/마스킹/수집기 단절/큐 초과 및
실제 CLI·MCP stdio 조회를 assert로 검증한다. 상세 결과와 한계는
[설계·조사 기록](../../docs/request-tracing.md)을 참고한다.

HTTP 요청/사건은 최근 수신 발생부터 조회한다. 같은 오류가 다시 발생해도 위로 올라온다.
마스킹 회귀 `/review-secret`, 로그로 처리한 예외 `/review-logged`, 한도를 넘긴 로그의
ERROR 보존 `/review-late`도 검증한다. 모두 가짜 인증 값을 사용하는 로컬 예제다.
토큰 수는 선택적으로 `pip install tiktoken==0.14.0` 후
`python examples/spring-local/measure-tokens.py examples/spring-local/target/verification-<실행ID>`로
재계산한다. 검증기가 출력한 디렉터리를 지정한다. 외부 LLM 호출은 없다.
