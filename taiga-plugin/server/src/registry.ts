import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import type { ToolContext } from "./context.js";
import { withVoiceGuard } from "./voice-guard.js";

export type ToolKind = "read" | "create" | "update" | "destructive";

export interface ToolSpec<Args extends ZodRawShape> {
  name: string;
  description: string;
  input: Args;
  kind: ToolKind;
  /**
   * Hard gate: Claude Code prompts the user even when a hook or permission
   * rule would allow the call, and refuses it in dontAsk mode. Other MCP
   * clients ignore the key. Reserved for irreversible and bulk operations.
   */
  confirm?: boolean;
}

/**
 * MCP tool annotations by kind. Claude Code does not use them for
 * auto-approval; other clients do, and they cost nothing in the prompt.
 * openWorldHint is true everywhere: Taiga is an external system.
 */
const ANNOTATIONS: Record<ToolKind, {
  readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean;
}> = {
  read:        { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
  create:      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  update:      { readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: true },
  destructive: { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: true },
};

export const REQUIRES_USER_INTERACTION = "anthropic/requiresUserInteraction";

/**
 * The one place every tool is registered: annotations, hard gates and the
 * read-only filter live here so no tool file can forget them.
 */
export function defineTool<Args extends ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  spec: ToolSpec<Args>,
  handler: ToolCallback<Args>,
): void {
  if (ctx.options.readOnly && spec.kind !== "read") return;
  const guarded =
    spec.kind === "read"
      ? handler
      : (withVoiceGuard(
          ctx.options.voiceGuard,
          handler as unknown as Parameters<typeof withVoiceGuard>[1],
        ) as unknown as ToolCallback<Args>);
  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema: spec.input,
      annotations: ANNOTATIONS[spec.kind],
      ...(spec.confirm ? { _meta: { [REQUIRES_USER_INTERACTION]: true } } : {}),
    },
    guarded,
  );
}
