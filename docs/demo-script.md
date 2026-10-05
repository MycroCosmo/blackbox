# 데모 GIF 녹화 대본

README 상단 `<!-- DEMO_GIF -->` 자리에 들어갈 15~30초 GIF의 대본이다.
장면은 하나다. 에이전트가 같은 NPE를 두 번 고치려다 `Occurrences: 2`를 보고
방향을 틀어 진짜 원인(DTO 매핑 누락)을 고친다. 과제는 [bench 과제 a](../bench/tasks/a-npe-dto-mapping)를 쓴다.

## 먼저 알아둘 것

- **0.3.0에는 별도의 "루프 경고" 배너가 없다.** 반복 신호는 실패 요약의
  `Occurrences: 2` 한 줄과, `CLAUDE.md` 규칙("같은 에러가 반복되면 인시던트 이력부터 확인")이다.
  GIF에서는 편집 단계에서 이 줄을 강조(확대 또는 자막)한다. 없는 배너를 합성하지 않는다.
- **진짜 에이전트 세션만 "에이전트"라고 부른다.** 방식 A(실제 세션 녹화)가 기본이다.
  방식 B(vhs 재연)는 사람이 명령을 입력하는 재연이므로, 쓸 경우 캡션에 "reenactment"라고 밝힌다.
- **macOS, Linux, WSL에서 녹화한다.** 0.3.0은 Windows에서 `run -- ./gradlew test`가 실패한다
  ([bench/README.md](../bench/README.md#known-issues-dev-blackbox-030) 참고).
- 0.3.0을 npm에 배포하기 전이라면 `npm i -D dev-blackbox` 대신 저장소에서 만든
  tarball(`npm pack`)을 설치한다. 현재 npm의 최신 버전은 0.2.1이다.

## 준비 (녹화하지 않음)

```bash
cp -R bench/tasks/a-npe-dto-mapping/project /tmp/demo-a
cd /tmp/demo-a
printf '{\n  "name": "demo-a",\n  "private": true\n}\n' > package.json
npm i -D dev-blackbox            # 배포 전: npm i -D /path/to/dev-blackbox-0.3.0.tgz
npx dev-blackbox init --hooks claude-code
./gradlew --quiet testClasses    # 의존성 다운로드와 첫 컴파일을 녹화에서 뺀다
git init -q && git add -A && git commit -qm baseline
```

터미널은 100×28 정도, 폰트는 크게(18~20pt) 둔다. 프롬프트는 `$ ` 하나로 짧게 줄인다.

## 장면 구성 (배속 적용 후 기준)

| 시간 | 화면 | 강조할 것 |
|---|---|---|
| 0–3초 | `claude` 실행, 프롬프트 입력: "`./gradlew test` fails. Find the root cause and fix it so the whole test suite passes, without modifying anything under src/test." | 과제 문장 |
| 3–8초 | 에이전트가 `./gradlew test` 실행 → hook이 막고 `npx dev-blackbox run -- ./gradlew test`로 다시 실행 → `NullPointerException ... because "address" is null` / `Occurrences: 1` | 표면 에러 위치가 `ShippingLabelService.labelFor` |
| 8–13초 | 에이전트가 `ShippingLabelService`에 null 처리 추가 → 재실행 → 같은 NPE, **`Occurrences: 2`** | 이 줄을 확대/자막: "Same failure, second time" |
| 13–20초 | 에이전트가 `npx dev-blackbox incident show <ID> --format json` 확인 → `CustomerMapper` 열람 → `BeanUtils.copyProperties`가 `address` → `shippingAddress`를 복사하지 않는다는 것을 찾고 매퍼 수정 | 방향 전환 순간 |
| 20–26초 | 재실행 → `BUILD SUCCESSFUL`, `✓ Command succeeded — resolve candidate: INC-...` | 해결 후보 표시 |
| 26–28초 | 마지막 프레임 정지: 저장소 주소 | |

## 방식 A: 실제 Claude Code 세션 녹화 (권장)

도구는 [asciinema](https://docs.asciinema.org/)와 [agg](https://github.com/asciinema/agg)(cast → GIF 변환)다.

```bash
cd /tmp/demo-a
asciinema rec demo-a.cast -i 1.5 -c claude
```

세션 안에서 위 과제 문장을 그대로 입력한다. 끝나면 `/exit`.

```bash
agg --speed 4 --font-size 20 --idle-time-limit 1 --last-frame-duration 3 demo-a.cast demo-a.gif
```

- 에이전트가 첫 시도부터 매퍼를 고치면 이 장면은 나오지 않는다. 그런 테이크는 버리고,
  준비 단계부터 다시 한다(`git reset --hard && git clean -fdx -e node_modules`, 그리고
  `rm -rf .dev-blackbox`로 인시던트 기록도 지운다). 몇 번 만에 나왔는지 기록해 두고,
  런칭 글에서 질문을 받으면 그대로 답한다.
- 길이가 30초를 넘으면 `--speed`를 올리거나 asciinema cast에서 대기 구간을 자른다.
  에이전트의 명령이나 출력 순서를 편집하지는 않는다.

## 방식 B: vhs 재연 (결정적, 캡션에 "reenactment" 명시)

[vhs](https://github.com/charmbracelet/vhs)로 사람이 입력하는 재연을 녹화한다. dev-blackbox 출력은 실제 출력이다.
에이전트 화면이 아니므로 README에 쓸 때 캡션을 "Reenactment of an agent run, real dev-blackbox output"처럼 단다.

먼저 잘못된 수정을 패치 파일로 둔다(`/tmp/demo-a/wrong-fix.patch`).

```diff
--- a/src/main/java/com/example/orders/service/ShippingLabelService.java
+++ b/src/main/java/com/example/orders/service/ShippingLabelService.java
@@ -16,6 +16,7 @@ public class ShippingLabelService {
     }
 
     private String cityLine(AddressDto address) {
-        return address.getZipCode() + " " + address.getCity().toUpperCase(Locale.ROOT);
+        String city = address.getCity() == null ? "" : address.getCity().toUpperCase(Locale.ROOT);
+        return address.getZipCode() + " " + city;
     }
 }
```

올바른 수정도 패치로 둔다(`/tmp/demo-a/right-fix.patch`). `CustomerMapper.toDto`에서
`dto.setShippingAddress(...)`로 주소를 명시적으로 옮기는 수정이다. 직접 고친 뒤
`git diff > right-fix.patch`로 만들고 `git checkout .`로 되돌린다.

`demo-a.tape`:

```text
Output demo-a.gif
Set FontSize 20
Set Width 1200
Set Height 720
Set TypingSpeed 40ms
Set Shell "bash"

Hide
Type "cd /tmp/demo-a && clear"
Enter
Show

Type "npx dev-blackbox run -- ./gradlew test 2>&1 | tail -12"
Enter
Sleep 6s

Hide
Type "git apply wrong-fix.patch && clear"
Enter
Show

Type "# null guard added. again:"
Enter
Type "npx dev-blackbox run -- ./gradlew test 2>&1 | tail -12"
Enter
Sleep 6s

Type "npx dev-blackbox incident list"
Enter
Sleep 3s

Hide
Type "git checkout -- src && git apply right-fix.patch && clear"
Enter
Show

Type "# fixed the mapper instead:"
Enter
Type "npx dev-blackbox run -- ./gradlew test 2>&1 | tail -6"
Enter
Sleep 6s
```

```bash
vhs demo-a.tape
```

녹화 전 `rm -rf .dev-blackbox`로 이전 인시던트를 지워야 첫 실행이 `Occurrences: 1`로 나온다.

## 마무리 체크리스트

- [ ] GIF 길이 15~30초, 파일 크기 5MB 이하(GitHub README에서 빨리 뜨도록)
- [ ] `Occurrences: 2`가 멈춘 화면에서 읽힐 만큼 크다
- [ ] 방식 B를 썼다면 캡션에 "reenactment" 표기
- [ ] README와 README.ko의 `<!-- DEMO_GIF -->`를 `![demo](docs/demo-a.gif)`로 교체
