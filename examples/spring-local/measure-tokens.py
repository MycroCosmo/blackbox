"""Optional: pip install tiktoken==0.14.0; python measure-tokens.py target/verification-...

Counts saved MCP payloads; never calls an LLM. No runtime product dependency.
"""
import hashlib
import json
import sys
from pathlib import Path

import tiktoken

run = Path(sys.argv[1])


def read(name):
    return (run / name).read_text(encoding="utf-8")


def stack_text(error):
    if not error:
        return ""
    result, previous = [], []
    for index, cause in enumerate([error] + error.get("causes", [])):
        stack, common = cause["stack"], 0
        if index:
            for left, right in zip(reversed(previous), reversed(stack)):
                if left != right:
                    break
                common += 1
        result.append(("Caused by: " if index else "") + cause["type"] + ": " + cause["message"])
        result.extend(stack[:-common] if common else stack)
        if common:
            result.append(f"... {common} more")
        previous = stack
    return "\n".join(result)


records = json.loads(read("A-all-records.json"))
calls = json.loads(read("mcp-transcript.json"))
baseline = "\n\n".join("\n".join([
    f"{e['timestamp']} {e['method']} {e['url']} -> {e.get('status')} requestId={e['requestId']}",
    *e.get("profile", {}).get("logs", []), stack_text(e.get("profile", {}).get("exception")),
]) for e in records)
texts = {
    "A_logText": baseline,
    "A_storedJSON": read("A-all-records.json"),
    "B_listAndDetail": read("B-staged.txt"),
    "toolSchemasCompact": read("mcp-tools.json"),
    "toolSchemasPretty": json.dumps(json.loads(read("mcp-tools.json")), ensure_ascii=False, indent=2),
    "callArguments": "\n".join(json.dumps(json.loads(c["request"])["params"], separators=(",", ":")) for c in calls[:2]),
    "optionalRaw": calls[2]["response"]["result"]["content"][0]["text"],
    "repeatedDetail": calls[1]["response"]["result"]["content"][0]["text"],
}
metrics = {}
for name, text in texts.items():
    metrics[name] = {"bytes": len(text.encode("utf-8")), "characters": len(text),
                     "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}
    for encoding in ("o200k_base", "cl100k_base"):
        metrics[name][encoding] = len(tiktoken.get_encoding(encoding).encode(text, disallowed_special=()))
result = {
    "measuredAt": json.loads(read("measurement.json"))["measuredAt"],
    "tiktoken": tiktoken.__version__, "records": len(records),
    "scope": "Literal input text tokens, not full conversation cost or model billing. A is reconstructed captured logs with common Java frames collapsed; B investigates one incident.",
    "querySequence": [json.loads(c["request"])["params"] for c in calls],
    "metrics": metrics,
    "contentSavingsPercent": {e: round(100 * (1 - metrics["B_listAndDetail"][e] / metrics["A_logText"][e]), 2)
                              for e in ("o200k_base", "cl100k_base")},
}
(run / "A-log-text.txt").write_text(baseline, encoding="utf-8")
(run / "token-measurement.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps(result, indent=2))
