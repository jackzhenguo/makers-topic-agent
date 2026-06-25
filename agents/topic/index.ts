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

type IntentType = "generate_topics" | "list_existing_topics" | "expand_topic" | "follow_up" | "other";

interface IntentResult {
  type: IntentType;
  showResult: boolean;
  confidence: number;
  reason: string;
  source: "model" | "default";
  topicIndex?: number | null;
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

function readEnvValue(env: Env | undefined, key: string): string | undefined {
  return env?.[key] || process.env[key];
}

const SYSTEM_PROMPT = [
  "你是 makers-topic-agent，一个服务于公众号/视频号内容生产的选题 Agent。",
  "你必须优先使用项目 data/ 目录中的账号定位、内容规则、热点网址和最近三篇文章作为判断依据。",
  "输出要偏实战、偏差异化，不要泛泛推荐热点；每个选题都要说明读者为什么现在应该点开。",
  "如果素材不足，明确指出缺口，并给出下一步补充素材建议。"
].join("\n");

const DEFAULT_USER_MESSAGE = "请基于 data 素材库，生成 5 个适合账号当前定位的高点击选题。";
const SANDBOX_FILE_TOOL_HINTS = [
  "mcp__edgeone__files_list",
  "files_list"
];
const FALLBACK_SANDBOX_FILE_TOOLS = ["mcp__edgeone__files_list"];
const SANDBOX_FILE_READ_INSTRUCTIONS = [
  "Makers sandbox tool requirement:",
  "Call the EdgeOne file list tool exactly once before generating topics.",
  "The only allowed tool call is files_list with path exactly equal to \".\".",
  "Do not call files_list with path \"data\" or any other path.",
  "Do not call files_read. The project materials are already injected in this prompt below.",
  "Do not use /workspace, /home/user, /, .., absolute paths, environment variables, secret paths, or shell commands.",
  "After the single files_list(\".\") call, continue with the injected account profile, content rules, hot URLs, recent articles, conversation memory, and today's hotspots.",
  "Never mention sandbox directory layout, missing data directories, file tool failures, or prompt injection in the final answer."
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

function parseStoredTopicPlan(content: string): { topics: Array<Record<string, unknown>>; recommended?: Record<string, unknown> } | undefined {
  const candidates = [
    content,
    content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || ""
  ].filter(Boolean);

  for (const candidate of candidates) {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) continue;

    try {
      const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
      const topics = parsed.topics || parsed.candidates;
      if (Array.isArray(topics) && topics.length > 0) {
        return {
          topics: topics.filter((topic): topic is Record<string, unknown> => Boolean(topic && typeof topic === "object")),
          recommended: parsed.recommended && typeof parsed.recommended === "object" ? (parsed.recommended as Record<string, unknown>) : undefined
        };
      }
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

function lastTopicPlanFromHistory(history: ConversationMessage[]): { topics: Array<Record<string, unknown>>; recommended?: Record<string, unknown> } | undefined {
  for (const item of [...history].reverse()) {
    if (item.role !== "assistant") continue;
    const plan = parseStoredTopicPlan(stringifyStoredContent(item.content));
    if (plan?.topics.length) return plan;
  }

  return undefined;
}

function topicIndexFromMessage(message: string): number {
  const match = message.match(/(?:Topic|话题|选题)\s*(\d+|[一二三四五六七八九十])/i);
  if (!match) return 0;
  const raw = match[1];
  const chineseNumbers: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10
  };
  const number = Number(raw) || chineseNumbers[raw] || 1;
  return Math.max(number - 1, 0);
}

function topicText(topic: Record<string, unknown>, key: string): string {
  const value = topic[key];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean).join("；");
  return typeof value === "string" ? value : "";
}

function makeLocalFollowupReply(message: string, kb: KnowledgeBase, history: ConversationMessage[]) {
  const plan = lastTopicPlanFromHistory(history);
  const fallbackPlan = makeLocalTopicPlan(message, kb);
  const topics = plan?.topics.length ? plan.topics : fallbackPlan.candidates;
  const topic = topics[topicIndexFromMessage(message)] || topics[0];
  const title = topicText(topic, "title") || topicText(topic, "event") || "上一轮选题";
  const angle = topicText(topic, "angle") || topicText(topic, "whyNow") || topicText(topic, "summary");
  const outline = topicText(topic, "outline")
    .split(/[；;]\s*/)
    .filter(Boolean)
    .slice(0, 5);
  const outlineText = outline.length
    ? outline.map((item, index) => `${index + 1}. ${item}`).join(" ")
    : "1. 开场判断：先说明这个热点为什么值得写。 2. 背景压缩：把官方更新翻译成读者能懂的话。 3. 实操路径：给出普通人马上能验证的步骤。 4. 坑点提醒：标注限制、成本和适用边界。 5. 行动建议：告诉读者今天该怎么试。";

  return {
    request: message,
    reply: `模型调用暂时失败，我先基于上一轮上下文做本地展开。标题：${title}。切入角度：${angle || "围绕真实使用场景展开，避免只复述新闻。"} 文章结构：${outlineText}`,
    recommended: {
      title,
      angle,
      outline
    }
  };
}

function makeLocalTopicListReply(message: string, kb: KnowledgeBase, history: ConversationMessage[]) {
  const plan = lastTopicPlanFromHistory(history);
  const fallbackPlan = makeLocalTopicPlan(message, kb);
  const topics = (plan?.topics.length ? plan.topics : fallbackPlan.candidates).slice(0, 5);
  const lines = topics.map((topic, index) => {
    const title = topicText(topic, "title") || topicText(topic, "event") || `Topic ${index + 1}`;
    const angle = topicText(topic, "angle") || topicText(topic, "summary") || topicText(topic, "whyNow");
    return `Topic ${index + 1}: ${title}${angle ? `。${angle}` : ""}`;
  });

  return {
    request: message,
    reply: lines.length
      ? `上一轮可继续推进的选题有：${lines.join(" ")}`
      : "当前会话里还没有可复用的选题列表。你可以先让我结合今日热点生成 5 个公众号选题。",
    recommended: lines[0]
      ? {
          title: "已有选题列表",
          angle: lines.join(" ")
        }
      : undefined
  };
}

function makeIntentUnavailableReply(message: string, intent: IntentResult) {
  return {
    request: message,
    reply: `意图识别模型暂时不可用，所以本轮没有继续执行生成或改写。请先检查模型 API Key / Base URL 配置，再重试。错误摘要：${intent.reason}`,
    recommended: {
      title: "意图识别模型不可用",
      angle: "为避免把普通追问误判成重新生成选题，系统在无法完成模型意图识别时会停止自动生成。"
    }
  };
}

function makeLocalReplyForIntent(
  message: string,
  kb: KnowledgeBase,
  history: ConversationMessage[],
  intent: IntentResult
) {
  if (intent.source === "default" && intent.reason.includes("intent model")) {
    return makeIntentUnavailableReply(message, intent);
  }

  if (intent.type === "list_existing_topics") {
    return makeLocalTopicListReply(message, kb, history);
  }

  return makeLocalFollowupReply(message, kb, history);
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
  requireSandboxFileReads = false,
  intent?: IntentResult
): string {
  const historyText = formatConversationHistory(history);
  const intentText = JSON.stringify(intent || defaultIntent("intent not classified"), null, 2);

  return [
    `用户请求：${message}`,
    "",
    "本轮意图识别 JSON：",
    intentText,
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
    "请始终输出 JSON，第一行必须是 {，最后一行必须是 }，不要输出任何 JSON 外的解释文字。",
    "字段可包含 summary、reply、topics、recommended、missingData。",
    "如果本轮意图 type 不是 generate_topics 或 showResult 不是 true，请只在 reply 中回答追问，不要返回新的 topics 数组。",
    "当用户要求生成公众号选题时，必须返回 topics 数组，不能只在 reply 里用自然语言列出选题。",
    "summary 控制在 120 个中文字符以内，reply 控制在 220 个中文字符以内，不能使用 Markdown 标题，也不要复述工具调用、沙箱路径、文件读取失败等内部过程。",
    "当用户说“喜欢话题 N”“继续展开”“展开大纲”“改得更适合某类读者”时，reply 应该输出面向公众号写作的标题、切入角度和文章结构，不要输出 shell 命令、代码块或工具调用示例，除非用户明确要求给代码/命令。",
    "missingData 只能是简短字符串或字符串数组；如果素材缺口不影响首发，留空字符串。不要返回 { message, gaps } 这类对象。",
    "如果用户是在继续追问、要求解释、改写、展开某个 Topic、比较两个选题或基于上一轮做调整，请优先在 reply 中直接回答，不要强行重新生成 5 个新选题；可按需返回更新后的 topics。",
    "只有当用户明确要求生成、重新生成或补充选题列表时，topics 至少 5 条，每条包含 title、angle、whyNow、outline、sourceUrl。recommended 必须是 topics 中最适合首发的一条完整对象，并且只使用 title、angle、whyNow、outline、sourceUrl 等选题字段。"
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

function extractJsonObjectFromAnswer(answer: string): Record<string, unknown> | undefined {
  const text = answer.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return undefined;

  try {
    const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function answerHasTopicList(answer: string): boolean {
  const parsed = extractJsonObjectFromAnswer(answer);
  const topics = parsed?.topics ?? parsed?.candidates;
  return Array.isArray(topics) && topics.length > 0;
}

function defaultIntent(reason: string): IntentResult {
  return {
    type: "other",
    showResult: false,
    confidence: 0,
    reason,
    source: "default",
    topicIndex: null
  };
}

function normalizeIntentResult(value: unknown, source: IntentResult["source"] = "model"): IntentResult {
  const objectValue = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const allowedTypes = new Set<IntentType>([
    "generate_topics",
    "list_existing_topics",
    "expand_topic",
    "follow_up",
    "other"
  ]);
  const rawType = typeof objectValue.type === "string" ? objectValue.type : "";
  const type = allowedTypes.has(rawType as IntentType) ? (rawType as IntentType) : "other";
  const confidence = Number(objectValue.confidence);
  const topicIndex = Number(objectValue.topicIndex);

  return {
    type,
    showResult: type === "generate_topics" && objectValue.showResult !== false,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(confidence, 1)) : 0.5,
    reason: typeof objectValue.reason === "string" ? objectValue.reason.slice(0, 240) : "model classified intent",
    source,
    topicIndex: Number.isFinite(topicIndex) ? topicIndex : null
  };
}

function buildIntentClassifierPrompt(message: string, history: ConversationMessage[]): string {
  const historyText = formatConversationHistory(history).slice(0, 5000);

  return [
    "You classify the user's intent for a Chinese WeChat topic-agent.",
    "Return only a compact JSON object. Do not write markdown.",
    "",
    "Allowed JSON shape:",
    "{\"type\":\"generate_topics|list_existing_topics|expand_topic|follow_up|other\",\"showResult\":false,\"confidence\":0.0,\"reason\":\"short reason\",\"topicIndex\":null}",
    "",
    "Intent rules:",
    "- generate_topics: the user explicitly asks to generate, regenerate, design, recommend, or add a new list of WeChat article topic ideas. showResult must be true.",
    "- list_existing_topics: the user asks what topics were already generated, asks to list existing topics, or asks for the previous three/five topics. showResult must be false.",
    "- expand_topic: the user asks to expand, rewrite, optimize, compare, or tailor a specific Topic N or an already generated topic. showResult must be false.",
    "- follow_up: the user asks a normal contextual question based on the previous answer. showResult must be false.",
    "- other: unrelated or ambiguous requests. showResult must be false.",
    "",
    "Examples:",
    "User: 结合最近三篇文章和今日 AI 热点，生成 5 个适合公众号的高点击选题 => {\"type\":\"generate_topics\",\"showResult\":true,\"confidence\":0.98,\"reason\":\"explicitly asks to generate 5 topic ideas\",\"topicIndex\":null}",
    "User: 有哪三个话题？ => {\"type\":\"list_existing_topics\",\"showResult\":false,\"confidence\":0.95,\"reason\":\"asks to list existing topics, not regenerate\",\"topicIndex\":null}",
    "User: 喜欢话题3，继续展开 => {\"type\":\"expand_topic\",\"showResult\":false,\"confidence\":0.97,\"reason\":\"asks to expand an existing topic\",\"topicIndex\":3}",
    "User: 把 Topic 2 改得更适合开发者 => {\"type\":\"expand_topic\",\"showResult\":false,\"confidence\":0.98,\"reason\":\"asks to adjust a specific existing topic\",\"topicIndex\":2}",
    "",
    "Conversation history:",
    historyText || "(empty)",
    "",
    `Current user message: ${message}`,
    "",
    "JSON:"
  ].join("\n");
}

async function runMakersIntentClassifier(
  message: string,
  history: ConversationMessage[],
  env: Env
): Promise<IntentResult> {
  const apiKey = resolveMakersApiKey(env);
  if (!apiKey) throw new Error("Missing Makers model key for intent classification.");

  const baseUrl = resolveMakersBaseUrl(env).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: resolveModelName(env),
      temperature: 0,
      max_tokens: 360,
      messages: [
        { role: "system", content: "You are a strict intent classifier. Return JSON only." },
        { role: "user", content: buildIntentClassifierPrompt(message, history) }
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
    throw new Error(payload?.error?.message || text || `Intent classifier failed: HTTP ${response.status}`);
  }

  const answer = payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.delta?.content || "";
  const parsed = extractJsonObjectFromAnswer(answer);
  if (!parsed) throw new Error("Intent classifier did not return JSON.");
  return normalizeIntentResult(parsed, "model");
}

function anthropicMessagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, "");
  return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

async function runAnthropicIntentClassifier(
  message: string,
  history: ConversationMessage[],
  env: Env
): Promise<IntentResult> {
  const apiKey = readEnvValue(env, "ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY for intent classification.");

  const baseUrl = readEnvValue(env, "ANTHROPIC_BASE_URL") || "https://api.anthropic.com";
  const response = await fetch(anthropicMessagesUrl(baseUrl), {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: resolveClaudeAgentModel(env),
      max_tokens: 360,
      temperature: 0,
      system: "You are a strict intent classifier. Return JSON only.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildIntentClassifierPrompt(message, history) }]
        }
      ]
    })
  });

  const text = await response.text();
  let payload: { content?: Array<{ text?: string }>; error?: { message?: string } } | undefined;
  try {
    payload = text ? (JSON.parse(text) as { content?: Array<{ text?: string }>; error?: { message?: string } }) : undefined;
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    throw new Error(payload?.error?.message || text || `Anthropic intent classifier failed: HTTP ${response.status}`);
  }

  const answer = payload?.content?.map((block) => block.text || "").filter(Boolean).join("\n") || "";
  const parsed = extractJsonObjectFromAnswer(answer);
  if (!parsed) throw new Error("Anthropic intent classifier did not return JSON.");
  return normalizeIntentResult(parsed, "model");
}

async function classifyIntentWithModel(
  message: string,
  history: ConversationMessage[],
  env: Env
): Promise<IntentResult> {
  const errors: string[] = [];

  if (hasMakersCredentials(env)) {
    try {
      return await runMakersIntentClassifier(message, history, env);
    } catch (error) {
      errors.push(`makers: ${(error as Error).message}`);
    }
  }

  if (hasAnthropicCredentials(env)) {
    try {
      return await runAnthropicIntentClassifier(message, history, env);
    } catch (error) {
      errors.push(`anthropic: ${(error as Error).message}`);
    }
  }

  return defaultIntent(errors.length ? `intent model unavailable: ${errors.join("; ")}` : "intent model credentials missing");
}

function sanitizeModelAnswer(answer: string): string {
  return answer
    .replace(/我已读取\s*prompt\s*中注入的全部素材[^。；;]*[。；;]?/g, "")
    .replace(/当前目录无\s*data\/?\s*文件夹[^。；;]*[。；;]?/g, "")
    .replace(/直接基于已有素材生成[^。；;]*[。；;]?/g, "")
    .trim();
}

function modelSuccessPayload(
  base: Record<string, unknown>,
  answer: string,
  message: string,
  kb: KnowledgeBase,
  intent: IntentResult
): Record<string, unknown> {
  const sanitizedAnswer = sanitizeModelAnswer(answer);
  const payload: Record<string, unknown> = {
    ...base,
    intent,
    answer: sanitizedAnswer || answer
  };

  if (intent.type === "generate_topics" && intent.showResult && !answerHasTopicList(answer)) {
    payload.result = makeLocalTopicPlan(message, kb);
    payload.warning = "Model returned plain text; structured topics were recovered for the UI.";
  }

  return payload;
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
  history: ConversationMessage[],
  intent: IntentResult
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
        { role: "user", content: buildClaudePrompt(message, kb, history, false, intent) }
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
  enableSandboxTools = false,
  intent: IntentResult
): Promise<string> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const env = context.env ?? process.env;
  const candidateMcp = enableSandboxTools ? context.tools?.toClaudeMcpServer?.() : undefined;
  const allowedFileTools = resolveAllowedFileTools(candidateMcp);
  const edgeoneMcp = candidateMcp && allowedFileTools.length > 0 ? candidateMcp : undefined;
  const prompt = buildClaudePrompt(message, kb, history, Boolean(edgeoneMcp), intent);
  const cwd = edgeoneMcp ? await prepareSandboxDataFiles(kb) : process.cwd();
  const systemPrompt = edgeoneMcp ? `${SYSTEM_PROMPT}\n\n${SANDBOX_FILE_READ_INSTRUCTIONS}` : SYSTEM_PROMPT;

  const options: Record<string, unknown> = {
    model: resolveClaudeAgentModel(env),
    systemPrompt,
    cwd,
    maxTurns: edgeoneMcp ? 5 : 4,
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

  const env = context.env ?? process.env;
  const intent = await withSpan(
    context,
    "classify_intent",
    { "agent.step": "classify_intent" },
    async (span) => {
      const result = await classifyIntentWithModel(message, history, env);
      span.setAttributes?.({
        "intent.type": result.type,
        "intent.show_result": result.showResult,
        "intent.confidence": result.confidence,
        "intent.source": result.source,
        "intent.topic_index": result.topicIndex ?? 0,
        "intent.reason": result.reason.slice(0, 180)
      });
      return result;
    }
  );

  const forceLocal = body.local === true || body.useLocal === true;
  const enableSandboxTools = body.sandboxTools !== false;
  const needsTopicList = intent.type === "generate_topics" && intent.showResult;
  const needsSandboxTools = enableSandboxTools && needsTopicList;
  const modelStep = needsTopicList ? "generate_topics" : "answer_followup";
  const shouldUseClaudeAgent =
    !forceLocal && hasAnthropicCredentials(env) && (needsSandboxTools || !hasMakersCredentials(env));

  if (!forceLocal && hasMakersCredentials(env) && !shouldUseClaudeAgent) {
    try {
      const answer = await withSpan(
        context,
        modelStep,
        { "agent.step": modelStep, "agent.runtime": "makers-models" },
        async () => runMakersModel(message, kb, env, history, intent)
      );
      await withSpan(context, "persist_assistant_message", { "agent.step": "persist_assistant_message" }, async () => {
        await maybeAppendMessage(context, "assistant", answer);
      });
      return jsonResponse(
        modelSuccessPayload(
          {
            ok: true,
            route: "/topic",
            mode: "makers-models",
            model: resolveModelName(env),
            memory: memoryInfo(context, history),
            dataFiles: ["data/account.md", "data/rules.md", "data/hot-urls.json", "data/recent-articles.json"]
          },
          answer,
          message,
          kb,
          intent
        )
      );
    } catch (error) {
      const fallback = await withSpan(
        context,
        "generate_local_fallback",
        { "agent.step": "generate_local_fallback", "agent.runtime": "local" },
        async () => (needsTopicList ? makeLocalTopicPlan(message, kb) : makeLocalReplyForIntent(message, kb, history, intent))
      );
      return jsonResponse({
        ok: true,
        route: "/topic",
        mode: "local-fallback",
        intent,
        memory: memoryInfo(context, history),
        warning: `Makers Models failed, returned deterministic local ${needsTopicList ? "plan" : "follow-up"} instead: ${(error as Error).message}`,
        result: fallback
      });
    }
  }

  if (shouldUseClaudeAgent) {
    try {
      const answer = await withSpan(
        context,
        modelStep,
        { "agent.step": modelStep, "agent.runtime": "claude-agent-sdk" },
        async () => runClaudeAgent(message, kb, context, history, needsSandboxTools, intent)
      );
      await withSpan(context, "persist_assistant_message", { "agent.step": "persist_assistant_message" }, async () => {
        await maybeAppendMessage(context, "assistant", answer);
      });
      return jsonResponse(
        modelSuccessPayload(
          {
            ok: true,
            route: "/topic",
            mode: "claude-agent-sdk",
            model: resolveClaudeAgentModel(env),
            providerModel: resolveModelName(env),
            sandboxTools: needsSandboxTools,
            memory: memoryInfo(context, history),
            dataFiles: ["data/account.md", "data/rules.md", "data/hot-urls.json", "data/recent-articles.json"]
          },
          answer,
          message,
          kb,
          intent
        )
      );
    } catch (error) {
      const fallback = await withSpan(
        context,
        "generate_local_fallback",
        { "agent.step": "generate_local_fallback", "agent.runtime": "local" },
        async () => (needsTopicList ? makeLocalTopicPlan(message, kb) : makeLocalReplyForIntent(message, kb, history, intent))
      );
      return jsonResponse({
        ok: true,
        route: "/topic",
        mode: "local-fallback",
        intent,
        memory: memoryInfo(context, history),
        warning: `Claude Agent SDK failed, returned deterministic local ${needsTopicList ? "plan" : "follow-up"} instead: ${(error as Error).message}`,
        result: fallback
      });
    }
  }

  const result = await withSpan(
    context,
    needsTopicList ? "generate_local_topics" : "generate_local_followup",
    { "agent.step": needsTopicList ? "generate_local_topics" : "generate_local_followup", "agent.runtime": "local" },
    async () => (needsTopicList ? makeLocalTopicPlan(message, kb) : makeLocalReplyForIntent(message, kb, history, intent))
  );
  await withSpan(context, "persist_assistant_message", { "agent.step": "persist_assistant_message" }, async () => {
    await maybeAppendMessage(context, "assistant", JSON.stringify(result));
  });

  return jsonResponse({
    ok: true,
    route: "/topic",
    mode: "local",
    intent,
    note: forceLocal
      ? "已选择本地模式；意图识别仍会优先尝试可用模型，模型不可用时不会硬猜用户意图。"
      : "未检测到可用模型密钥，因此使用本地确定性逻辑；部署到 Makers 并配置模型密钥后会走 Claude Agent SDK。",
    memory: memoryInfo(context, history),
    result
  });
}

export default onRequest;
