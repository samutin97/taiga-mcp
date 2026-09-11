import { checkArgs, formatReason } from "../../scripts/lib/voice-rules.mjs";
import type { VoiceGuardMode } from "./context.js";

type Result = { isError?: boolean; content: { type: "text"; text: string }[] };
type Handler = (args: unknown, extra: unknown) => Promise<Result> | Result;

/**
 * Server-side twin of the voice-gate hook, for MCP clients that have no
 * hooks. Off by default under Claude Code so the user is not asked twice.
 */
export function withVoiceGuard(mode: VoiceGuardMode, handler: Handler): Handler {
  if (mode === "off") return handler;
  return async (args, extra) => {
    const findings = checkArgs(args);
    if (findings.length === 0) return handler(args, extra);
    const reason = formatReason(findings);
    if (mode === "block") {
      return { isError: true, content: [{ type: "text", text: reason }] };
    }
    const result = await handler(args, extra);
    return { ...result, content: [...result.content, { type: "text", text: `Voice check:\n${reason}` }] };
  };
}
