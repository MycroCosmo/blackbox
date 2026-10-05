import type { IncidentRecord } from "./types.js";
import type { Storage } from "./storage.js";

/** Markdown incident reports (spec 4.5). Reports are VIEWS regenerated from
 *  incident data — they never append to an existing file and never mutate
 *  the underlying records. Default language is English (spec 3.4). */

type Lang = "en" | "ko";

const STRINGS = {
  en: {
    status: "Status",
    firstSeen: "First seen",
    lastSeen: "Last seen",
    occurrences: "Occurrences",
    command: "Command",
    exitCode: "Exit code",
    signal: "Signal",
    timedOut: "Timed out",
    facts: "Confirmed facts",
    hypotheses: "Suspected causes",
    noHypotheses: "None recorded. Facts above are verified; anything else is speculation.",
    relatedFiles: "Related files",
    resolution: "Resolution",
    open: "open (unresolved)",
    resolve_candidate: "resolve candidate (last run of this command succeeded)",
    resolved: "resolved",
    unresolvedNote: "Not resolved yet.",
    resolvedNote: "Resolved",
    candidateNote: "The failing command has since succeeded. Verify and run `dev-blackbox incident resolve` to close.",
    confidence: "confidence",
    pinned: "Pinned",
    location: "Latest location",
    rootCause: "Earliest cause (deepest cause of the first exception in the output)",
    outputLine: "output line",
    attempts: "Changes between occurrences",
    attemptUnknown: "file changes unknown (not a git workspace)",
    attemptNone: "no file changes (re-run without edits)",
    attemptChanged: "changed",
    attemptSame: "same failure",
  },
  ko: {
    status: "상태",
    firstSeen: "최초 발생",
    lastSeen: "최근 발생",
    occurrences: "발생 횟수",
    command: "실행 명령",
    exitCode: "종료 코드",
    signal: "종료 시그널",
    timedOut: "타임아웃",
    facts: "확인된 사실",
    hypotheses: "추정 원인",
    noHypotheses: "기록된 추정 원인이 없습니다. 위 사실 외에는 추측입니다.",
    relatedFiles: "관련 파일",
    resolution: "해결 상태",
    open: "미해결",
    resolve_candidate: "해결 후보 (동일 명령이 이후 성공함)",
    resolved: "해결됨",
    unresolvedNote: "아직 해결되지 않음",
    resolvedNote: "해결됨",
    candidateNote: "실패했던 명령이 이후 성공했습니다. 확인 후 `dev-blackbox incident resolve`로 종료하세요.",
    confidence: "신뢰도",
    pinned: "고정됨",
    location: "최근 오류 위치",
    rootCause: "가장 이른 원인 (출력의 첫 예외에서 가장 깊은 원인)",
    outputLine: "출력 줄",
    attempts: "발생 사이의 변경 내역",
    attemptUnknown: "변경 파일 알 수 없음 (git 작업 공간 아님)",
    attemptNone: "파일 변경 없음 (수정 없이 재실행)",
    attemptChanged: "변경",
    attemptSame: "같은 실패",
  },
} satisfies Record<Lang, Record<string, string>>;

function fmt(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z?$/, "");
}

export function renderIncidentReport(inc: IncidentRecord, lang: Lang = "en"): string {
  const t = STRINGS[lang];
  const lines: string[] = [];
  lines.push(`# ${inc.incidentId} ${inc.errorType}`);
  lines.push("");
  lines.push(`- ${t.status}: ${t[inc.status]}`);
  if (inc.pinned) lines.push(`- ${t.pinned}: true`);
  lines.push(`- ${t.firstSeen}: ${fmt(inc.firstSeenAt)}`);
  lines.push(`- ${t.lastSeen}: ${fmt(inc.lastSeenAt)}`);
  lines.push(`- ${t.occurrences}: ${inc.occurrenceCount}`);
  lines.push(`- ${t.command}: ${inc.lastCommand}`);
  if (inc.lastSignal) lines.push(`- ${t.signal}: ${inc.lastSignal}`);
  else lines.push(`- ${t.exitCode}: ${inc.lastExitCode}`);
  if (inc.timedOut) lines.push(`- ${t.timedOut}: true`);
  if (inc.lastLocation) {
    const loc = inc.lastLocation;
    lines.push(
      `- ${t.location}: ${loc.file}${loc.line ? `:${loc.line}` : ""}${loc.function ? ` (${loc.function})` : ""}`,
    );
  }
  if (inc.rootCause) {
    const rc = inc.rootCause;
    lines.push("");
    lines.push(`## ${t.rootCause}`);
    lines.push("");
    const where = rc.location
      ? ` — ${rc.location.file}${rc.location.line ? `:${rc.location.line}` : ""}${rc.location.function ? ` (${rc.location.function})` : ""}`
      : "";
    lines.push(`${rc.errorType}${rc.message ? `: ${rc.message}` : ""}${where} (${t.outputLine} ${rc.outputLine})`);
    if (rc.excerpt && rc.excerpt.length > 0) {
      lines.push("");
      lines.push("```text");
      for (const l of rc.excerpt) lines.push(l);
      lines.push("```");
    }
  }
  if (inc.attempts && inc.attempts.length > 0) {
    lines.push("");
    lines.push(`## ${t.attempts}`);
    lines.push("");
    for (const a of inc.attempts) {
      const step = `#${a.occurrence - 1} → #${a.occurrence} (${fmt(a.at)})`;
      if (a.changedFiles === null) lines.push(`- ${step}: ${t.attemptUnknown}`);
      else if (a.changedFiles.length === 0) lines.push(`- ${step}: ${t.attemptNone}`);
      else {
        const more = (a.changedCount ?? a.changedFiles.length) - a.changedFiles.length;
        lines.push(
          `- ${step}: ${t.attemptChanged} ${a.changedFiles.join(", ")}${more > 0 ? ` (+${more})` : ""} — ${t.attemptSame}`,
        );
      }
    }
  }
  lines.push("");
  lines.push(`## ${t.facts}`);
  lines.push("");
  for (const f of inc.facts) lines.push(`- ${f}`);
  lines.push("");
  lines.push(`## ${t.hypotheses}`);
  lines.push("");
  if (inc.hypotheses.length === 0) {
    lines.push(t.noHypotheses);
  } else {
    for (const h of inc.hypotheses) {
      lines.push(
        `- ${h.description}${h.confidence != null ? ` (${t.confidence}: ${Math.round(h.confidence * 100)}%)` : ""}`,
      );
    }
  }
  if (inc.relatedFiles.length > 0) {
    lines.push("");
    lines.push(`## ${t.relatedFiles}`);
    lines.push("");
    for (const f of inc.relatedFiles) lines.push(`- ${f}`);
  }
  lines.push("");
  lines.push(`## ${t.resolution}`);
  lines.push("");
  if (inc.status === "resolved") lines.push(`${t.resolvedNote}${inc.resolvedAt ? `: ${fmt(inc.resolvedAt)}` : ""}`);
  else if (inc.status === "resolve_candidate") lines.push(t.candidateNote);
  else lines.push(t.unresolvedNote);
  lines.push("");
  return lines.join("\n");
}

/** Regenerates the report from the latest incident record while holding the
 *  incident lock, preventing an older concurrent run from overwriting a
 *  newer occurrence's report. */
export function writeIncidentReport(
  storage: Storage,
  incidentId: string,
  lang: Lang = "en",
): string | undefined {
  return storage.withIncidentLock(() => {
    const current = storage.findIncident(incidentId);
    if (!current) return undefined;
    return storage.writeReport(current.incidentId, renderIncidentReport(current, lang));
  });
}
