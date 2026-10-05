# GeekNews 초안

모든 `<!-- BENCH -->` 자리표시자를 실제 벤치마크 수치로 채우거나 해당 문장을 지운 뒤에 올린다.

## 제목

> Show GN: dev-blackbox - AI 코딩 에이전트가 같은 에러를 반복해서 고치지 않게 하는 로컬 실패 기록기

## 링크

https://github.com/MycroCosmo/blackbox

## 본문

- AI 코딩 에이전트가 테스트 실패를 고칠 때 자주 보이는 패턴 세 가지를 겨냥한 npm CLI임
  - 매 실행을 처음 보는 실패로 여기고, 스택 트레이스에 찍힌 줄만 거듭 수정함
  - 수천 줄짜리 빌드 로그를 `tail`로 자르다가 원인이 적힌 줄을 놓침
  - 세션이 끝나면 그동안 파악한 실패 맥락이 사라짐
- `npx dev-blackbox run -- <명령>`으로 빌드·테스트를 실행함. 출력과 종료 코드는 그대로 전달함
- 실패하면 에러 타입, 정규화한 메시지, 최상단 애플리케이션 프레임으로 fingerprint를 만들고 반복 실패를 한 인시던트로 합침
  - 줄 번호는 fingerprint에서 제외하므로, 코드를 고쳐 줄이 밀려도 같은 실패로 인식함
  - stderr 끝에 `Incident`, `Occurrences: 2` 같은 짧은 요약을 붙임
  - 마지막 1,000줄 로그를 마스킹·압축해 `.dev-blackbox/`에 저장하고 `incident show --format json`으로 조회함
- Claude Code용 `PreToolUse` hook 제공: 감싸지 않은 `npm test`, `./gradlew test` 등을 막고 dev-blackbox로 다시 실행하라고 안내함
  - Codex·Cursor·Windsurf 등은 `AGENTS.md`, `.cursorrules`, `.windsurfrules`에 같은 규칙을 넣는 방식이고, MCP 서버도 있음
- 로컬 전용임. 텔레메트리 없음, 네트워크 collector는 `127.0.0.1`에만 바인딩, 토큰·인증 헤더·쿠키·개인 키는 저장 전에 마스킹함
- 저장소의 `bench/`에 A/B 벤치마크 하네스를 함께 공개함
  - 과제 3개: DTO 매핑 누락이 원인인 NPE(Spring Boot), 약 4,900줄 Gradle 로그 맨 앞에 한 번만 찍히는 설정 오류, 테스트 간 공유 상태 오염(Vitest)
  - dev-blackbox 없음(A)과 0.3.0 hook 적용(C)을 `claude -p` headless로 각 3회 실행, 중앙값 비교
  - 숨은 테스트로 채점해서 증상만 가린 수정은 실패 처리함
  - 결과: <!-- BENCH -->
- 한계도 함께 적어 둠
  - 조건당 3회라 표본이 작음. 과제도 작성자가 직접 만든 소규모 과제임
  - Gradle 로그 과제는 원인이 로그 맨 앞에 있어 마지막 1,000줄만 보관하는 0.3.0으로는 잡히지 않는 경우이고, 결과를 그대로 공개함
  - 0.3.0은 Windows에서 `run -- ./gradlew`가 동작하지 않는 버그가 있음
- MIT 라이선스, Node.js 20 이상
