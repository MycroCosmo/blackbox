import { isFailure, type NetworkRecord } from "./network.js";

/** NETWORK.md renderer (spec 5.5). A regenerated VIEW over recent data —
 *  never appended to. */

const RESULT_LABEL: Record<string, { en: string; ko: string }> = {
  success: { en: "ok", ko: "정상" },
  http_error: { en: "server error", ko: "서버 오류" },
  network_error: { en: "network error", ko: "네트워크 오류" },
  timeout: { en: "timeout", ko: "타임아웃" },
  aborted: { en: "aborted", ko: "중단됨" },
  cors_error: { en: "CORS error", ko: "CORS 오류" },
  contract_mismatch: { en: "contract mismatch", ko: "계약 불일치" },
  deserialization_error: { en: "deserialization error", ko: "역직렬화 오류" },
  empty_response: { en: "empty response", ko: "빈 응답" },
  slow_response: { en: "slow", ko: "느린 요청" },
};

export function renderNetworkReport(
  events: NetworkRecord[],
  opts: { lang?: "en" | "ko"; recentLimit?: number } = {},
): string {
  const lang = opts.lang ?? "en";
  const recentLimit = opts.recentLimit ?? 30;
  const t = (en: string, ko: string) => (lang === "ko" ? ko : en);

  const failed = events.filter((e) => isFailure(e.classification)).length;
  const slow = events.filter((e) => e.classification === "slow_response").length;
  const mismatch = events.filter((e) => e.classification === "contract_mismatch").length;
  const sessions = [...new Set(events.map((e) => e.sessionId))];
  const latestSession = sessions[sessions.length - 1];

  const lines: string[] = [];
  lines.push("# Network Summary", "");
  if (latestSession) lines.push(`- ${t("Current session", "현재 세션")}: ${latestSession}`);
  lines.push(`- ${t("Total requests", "총 요청")}: ${events.length}`);
  lines.push(`- ${t("Success", "성공")}: ${events.length - failed - slow}`);
  lines.push(`- ${t("Failed", "실패")}: ${failed}`);
  lines.push(`- ${t("Slow", "느린 요청")}: ${slow}`);
  lines.push(`- ${t("Contract mismatch", "계약 불일치")}: ${mismatch}`);
  lines.push("");
  lines.push(`## ${t("Recent requests", "최근 요청")}`, "");
  lines.push(
    `| ${t("Time", "시간")} | ID | ${t("Request", "요청")} | ${t("Status", "상태")} | ${t("Duration", "소요 시간")} | ${t("Result", "결과")} | Trace |`,
  );
  lines.push("|---|---|---|---:|---:|---|---|");
  for (const e of events.slice(-recentLimit)) {
    const time = e.timestamp.slice(11, 19);
    const label = RESULT_LABEL[e.classification]?.[lang] ?? e.classification;
    lines.push(
      `| ${time} | ${e.requestId} | ${e.method} ${e.url} | ${e.status ?? "-"} | ${e.durationMs != null ? `${e.durationMs}ms` : "-"} | ${label} | ${e.traceId ?? "-"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Detailed regenerated view for one failed network event. The record has
 * already been redacted and size-capped by the collector before rendering. */
export function renderNetworkFailureReport(record: NetworkRecord): string {
  const lines = [
    `# ${record.requestId} ${record.classification}`,
    "",
    `- Time: ${record.timestamp}`,
    `- Request: ${record.method} ${record.url}`,
    `- Status: ${record.status ?? "-"}`,
    `- Duration: ${record.durationMs != null ? `${record.durationMs}ms` : "-"}`,
    `- Trace: ${record.traceId ?? "-"}`,
    `- Incident: ${record.incidentId ?? "-"}`,
  ];
  if (record.errorMessage) lines.push(`- Error: ${record.errorMessage}`);
  lines.push("");

  if (record.contractMismatches?.length) {
    lines.push("## Contract mismatches", "");
    for (const mismatch of record.contractMismatches) {
      lines.push(`- ${mismatch.path}: expected ${mismatch.expected}, got ${mismatch.actual}`);
    }
    lines.push("");
  }

  const sections: Array<[string, unknown]> = [
    ["Request headers", record.requestHeaders],
    ["Request body", record.requestBody],
    ["Response headers", record.responseHeaders],
    ["Response body", record.responseBody],
  ];
  for (const [title, value] of sections) {
    if (value === undefined) continue;
    lines.push(`## ${title}`, "", "```json", JSON.stringify(value, null, 2), "```", "");
  }
  return lines.join("\n");
}
