// Server-sent-event framing for the copy stream.
//
// EventSource is GET-only and the copy is a POST, so the browser reads the
// response body and parses the frames here. The awkward part is chunking: a
// read() boundary can land anywhere, including the middle of a frame or even
// between the two CRLF terminators, so partial frames must be buffered rather
// than parsed. This is that logic, kept out of the component so it can be
// tested against every awkward split point.

export type CopyEvent =
  | { kind: "status"; text: string }
  | { kind: "progress"; text: string }
  | { kind: "done"; report: any }
  | { kind: "error"; message: string; listeners?: any[]; probe?: any; report?: any };

/** Pull any complete events out of the buffer, leaving the remainder. */
export function drainFrames(buffer: string): { events: CopyEvent[]; rest: string } {
  const events: CopyEvent[] = [];
  const frames = buffer.split("\n\n");
  const rest = frames.pop() || "";
  for (const frame of frames) {
    const evLine = frame.split("\n").find((l) => l.startsWith("event: "));
    const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
    if (!evLine || !dataLine) continue; // blank keep-alive, or noise
    const name = evLine.slice(7).trim();
    let data: any = {};
    try {
      data = JSON.parse(dataLine.slice(6));
    } catch {
      continue; // a truncated data line can only happen if framing is broken
    }
    if (name === "status") events.push({ kind: "status", text: String(data.text ?? "") });
    else if (name === "progress") events.push({ kind: "progress", text: String(data.text ?? "") });
    else if (name === "done") events.push({ kind: "done", report: data.report });
    else if (name === "error") {
      events.push({
        kind: "error",
        message: String(data.message ?? "Copy failed"),
        listeners: data.listeners,
        probe: data.probe,
        report: data.report,
      });
    }
  }
  return { events, rest };
}
