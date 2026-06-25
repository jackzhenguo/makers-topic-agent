type Env = Record<string, string | undefined>;

const DEFAULT_MODEL = "@makers/deepseek-v4-flash";
const DEFAULT_CLAUDE_AGENT_MODEL = "claude-sonnet-4-20250514";
const CLAUDE_AGENT_PRO_ALIAS = "claude-opus-4-20250514";
const DEFAULT_EDGEONE_GATEWAY_BASE_URL = "https://ai-gateway.edgeone.link/v1";

function readEnv(env: Env | undefined, key: string): string | undefined {
  return env?.[key] || process.env[key];
}

export function resolveModelName(env?: Env): string {
  return readEnv(env, "AI_GATEWAY_MODEL") || readEnv(env, "ANTHROPIC_MODEL") || DEFAULT_MODEL;
}

export function resolveClaudeAgentModel(env?: Env): string {
  const model = readEnv(env, "ANTHROPIC_MODEL") || readEnv(env, "AI_GATEWAY_MODEL");
  if (!model) return DEFAULT_CLAUDE_AGENT_MODEL;

  const normalized = model.toLowerCase();
  if (normalized.includes("deepseek-v4-pro")) return CLAUDE_AGENT_PRO_ALIAS;
  if (normalized.includes("deepseek") || normalized.startsWith("@makers/")) return DEFAULT_CLAUDE_AGENT_MODEL;

  return model;
}

export function hasModelCredentials(env?: Env): boolean {
  return Boolean(hasMakersCredentials(env) || hasAnthropicCredentials(env));
}

export function resolveMakersApiKey(env?: Env): string | undefined {
  return readEnv(env, "MAKERS_MODELS_KEY") || readEnv(env, "AI_GATEWAY_API_KEY");
}

export function resolveMakersBaseUrl(env?: Env): string {
  return readEnv(env, "AI_GATEWAY_BASE_URL") || DEFAULT_EDGEONE_GATEWAY_BASE_URL;
}

export function hasMakersCredentials(env?: Env): boolean {
  return Boolean(resolveMakersApiKey(env));
}

export function hasAnthropicCredentials(env?: Env): boolean {
  return Boolean(readEnv(env, "ANTHROPIC_API_KEY"));
}

export function collectGatewayEnv(env?: Env): Record<string, string> {
  const result: Record<string, string> = {};
  const gatewayKey = readEnv(env, "AI_GATEWAY_API_KEY");
  const anthropicKey = readEnv(env, "ANTHROPIC_API_KEY");
  const gatewayBaseUrl = readEnv(env, "AI_GATEWAY_BASE_URL");
  const anthropicBaseUrl = readEnv(env, "ANTHROPIC_BASE_URL");
  const model = resolveModelName(env);

  if (gatewayKey) {
    result.ANTHROPIC_API_KEY = gatewayKey;
    result.ANTHROPIC_BASE_URL = gatewayBaseUrl || DEFAULT_EDGEONE_GATEWAY_BASE_URL;
  } else if (anthropicKey) {
    result.ANTHROPIC_API_KEY = anthropicKey;
    if (anthropicBaseUrl) {
      result.ANTHROPIC_BASE_URL = anthropicBaseUrl;
    }
  }

  if (model) {
    result.ANTHROPIC_SMALL_FAST_MODEL = readEnv(env, "AI_GATEWAY_SMALL_MODEL") || model;
  }

  const customHeaders = readEnv(env, "ANTHROPIC_CUSTOM_HEADERS");
  if (customHeaders) {
    result.ANTHROPIC_CUSTOM_HEADERS = customHeaders;
  }

  return result;
}

export function collectClaudeAgentEnv(env?: Env): Record<string, string> {
  const result = collectGatewayEnv(env);
  result.ANTHROPIC_SMALL_FAST_MODEL = resolveClaudeAgentModel(env);
  return result;
}
