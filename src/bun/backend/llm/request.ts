import type { ChatMessage } from "../../../lib/types";

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  temperature?: number;
}

export function simpleRequest(system: string, user: string): ChatRequest {
  return { system, messages: [{ role: "user", content: user }] };
}

/** Flattens the conversation into a single prompt for one-shot CLIs. */
export function flattenRequest(req: ChatRequest, includeSystem: boolean): string {
  let out = "";
  if (includeSystem && req.system.trim() !== "") out += `${req.system}\n\n`;
  if (req.messages.length === 1) return out + req.messages[0].content;
  out += "Conversation so far:\n\n";
  for (const m of req.messages) out += `### ${m.role === "user" ? "User" : "Assistant"}\n${m.content}\n\n`;
  out += "Reply as the Assistant to the latest User message.";
  return out;
}
