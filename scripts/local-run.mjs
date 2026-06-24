import "dotenv/config";
import { onRequest } from "../agents/topic/index.ts";

const args = process.argv.slice(2);
const forceLocal = args.includes("--local") || process.env.LOCAL_ONLY === "1";
const message = args.filter((arg) => arg !== "--local").join(" ").trim();
const conversationId = `local_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
const hasModelKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.AI_GATEWAY_API_KEY || process.env.MAKERS_MODELS_KEY);

console.log(
  forceLocal || !hasModelKey
    ? "[local-run] Using local deterministic mode."
    : "[local-run] Calling configured model. This can take 30-120 seconds..."
);

const context = {
  request: {
    method: "POST",
    body: {
      message,
      local: forceLocal
    },
    signal: new AbortController().signal
  },
  conversation_id: conversationId,
  env: process.env,
  store: {
    async appendMessage() {},
    claudeSessionStore() {
      return undefined;
    }
  },
  tools: {
    toClaudeMcpServer() {
      return { name: "edgeone", tools: [], allowedTools: [] };
    }
  }
};

const response = await onRequest(context);
const text = await response.text();

console.log(`HTTP ${response.status}`);
console.log(text);
