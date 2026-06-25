import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectClaudeAgentEnv,
  hasAnthropicCredentials,
  hasMakersCredentials,
  resolveClaudeAgentModel,
  resolveMakersApiKey,
  resolveMakersBaseUrl,
  resolveModelName
} from "../_model";

type Env = Record<string, string | undefined>;

interface AgentContext {
  request?: {
    body?: unknown;
    method?: string;
    url?: string;
    signal?: AbortSignal;
    json?: () => Promise<unknown>;
    text?: () => Promise<string>;
  };
  env?: Env;
  conversation_id?: string;
  store?: {
    appendMessage?: (message: Record<string, unknown>) => Promise<void>;
    getMessages?: (query: {
      conversationId: string;
      limit?: number;
      order?: "asc" | "desc";
    }) => Promise<ConversationMessage[]>;
    claudeSessionStore?: () => unknown;
    claude_session_store?: () => unknown;
  };
  tools?: {
    toClaudeMcpServer?: () => {
      name: string;
      tools: unknown;
      allowedTools?: string[];
    };
  };
  tracer?: {
    span?: <T>(
      name: string,
      fn: (span: TraceSpan) => Promise<T> | T,
      attrs?: Record<string, string | number | boolean>
    ) => Promise<T>;
    setAttributes?: (attrs: Record<string, string | number | boolean>) => void;
  };
}

interface HotUrl {
  title: string;
  url: string;
  note?: string;
  tags?: string[];
  date?: string;
  source?: string;
}

interface RecentArticle {
  title: string;
  url?: string;
  summary: string;
  takeaways?: string[];
}

interface KnowledgeBase {
  account: string;
  rules: string;
  hotUrls: HotUrl[];
  recentArticles: RecentArticle[];
}

const DATA_FILE_PATHS = {
  account: "data/account.md",
  rules: "data/rules.md",
  hotUrls: "data/hot-urls.json",
  recentArticles: "data/recent-articles.json"
} as const;

interface ConversationMessage {
  role?: string;
  content?: unknown;
}

interface TraceSpan {
  setAttributes?: (attrs: Record<string, string | number | boolean>) => void;
}

interface DailyNewsArticle {
  headline?: string;
  name?: string;
  description?: string;
  articleSection?: string;
  datePublished?: string;
  url?: string;
  sameAs?: string[];
}

interface DailyNewsItem {
  item?: DailyNewsArticle;
}

interface DailyNewsCollection {
  "@type"?: string;
  mainEntity?: {
    itemListElement?: DailyNewsItem[];
  };
}

const DAILY_HOT_SOURCE_URL = "https://zglg.work/ai/today";
const DAILY_HOT_CACHE_MS = 10 * 60 * 1000;
let dailyHotCache: { expiresAt: number; items: HotUrl[] } | undefined;

const SYSTEM_PROMPT = [
  "你是 makers-topic-agent，一个服务于公众号/视频号内容生产的选题 Agent。",
  "你必须优先使用项目 data/ 目录中的账号定位、内容规则、热点网址和最近三篇文章作为判断依据。",
  "输出要偏实战、偏差异化，不要泛泛推荐热点；每个选题都要说明读者为什么现在应该点开。",
  "如果素材不足，明确指出缺口，并给出下一步补充素材建议。"
].join("\n");

const DEFAULT_USER_MESSAGE = "请基于 data 素材库，生成 5 个适合账号当前定位的高点击选题。";
const SANDBOX_FILE_TOOL_HINTS = [
  "mcp__edgeone__files_list",
  "mcp__edgeone__files_read",
  "files_list",
  "files_read"
];
const FALLBACK_SANDBOX_FILE_TOOLS = ["mcp__edgeone__files_list", "mcp__edgeone__files_read"];
const SANDBOX_FILE_READ_INSTRUCTIONS = [
  "Makers 沙箱素材读取要求：",
  "在生成选题前，优先通过 Makers 文件工具读取项目素材，这是本次真实生成链路的一部分。",
  "先调用文件列表工具列出当前目录，path 必须等于 \".\"。",
  "如果列表中包含 data 目录，再调用文件列表工具列出 data，并调用文件读取工具读取 data/account.md、data/rules.md、data/recent-articles.json 和 data/hot-urls.json。",
  "所有 path 参数都必须是相对路径，只能使用 .、data、data/account.md、data/rules.md、data/recent-articles.json、data/hot-urls.json。",
  "禁止使用 /workspace、/home/user、/、..、绝对路径、环境变量、密钥路径或 shell 命令；也不要调用 commands 工具。",
  "如果文件工具没有列出 data 目录，不要继续尝试读取缺失路径，直接使用 prompt 中已经注入的素材生成结果，且不要在最终回答里提到文件工具失败。",
  "读取后再结合这些素材、历史消息和今日热点生成选题。不要输出文件全文。"
].join("\n");
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const dataRootCandidates = [
  process.cwd(),
  path.resolve(moduleDir, ".."),
  path.resolve(moduleDir, "..", ".."),
  path.resolve(process.cwd(), "..")
];

async function readText(relativePath: string, fallback = ""): Promise<string> {
  for (const root of dataRootCandidates) {
    try {
      return await readFile(path.join(root, relativePath), "utf8");
    } catch {
      // Try the next likely root. Makers may run the Agent from a generated runtime dir.
    }
  }
  return fallback;
}

async function readJson<T>(relativePath: string, fallback: T): Promise<T> {
  const raw = await readText(relativePath);
  if (!raw.trim()) return fallback;

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Failed to parse ${relativePath}: ${(error as Error).message}`);
  }
}

async function withSpan<T>(
  context: AgentContext | undefined,
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: TraceSpan) => Promise<T> | T
): Promise<T> {
  if (typeof context?.tracer?.span === "function") {
    return context.tracer.span(name, fn, attrs);
  }

  return fn({ setAttributes() {} });
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function parseDailyHotUrls(html: string): HotUrl[] {
  const jsonLdBlocks = Array.from(
    html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  ).map((match) => decodeHtml(match[1] || "").trim());

  for (const block of jsonLdBlocks) {
    try {
      const parsed = JSON.parse(block) as DailyNewsCollection | DailyNewsCollection[];
      const collections = Array.isArray(parsed) ? parsed : [parsed];
      const collection = collections.find((item) => item?.["@type"] === "CollectionPage" && item.mainEntity);
      const articles = collection?.mainEntity?.itemListElement || [];
      const items: HotUrl[] = articles
        .map((entry): HotUrl | undefined => {
          const article = entry.item;
          const title = article?.headline || article?.name;
          const description = article?.description || "";
          if (!title || !description) return undefined;

          const sourceUrl = article.sameAs?.[0] || article.url || DAILY_HOT_SOURCE_URL;
          return {
            title,
            url: sourceUrl,
            note: `来自 zglg.work 今日AI快讯 ${article.datePublished || ""}。${description}`,
            tags: [article.articleSection, article.datePublished, "zglg.work"].filter(Boolean) as string[],
            date: article.datePublished,
            source: DAILY_HOT_SOURCE_URL
          };
        })
        .filter((item): item is HotUrl => item !== undefined);

      if (items.length > 0) return items.slice(0, 12);
    } catch {
      // Try the next JSON-LD block.
    }
  }

  return [];
}

async function fetchTodayHotUrls(): Promise<HotUrl[]> {
  if (dailyHotCache && dailyHotCache.expiresAt > Date.now()) return dailyHotCache.items;

  const response = await fetch(DAILY_HOT_SOURCE_URL, {
    headers: {
      "User-Agent": "makers-topic-agent/0.1 (+https://github.com/jackzhenguo/makers-topic-agent)"
    }
  });
  if (!response.ok) {
    throw new Error(`zglg.work returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const items = parseDailyHotUrls(html);
  if (items.length === 0) {
    throw new Error("No daily AI hot items found in zglg.work page.");
  }

  dailyHotCache = { expiresAt: Date.now() + DAILY_HOT_CACHE_MS, items };
  return items;
}

function hasKnowledge(kb: KnowledgeBase): boolean {
  return Boolean(kb.account.trim() || kb.rules.trim() || kb.hotUrls.length || kb.recentArticles.length);
}

async function fetchTextFromPublic(baseUrl: string, relativePath: string, fallback = ""): Promise<string> {
  try {
    const response = await fetch(new URL(relativePath, baseUrl));
    if (!response.ok) return fallback;
    return await response.text();
  } catch {
    return fallback;
  }
}

async function fetchJsonFromPublic<T>(baseUrl: string, relativePath: string, fallback: T): Promise<T> {
  const text = await fetchTextFromPublic(baseUrl, relativePath, "");
  if (!text) return fallback;

  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

async function loadKnowledgeBase(context?: AgentContext): Promise<KnowledgeBase> {
  return withSpan(context, "load_materials", { "agent.step": "load_materials" }, async (span) => {
    const [account, rules, staticHotUrls, recentArticles] = await withSpan(
      context,
      "read_project_materials",
      { "agent.step": "read_project_materials" },
      async (readSpan) => {
        const materials = await Promise.all([
          readText(DATA_FILE_PATHS.account),
          readText(DATA_FILE_PATHS.rules),
          readJson<HotUrl[]>(DATA_FILE_PATHS.hotUrls, []),
          readJson<RecentArticle[]>(DATA_FILE_PATHS.recentArticles, [])
        ]);
        readSpan.setAttributes?.({
          "materials.static_hot_count": materials[2].length,
          "materials.article_count": materials[3].length
        });
        return materials;
      }
    );

    let publicFallback: Partial<KnowledgeBase> = {};
    if (!hasKnowledge({ account, rules, hotUrls: staticHotUrls, recentArticles }) && context?.request?.url) {
      publicFallback = await withSpan(
        context,
        "read_static_public_fallback",
        { "agent.step": "read_static_public_fallback" },
        async () => {
          const publicBaseUrl = new URL(context.request?.url || "").origin;
          const [publicAccount, publicRules, publicHotUrls, publicRecentArticles] = await Promise.all([
            fetchTextFromPublic(publicBaseUrl, "/data/account.md"),
            fetchTextFromPublic(publicBaseUrl, "/data/rules.md"),
            fetchJsonFromPublic<HotUrl[]>(publicBaseUrl, "/data/hot-urls.json", []),
            fetchJsonFromPublic<RecentArticle[]>(publicBaseUrl, "/data/recent-articles.json", [])
          ]);
          return {
            account: publicAccount,
            rules: publicRules,
            hotUrls: publicHotUrls,
            recentArticles: publicRecentArticles
          };
        }
      );
    }

    const fallbackHotUrls = publicFallback.hotUrls?.length ? publicFallback.hotUrls : staticHotUrls;
    let dynamicHotUrls = fallbackHotUrls;
    let hotSource = fallbackHotUrls.length ? "static-fallback" : "empty";

    try {
      dynamicHotUrls = await withSpan(
        context,
        "fetch_today_hotspots",
        { "agent.step": "fetch_today_hotspots", "source.url": DAILY_HOT_SOURCE_URL },
        async (hotSpan) => {
          const items = await fetchTodayHotUrls();
          hotSpan.setAttributes?.({
            "hotspots.count": items.length,
            "hotspots.source": "zglg.work"
          });
          return items;
        }
      );
      hotSource = "zglg.work";
    } catch (error) {
      span.setAttributes?.({
        "hotspots.fallback": true,
        "hotspots.error": (error as Error).message.slice(0, 180)
      });
    }

    const kb = {
      account: account || publicFallback.account || "",
      rules: rules || publicFallback.rules || "",
      hotUrls: dynamicHotUrls,
      recentArticles: recentArticles.length ? recentArticles : publicFallback.recentArticles || []
    };

    span.setAttributes?.({
      "materials.hot_count": kb.hotUrls.length,
      "materials.article_count": kb.recentArticles.length,
      "materials.hot_source": hotSource
    });

    return kb;
  });
}

async function prepareSandboxDataFiles(kb: KnowledgeBase): Promise<string> {
  const candidates = process.platform === "win32" ? [process.cwd()] : ["/home/user", process.cwd(), "/workspace"];
  let firstWritableRoot = process.cwd();

  for (const workspaceRoot of Array.from(new Set(candidates))) {
    try {
      const dataDir = path.join(workspaceRoot, "data");
      await mkdir(dataDir, { recursive: true });
      await Promise.all([
        writeFile(path.join(workspaceRoot, DATA_FILE_PATHS.account), kb.account, "utf8"),
        writeFile(path.join(workspaceRoot, DATA_FILE_PATHS.rules), kb.rules, "utf8"),
        writeFile(path.join(workspaceRoot, DATA_FILE_PATHS.hotUrls), `${JSON.stringify(kb.hotUrls, null, 2)}\n`, "utf8"),
        writeFile(
          path.join(workspaceRoot, DATA_FILE_PATHS.recentArticles),
          `${JSON.stringify(kb.recentArticles, null, 2)}\n`,
          "utf8"
        )
      ]);
      firstWritableRoot = workspaceRoot;
      break;
    } catch {
      // The Agent can still run from injected prompt data if a candidate root is read-only.
    }
  }

  return firstWritableRoot;
}

async function parseBody(context: AgentContext): Promise<Record<string, unknown>> {
  const body = context.request?.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }

  if (typeof body === "string" && body.trim()) {
    return JSON.parse(body) as Record<string, unknown>;
  }

  if (typeof context.request?.json === "function") {
    const parsed = await context.request.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }

  if (typeof context.request?.text === "function") {
    const text = await context.request.text();
    if (text.trim()) {
      return JSON.parse(text) as Record<string, unknown>;
    }
  }

  return {};
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Makers-Conversation-Id",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    }
  });
}

function firstLines(markdown: string, maxLines: number): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, maxLines);
}

function makeLocalTopicPlan(message: string, kb: KnowledgeBase) {
  const urls = kb.hotUrls.slice(0, 8);
  const articles = kb.recentArticles.slice(0, 3);
  const accountSignals = firstLines(kb.account, 6);
  const ruleSignals = firstLines(kb.rules, 8);

  const candidates = urls.slice(0, 5).map((item, index) => {
    const article = articles[index % Math.max(articles.length, 1)];
    const sourceHint = item.note || item.title;
    const priorHint = article ? `延续《${article.title}》的读者兴趣，但换成更当前的切入点。` : "补齐最近三篇文章后，可进一步校准账号连续性。";

    return {
      title: `${item.title}：普通人能马上用上的 ${index + 1} 个切口`,
      angle: `从“${sourceHint}”切入，强调真实场景、操作路径和避坑判断。`,
      whyNow: "热点正在发生，读者需要有人把信息压缩成可执行判断。",
      fitWithAccount: accountSignals[0] || "围绕 AI 工具、Agent 和自动化实战做可落地内容。",
      continuity: priorHint,
      outline: [
        "一句话讲清楚这个变化到底是什么",
        "给出 2-3 个普通用户或创作者能复用的场景",
        "拆一条最小实操路径",
        "补充风险、门槛或替代方案",
        "收束成账号自己的判断和行动建议"
      ],
      sourceUrl: item.url,
      tags: item.tags ?? []
    };
  });

  if (candidates.length === 0) {
    candidates.push({
      title: "先补热点素材：当前 data/hot-urls.json 为空",
      angle: "把今天最值得跟进的 5-10 个网址放进 data/hot-urls.json 后再生成正式选题。",
      whyNow: "选题质量取决于热点素材的新鲜度和账号连续性。",
      fitWithAccount: accountSignals[0] || "账号定位尚未填写。",
      continuity: articles[0] ? `可参考最近文章《${articles[0].title}》。` : "最近三篇文章也为空，建议同步补齐。",
      outline: ["补热点网址", "补最近三篇文章", "重新运行 Agent"],
      sourceUrl: "",
      tags: []
    });
  }

  return {
    request: message,
    accountSignals,
    ruleSignals,
    recentArticleSignals: articles.map((article) => ({
      title: article.title,
      summary: article.summary,
      takeaways: article.takeaways ?? []
    })),
    candidates,
    recommended: candidates[0],
    nextDataActions: [
      "把今天确认要追的热点链接更新到 data/hot-urls.json",
      "把最近三篇公众号文章的标题、链接、摘要更新到 data/recent-articles.json",
      "如果账号定位变化，先改 data/account.md，再跑一次选题"
    ]
  };
}

function stringifyStoredContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => stringifyStoredContent(item)).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") {
    const maybeText = (content as { text?: unknown; content?: unknown }).text ?? (content as { content?: unknown }).content;
    if (typeof maybeText === "string") return maybeText;
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return "";
}

function formatConversationHistory(messages: ConversationMessage[]): string {
  return messages
    .slice(-8)
    .map((item) => {
      const role = item.role || "unknown";
      const content = stringifyStoredContent(item.content).replace(/\s+/g, " ").trim();
      return content ? `${role}: ${content.slice(0, 1200)}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

async function loadConversationHistory(context: AgentContext): Promise<ConversationMessage[]> {
  const conversationId = context.conversation_id;
  if (!conversationId || typeof context.store?.getMessages !== "function") return [];

  try {
    return await context.store.getMessages({ conversationId, limit: 12, order: "asc" });
  } catch {
    return [];
  }
}

function memoryInfo(context: AgentContext, history: ConversationMessage[]): Record<string, unknown> {
  return {
    conversationId: context.conversation_id ?? null,
    storeInjected: Boolean(context.store),
    appendMessage: typeof context.store?.appendMessage === "function",
    getMessages: typeof context.store?.getMessages === "function",
    claudeSessionStore: typeof context.store?.claudeSessionStore === "function",
    loadedHistoryMessages: history.length
  };
}

async function analyzeAccountStyle(context: AgentContext, kb: KnowledgeBase): Promise<void> {
  await withSpan(context, "analyze_account_style", { "agent.step": "analyze_account_style" }, async (span) => {
    span.setAttributes?.({
      "account.has_profile": Boolean(kb.account.trim()),
      "rules.has_rules": Boolean(kb.rules.trim()),
      "articles.count": kb.recentArticles.length
    });
  });
}

async function scoreHotspots(context: AgentContext, kb: KnowledgeBase): Promise<void> {
  await withSpan(context, "score_hotspots", { "agent.step": "score_hotspots" }, async (span) => {
    const highSignalCount = kb.hotUrls.filter((item) => item.tags?.some((tag) => /高|Agent|大模型/i.test(tag))).length;
    span.setAttributes?.({
      "hotspots.count": kb.hotUrls.length,
      "hotspots.high_signal_count": highSignalCount,
      "hotspots.dynamic_source": kb.hotUrls.some((item) => item.source === DAILY_HOT_SOURCE_URL)
    });
  });
}

function buildClaudePrompt(
  message: string,
  kb: KnowledgeBase,
  history: ConversationMessage[] = [],
  requireSandboxFileReads = false
): string {
  const historyText = formatConversationHistory(history);

  return [
    `用户请求：${message}`,
    "",
    ...(requireSandboxFileReads ? [SANDBOX_FILE_READ_INSTRUCTIONS, ""] : []),
    "同一 conversation 的历史消息：",
    historyText || "(当前没有历史消息，或本地运行时未注入 context.store)",
    "",
    "账号定位：",
    kb.account || "(data/account.md 为空)",
    "",
    "内容规则：",
    kb.rules || "(data/rules.md 为空)",
    "",
    "热点网址 JSON：",
    JSON.stringify(kb.hotUrls, null, 2),
    "",
    "最近三篇文章 JSON：",
    JSON.stringify(kb.recentArticles, null, 2),
    "",
    "请始终输出 JSON，字段可包含 summary、reply、topics、recommended、missingData。",
    "如果用户是在继续追问、要求解释、改写、展开某个 Topic、比较两个选题或基于上一轮做调整，请优先在 reply 中直接回答，不要强行重新生成 5 个新选题；可按需返回更新后的 topics。",
    "只有当用户明确要求生成、重新生成或补充选题列表时，topics 至少 5 条，每条包含 title、angle、whyNow、outline、sourceUrl。recommended 必须是 topics 中最适合首发的一条完整对象。"
  ].join("\n");
}

function filterAllowedTools(allowedTools: string[] = [], hints: string[] = []): string[] {
  if (!hints.length) return allowedTools;

  return allowedTools.filter((tool) =>
    hints.some((hint) => tool === hint || tool.endsWith(hint) || tool.includes(hint))
  );
}

function hasMcpTools(tools: unknown): boolean {
  if (Array.isArray(tools)) return tools.length > 0;
  if (tools && typeof tools === "object") return Object.keys(tools).length > 0;
  return Boolean(tools);
}

function resolveAllowedFileTools(edgeoneMcp?: { tools: unknown; allowedTools?: string[] }): string[] {
  if (!edgeoneMcp || !hasMcpTools(edgeoneMcp.tools)) return [];

  const matched = filterAllowedTools(edgeoneMcp.allowedTools ?? [], SANDBOX_FILE_TOOL_HINTS);
  return matched.length ? matched : FALLBACK_SANDBOX_FILE_TOOLS;
}

interface MakersChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
    delta?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

async function runMakersModel(
  message: string,
  kb: KnowledgeBase,
  env: Env,
  history: ConversationMessage[]
): Promise<string> {
  const apiKey = resolveMakersApiKey(env);
  if (!apiKey) {
    throw new Error("Missing MAKERS_MODELS_KEY or AI_GATEWAY_API_KEY.");
  }

  const baseUrl = resolveMakersBaseUrl(env).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: resolveModelName(env),
      temperature: 0.7,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildClaudePrompt(message, kb, history) }
      ]
    })
  });

  const text = await response.text();
  let payload: MakersChatResponse | undefined;
  try {
    payload = text ? (JSON.parse(text) as MakersChatResponse) : undefined;
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    throw new Error(payload?.error?.message || text || `Makers Models request failed: HTTP ${response.status}`);
  }

  const answer = payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.delta?.content || "";
  if (!answer.trim()) {
    throw new Error("Makers Models returned an empty answer.");
  }

  return answer;
}

function extractAssistantText(message: unknown): string {
  const content = (message as { message?: { content?: unknown[] } })?.message?.content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (block && typeof block === "object" && "text" in block) {
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

async function maybeAppendMessage(
  context: AgentContext,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  const conversationId = context.conversation_id;
  if (!conversationId || typeof context.store?.appendMessage !== "function") return;

  try {
    await context.store.appendMessage({ conversationId, role, content });
  } catch {
    // Local runs and early Makers previews should not fail only because history is unavailable.
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function runClaudeAgent(
  message: string,
  kb: KnowledgeBase,
  context: AgentContext,
  history: ConversationMessage[],
  enableSandboxTools = false
): Promise<string> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const env = context.env ?? process.env;
  const candidateMcp = enableSandboxTools ? context.tools?.toClaudeMcpServer?.() : undefined;
  const allowedFileTools = resolveAllowedFileTools(candidateMcp);
  const edgeoneMcp = candidateMcp && allowedFileTools.length > 0 ? candidateMcp : undefined;
  const prompt = buildClaudePrompt(message, kb, history, Boolean(edgeoneMcp));
  const cwd = edgeoneMcp ? await prepareSandboxDataFiles(kb) : process.cwd();
  const systemPrompt = edgeoneMcp ? `${SYSTEM_PROMPT}\n\n${SANDBOX_FILE_READ_INSTRUCTIONS}` : SYSTEM_PROMPT;

  const options: Record<string, unknown> = {
    model: resolveClaudeAgentModel(env),
    systemPrompt,
    cwd,
    maxTurns: edgeoneMcp ? 8 : 4,
    permissionMode: "bypassPermissions",
    settingSources: ["project"],
    tools: [],
    allowedTools: [],
    env: collectClaudeAgentEnv(env)
  };

  const sessionStore =
    context.store?.claudeSessionStore?.() ?? context.store?.claude_session_store?.();
  if (sessionStore) {
    options.sessionStore = sessionStore;
    if (context.conversation_id && UUID_PATTERN.test(context.conversation_id)) {
      options.sessionId = context.conversation_id;
    }
  }

  if (edgeoneMcp && typeof sdk.createSdkMcpServer === "function") {
    options.mcpServers = {
      [edgeoneMcp.name]: sdk.createSdkMcpServer({
        name: edgeoneMcp.name,
        tools: edgeoneMcp.tools as Parameters<typeof sdk.createSdkMcpServer>[0]["tools"],
        alwaysLoad: true
      })
    };
    options.allowedTools = allowedFileTools;
  }

  let assistantText = "";
  let resultText = "";
  const stream = sdk.query({ prompt, options });

  for await (const msg of stream) {
    const typed = msg as { type?: string; result?: unknown };
    if (typed.type === "assistant") {
      assistantText = extractAssistantText(msg) || assistantText;
    }

    if (typed.type === "result") {
      resultText = typeof typed.result === "string" ? typed.result : "";
      break;
    }
  }

  return resultText || assistantText || "Claude Agent SDK 未返回文本结果。";
}

export async function onRequest(context: AgentContext): Promise<Response> {
  if (context.request?.method === "OPTIONS") {
    return jsonResponse({ ok: true });
  }

  let body: Record<string, unknown>;
  try {
    body = await parseBody(context);
  } catch (error) {
    return jsonResponse({ ok: false, error: `Invalid JSON body: ${(error as Error).message}` }, 400);
  }

  if (body.action === "materials" || context.request?.method === "GET") {
    try {
      const materials = await loadKnowledgeBase(context);
      return jsonResponse({
        ok: true,
        route: "/topic",
        action: "materials",
        sourceUrl: DAILY_HOT_SOURCE_URL,
        materials
      });
    } catch (error) {
      return jsonResponse({ ok: false, error: (error as Error).message }, 500);
    }
  }

  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim()
      : DEFAULT_USER_MESSAGE;

  let kb: KnowledgeBase;
  try {
    kb = await loadKnowledgeBase(context);
  } catch (error) {
    return jsonResponse({ ok: false, error: (error as Error).message }, 500);
  }

  const history = await withSpan(
    context,
    "load_conversation_memory",
    { "agent.step": "load_conversation_memory" },
    async (span) => {
      const messages = await loadConversationHistory(context);
      span.setAttributes?.({ "memory.loaded_messages": messages.length });
      return messages;
    }
  );
  await withSpan(context, "persist_user_message", { "agent.step": "persist_user_message" }, async () => {
    await maybeAppendMessage(context, "user", message);
  });
  await analyzeAccountStyle(context, kb);
  await scoreHotspots(context, kb);

  const forceLocal = body.local === true || body.useLocal === true;
  const enableSandboxTools = body.sandboxTools !== false;
  const env = context.env ?? process.env;
  const shouldUseClaudeAgent =
    !forceLocal && hasAnthropicCredentials(env) && (enableSandboxTools || !hasMakersCredentials(env));

  if (!forceLocal && hasMakersCredentials(env) && !shouldUseClaudeAgent) {
    try {
      const answer = await withSpan(
        context,
        "generate_topics",
        { "agent.step": "generate_topics", "agent.runtime": "makers-models" },
        async () => runMakersModel(message, kb, env, history)
      );
      await withSpan(context, "persist_assistant_message", { "agent.step": "persist_assistant_message" }, async () => {
        await maybeAppendMessage(context, "assistant", answer);
      });
      return jsonResponse({
        ok: true,
        route: "/topic",
        mode: "makers-models",
        model: resolveModelName(env),
        memory: memoryInfo(context, history),
        answer,
        dataFiles: ["data/account.md", "data/rules.md", "data/hot-urls.json", "data/recent-articles.json"]
      });
    } catch (error) {
      const fallback = await withSpan(
        context,
        "generate_local_fallback",
        { "agent.step": "generate_local_fallback", "agent.runtime": "local" },
        async () => makeLocalTopicPlan(message, kb)
      );
      return jsonResponse({
        ok: true,
        route: "/topic",
        mode: "local-fallback",
        memory: memoryInfo(context, history),
        warning: `Makers Models failed, returned deterministic local plan instead: ${(error as Error).message}`,
        result: fallback
      });
    }
  }

  if (shouldUseClaudeAgent) {
    try {
      const answer = await withSpan(
        context,
        "generate_topics",
        { "agent.step": "generate_topics", "agent.runtime": "claude-agent-sdk" },
        async () => runClaudeAgent(message, kb, context, history, enableSandboxTools)
      );
      await withSpan(context, "persist_assistant_message", { "agent.step": "persist_assistant_message" }, async () => {
        await maybeAppendMessage(context, "assistant", answer);
      });
      return jsonResponse({
        ok: true,
        route: "/topic",
        mode: "claude-agent-sdk",
        model: resolveClaudeAgentModel(env),
        providerModel: resolveModelName(env),
        sandboxTools: enableSandboxTools,
        memory: memoryInfo(context, history),
        answer,
        dataFiles: ["data/account.md", "data/rules.md", "data/hot-urls.json", "data/recent-articles.json"]
      });
    } catch (error) {
      const fallback = await withSpan(
        context,
        "generate_local_fallback",
        { "agent.step": "generate_local_fallback", "agent.runtime": "local" },
        async () => makeLocalTopicPlan(message, kb)
      );
      return jsonResponse({
        ok: true,
        route: "/topic",
        mode: "local-fallback",
        memory: memoryInfo(context, history),
        warning: `Claude Agent SDK failed, returned deterministic local plan instead: ${(error as Error).message}`,
        result: fallback
      });
    }
  }

  const result = await withSpan(
    context,
    "generate_local_topics",
    { "agent.step": "generate_local_topics", "agent.runtime": "local" },
    async () => makeLocalTopicPlan(message, kb)
  );
  await withSpan(context, "persist_assistant_message", { "agent.step": "persist_assistant_message" }, async () => {
    await maybeAppendMessage(context, "assistant", JSON.stringify(result));
  });

  return jsonResponse({
    ok: true,
    route: "/topic",
    mode: "local",
    note: "未检测到 AI_GATEWAY_API_KEY 或 ANTHROPIC_API_KEY，因此使用本地确定性选题逻辑；部署到 Makers 并配置模型密钥后会走 Claude Agent SDK。",
    memory: memoryInfo(context, history),
    result
  });
}

export default onRequest;
