const state = {
  materials: null,
  materialsSource: "",
  history: [],
  messages: [],
  hotExpanded: false,
  topicsExpanded: false,
  expandedTopics: new Set(),
  expandedMessages: new Set(),
  mode: "model",
  lastRaw: null,
  parsed: null
};
const conversationKey = "makers-topic-agent.conversation-id.v2";
const historyKey = "makers-topic-agent.history";
const messagesKey = "makers-topic-agent.messages.v2";
const conversationIdPattern = /^[0-9A-Za-z_.-]{6,36}$/;
const topicPreviewCount = 2;
const defaultPrompt = "结合最近三篇文章和今日 AI 热点，生成 5 个适合公众号的高点击选题，避免和最近文章重复。";

const els = {
  modeLabel: document.querySelector("#modeLabel"),
  materialLabel: document.querySelector("#materialLabel"),
  hotCount: document.querySelector("#hotCount"),
  articleCount: document.querySelector("#articleCount"),
  hotList: document.querySelector("#hotList"),
  articleList: document.querySelector("#articleList"),
  historyCount: document.querySelector("#historyCount"),
  historyList: document.querySelector("#historyList"),
  refreshBtn: document.querySelector("#refreshBtn"),
  chatThread: document.querySelector("#chatThread"),
  promptInput: document.querySelector("#promptInput"),
  modelModeBtn: document.querySelector("#modelModeBtn"),
  localModeBtn: document.querySelector("#localModeBtn"),
  runtimeHint: document.querySelector("#runtimeHint"),
  generateBtn: document.querySelector("#generateBtn"),
  copyJsonBtn: document.querySelector("#copyJsonBtn"),
  downloadBtn: document.querySelector("#downloadBtn"),
  copyPreviewBtn: document.querySelector("#copyPreviewBtn"),
  resultBlock: document.querySelector("#resultBlock"),
  requestStatus: document.querySelector("#requestStatus"),
  resultTitle: document.querySelector("#resultTitle"),
  recommendedCard: document.querySelector("#recommendedCard"),
  topicGrid: document.querySelector("#topicGrid"),
  phonePreview: document.querySelector("#phonePreview"),
  previewOutline: document.querySelector("#previewOutline"),
  rawOutput: document.querySelector("#rawOutput")
};

function initIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function setMode(mode) {
  state.mode = mode;
  els.modelModeBtn.classList.toggle("active", mode === "model");
  els.localModeBtn.classList.toggle("active", mode === "local");
  els.modeLabel.textContent = mode === "model" ? "DeepSeek" : "Local";
  els.runtimeHint.textContent = mode === "model" ? "真实模型可能需要 30-120 秒" : "本地模式即时返回";
}

function readableText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(readableText).filter(Boolean).join(" ");

  if (typeof value === "object") {
    const objectValue = value;
    const preferred = [
      objectValue.title,
      objectValue.angle,
      objectValue.whyNow,
      objectValue.summary,
      objectValue.reason,
      objectValue.recommendation,
      objectValue.reply,
      objectValue.content,
      objectValue.text
    ]
      .map(readableText)
      .filter(Boolean);

    if (preferred.length) return preferred.join("。");

    return Object.entries(objectValue)
      .map(([key, item]) => {
        const text = readableText(item);
        return text ? `${key}: ${text}` : "";
      })
      .filter(Boolean)
      .join(" ");
  }

  return String(value);
}

function shortText(value, length = 84) {
  const text = readableText(value).replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

function cleanDisplayText(value) {
  return readableText(value)
    .replace(/\\n/g, " ")
    .replace(/\\t/g, " ")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\b(?:bash|shell|sh|powershell|json|typescript|javascript)\s+(?=[a-z0-9_-]+\s)/gi, "")
    .replace(/#{1,6}\s*/g, "")
    .replace(/\*\*/g, "")
    .replace(/\b(message|gaps):\s*/gi, "")
    .replace(/我已读取\s*prompt\s*中注入的全部素材[^。；;]*[。；;]?/g, "")
    .replace(/当前目录无\s*data\/?\s*文件夹[^。；;]*[。；;]?/g, "")
    .replace(/直接基于已有素材生成[^。；;]*[。；;]?/g, "")
    .replace(/以下是为公众号[^：:]*[：:]/g, "")
    .replace(/好的，我已经尽力通过文件工具读取[^。]*。?/g, "")
    .replace(/但当前沙箱中 data 目录不存在[^。]*。?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shortDisplayText(value, length = 84) {
  const text = cleanDisplayText(value);
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

function topicAngle(topic) {
  return topic?.angle || topic?.whyNow || topic?.summary || topic?.fitWithAccount || "";
}

function recommendedTopicFromText(text, topics = []) {
  if (!text || !topics.length) return null;
  const topicMatch = String(text).match(/topics?\s*\[?\s*(\d+)\s*\]?|Topic\s*(\d+)/i);
  if (!topicMatch) return topics[0];

  const rawIndex = Number(topicMatch[1] || topicMatch[2]);
  const index = String(text).includes("[") ? rawIndex : rawIndex - 1;
  return topics[index] || topics[0];
}

function recommendedTitle(parsed) {
  const recommended = parsed?.recommended;
  if (recommended && typeof recommended === "object") {
    return recommended.title || parsed?.topics?.[0]?.title || "已生成选题";
  }

  if (typeof recommended === "string" && recommended.trim()) {
    return recommendedTopicFromText(recommended, parsed?.topics)?.title || recommended;
  }
  return parsed?.topics?.[0]?.title || parsed?.summary || "已生成选题";
}

function recommendedAngle(parsed) {
  const recommended = parsed?.recommended;
  if (recommended && typeof recommended === "object") return topicAngle(recommended);
  if (typeof recommended === "string" && recommended.trim()) {
    return topicAngle(recommendedTopicFromText(recommended, parsed?.topics));
  }
  return topicAngle(parsed?.topics?.[0]) || parsed?.summary || parsed?.reply || "";
}

function hasTopics(parsed) {
  return Array.isArray(parsed?.topics) && parsed.topics.length > 0;
}

function sourceLabel(value) {
  if (!value) return "素材库";
  try {
    const url = new URL(value);
    if (url.hostname === "zglg.work") return "今日 AI 快讯";
    return url.hostname;
  } catch {
    return value;
  }
}

function sourceItem(title, detail, meta = "") {
  const div = document.createElement("div");
  div.className = "source-item";
  div.innerHTML = `
    ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(detail || "")}</span>
  `;
  return div;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function splitOutline(outline) {
  if (Array.isArray(outline)) return outline.filter(Boolean).map(readableText);
  return readableText(outline)
    .split(/\n|\d+\.\s+/)
    .map((item) => item.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function getConversationId() {
  const existing = localStorage.getItem(conversationKey);
  if (existing && conversationIdPattern.test(existing)) return existing;

  const id = window.crypto?.randomUUID?.() || `chat-${Math.random().toString(36).slice(2, 14)}`;
  localStorage.setItem(conversationKey, id);
  return id;
}

function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(historyKey) || "[]");
    state.history = Array.isArray(parsed) ? parsed.slice(0, 20) : [];
  } catch {
    state.history = [];
  }
  renderHistory();
}

function loadChatMessages() {
  try {
    const parsed = JSON.parse(localStorage.getItem(messagesKey) || "[]");
    state.messages = Array.isArray(parsed) ? parsed.slice(-30) : [];
  } catch {
    state.messages = [];
  }

  if (!state.messages.length) {
    state.messages = [
      {
        id: "welcome",
        role: "assistant",
        title: "今天想追哪条 AI 热点？",
        content: "我会结合左侧今日热点、最近文章和账号规则，生成适合公众号的选题方案。生成后可以继续追问，比如“把 Topic 2 改得更适合开发者”。",
        mode: "ready"
      }
    ];
  }

  renderChatThread();
}

function saveChatMessages() {
  const messages = state.messages.filter((item) => item.id !== "welcome").slice(-30);
  localStorage.setItem(messagesKey, JSON.stringify(messages));
}

function appendChatMessage(message) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    ...message
  };
  state.messages.push(item);
  saveChatMessages();
  renderChatThread();
  return item.id;
}

function replaceChatMessage(id, nextMessage) {
  state.messages = state.messages.map((item) => (item.id === id ? { ...item, ...nextMessage } : item));
  saveChatMessages();
  renderChatThread();
}

function saveHistoryEntry(entry) {
  state.history = [entry, ...state.history.filter((item) => item.id !== entry.id)].slice(0, 20);
  localStorage.setItem(historyKey, JSON.stringify(state.history));
  renderHistory();
}

function resultHeadline(parsed) {
  return shortDisplayText(recommendedTitle(parsed), 72);
}

function renderHistory() {
  els.historyCount.textContent = state.history.length;
  els.historyList.innerHTML = "";

  if (!state.history.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无历史";
    els.historyList.appendChild(empty);
    return;
  }

  state.history.forEach((item) => {
    const btn = document.createElement("button");
    btn.className = "history-item";
    btn.type = "button";
    btn.innerHTML = `
      <strong>${escapeHtml(item.title || item.message || "历史请求")}</strong>
      <span>${escapeHtml(new Date(item.createdAt).toLocaleString())}</span>
    `;
    btn.addEventListener("click", () => {
      els.promptInput.value = item.message || els.promptInput.value;
      renderResult(item.raw, {
        skipHistory: true,
        updateChat: false,
        showResult: item.showResult ?? (item.raw?.intent?.showResult === true)
      });
    });
    els.historyList.appendChild(btn);
  });
}

function extractJsonFromAnswer(answer) {
  const text = String(answer || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  }
  throw new Error("No JSON object found in model answer.");
}

function normalizeResultPayload(result = {}) {
  const topics = result.candidates || result.topics || [];
  return {
    summary: result.summary || result.reply || result.recommended?.title || topics[0]?.title || "本地模式已生成选题",
    reply: result.reply || result.answer || "",
    topics,
    recommended: result.recommended || topics[0] || "",
    missingData: (result.nextDataActions || result.missingData || []).join?.("\n") || result.missingData || ""
  };
}

function inferTopicsFromAnswer(answer) {
  const text = String(answer || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\r/g, "")
    .trim();
  const sections = [];
  let current = null;

  text.split("\n").forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    const heading = line.match(/^(?:[-*]\s*)?(?:Topic|话题|选题)\s*(\d+|[一二三四五六七八九十])\s*[：:.\-、]\s*(.+)$/i);
    const numbered = line.match(/^(\d+)[.、]\s*(.+)$/);
    const match = heading || numbered;

    if (match) {
      if (current) sections.push(current);
      current = { title: match[2].replace(/\*\*/g, "").trim(), lines: [] };
      return;
    }

    if (current) current.lines.push(line.replace(/^[-*•]\s*/, ""));
  });

  if (current) sections.push(current);
  const topics = sections
    .filter((section) => section.title)
    .slice(0, 8)
    .map((section) => {
      const body = section.lines.join(" ");
      const outline = section.lines.filter((line) => /开场|背景|实操|步骤|结构|坑点|建议|总结|对比|案例/.test(line)).slice(0, 6);
      return {
        title: section.title,
        angle: shortDisplayText(body, 180),
        whyNow: "",
        outline: outline.length ? outline : section.lines.slice(0, 5),
        sourceUrl: ""
      };
    });

  if (topics.length < 2) return null;
  return {
    summary: shortDisplayText(text, 120),
    reply: "",
    topics,
    recommended: topics[0],
    missingData: ""
  };
}

function normalizeResponse(raw) {
  if (raw?.answer) {
    try {
      const parsed = extractJsonFromAnswer(raw.answer);
      const topics = parsed.topics || parsed.candidates || [];
      const recommended = parsed.recommended || parsed.recommendation || parsed.bestTopic || topics[0] || "";
      return {
        summary: parsed.summary || parsed.reply || raw.answer,
        reply: parsed.reply || parsed.response || parsed.message || "",
        topics,
        recommended,
        missingData: parsed.missingData || ""
      };
    } catch {
      if (raw?.result) return normalizeResultPayload(raw.result);
      const inferred = inferTopicsFromAnswer(raw.answer);
      if (inferred) return inferred;

      return {
        summary: raw.answer,
        reply: raw.answer,
        topics: [],
        recommended: "",
        missingData: ""
      };
    }
  }

  return normalizeResultPayload(raw?.result || {});
}

async function loadMaterials() {
  els.materialLabel.textContent = "读取素材中";
  try {
    const agentRes = await fetch("/topic", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Makers-Conversation-Id": getConversationId()
      },
      body: JSON.stringify({ action: "materials" })
    });
    if (agentRes.ok) {
      const payload = await agentRes.json();
      if (payload?.ok && payload.materials) {
        state.materials = payload.materials;
        state.materialsSource = payload.sourceUrl || "Agent";
        renderMaterials();
        return;
      }
    }
  } catch {
    // Fall back to local/static material loading below.
  }

  const res = await fetch("/api/materials");
  if (res.ok) {
    state.materials = await res.json();
    state.materialsSource = "Local";
  } else {
    const [account, rules, hotUrls, recentArticles] = await Promise.all([
      fetch("/data/account.md").then((r) => r.text()),
      fetch("/data/rules.md").then((r) => r.text()),
      fetch("/data/hot-urls.json").then((r) => r.json()),
      fetch("/data/recent-articles.json").then((r) => r.json())
    ]);
    state.materials = { account, rules, hotUrls, recentArticles };
    state.materialsSource = "Static";
  }
  renderMaterials();
}

function renderMaterials() {
  const hotUrls = state.materials?.hotUrls || [];
  const articles = state.materials?.recentArticles || [];
  const visibleHotUrls = state.hotExpanded ? hotUrls : hotUrls.slice(0, 3);
  els.hotCount.textContent = hotUrls.length;
  els.articleCount.textContent = articles.length;
  els.materialLabel.textContent = `${hotUrls.length} 热点 · ${articles.length} 文章 · ${sourceLabel(state.materialsSource)}`;
  els.hotList.innerHTML = "";
  els.articleList.innerHTML = "";

  visibleHotUrls.forEach((item) =>
    els.hotList.appendChild(sourceItem(item.title, shortText(item.note, 70), (item.tags || [])[0] || item.date || "热点"))
  );
  if (hotUrls.length > 3) {
    els.hotList.appendChild(toggleButton(state.hotExpanded ? "收起热点" : `展开 ${hotUrls.length - 3} 条热点`, () => {
      state.hotExpanded = !state.hotExpanded;
      renderMaterials();
    }));
  }
  articles.forEach((item) => els.articleList.appendChild(sourceItem(item.title, shortText(item.summary, 70), "文章")));
}

function toggleButton(label, onClick) {
  const button = document.createElement("button");
  button.className = "list-toggle";
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderResult(raw, options = {}) {
  state.lastRaw = raw;
  state.parsed = normalizeResponse(raw);
  const topicResult = hasTopics(state.parsed);
  const showResult = options.showResult ?? (raw?.intent?.showResult === true);
  state.topicsExpanded = false;
  state.expandedTopics = new Set();
  els.rawOutput.textContent = JSON.stringify(raw, null, 2);

  if (showResult) {
    els.resultBlock.hidden = false;
    els.resultTitle.textContent = raw.mode === "local-fallback" ? "模型失败，已回退本地结果" : topicResult ? "已生成选题" : "已生成回复";
    els.requestStatus.textContent = `${raw.mode || "done"}${raw.model ? ` · ${raw.model}` : ""}`;
    renderRecommended();
    renderTopics();
    renderPreview();
  } else {
    els.resultBlock.hidden = true;
  }

  if (options.pendingId) {
    replaceChatMessage(options.pendingId, assistantChatMessage(state.parsed, raw));
  }

  if (!options.skipHistory) {
    saveHistoryEntry({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      message: options.message || els.promptInput.value.trim(),
      title: showResult ? resultHeadline(state.parsed) : options.message || "继续追问",
      showResult,
      raw
    });
  }
}

function assistantSummary(parsed, raw) {
  const topics = parsed?.topics || [];
  const showResult = raw?.intent?.showResult === true;
  if (showResult && topics.length) {
    const summary = cleanDisplayText(parsed?.summary || "");
    if (summary) return summary;

    const title = recommendedTitle(parsed);
    const angle = recommendedAngle(parsed);
    return `已生成 ${topics.length} 个选题，推荐首发「${shortDisplayText(title, 48)}」。${shortDisplayText(angle, 110)}`;
  }

  return parsed?.reply || parsed?.summary || raw?.answer || "已生成回复。";
}

function assistantChatMessage(parsed, raw) {
  const topics = parsed?.topics || [];
  const topicResult = raw?.intent?.showResult === true && topics.length > 0;
  return {
    role: "assistant",
    title: topicResult ? resultHeadline(parsed) : "继续追问",
    content: assistantSummary(parsed, raw),
    topics: topicResult ? topics.slice(0, 3).map((topic, index) => `Topic ${index + 1}: ${topicTitle(topic, index)}`) : [],
    mode: raw?.mode || "done"
  };
}

function renderChatThread() {
  els.chatThread.innerHTML = state.messages
    .map((message, index) => {
      const messageId = message.id || `${message.role}-${index}`;
      const roleLabel = message.role === "user" ? "You" : `Agent${message.mode ? ` · ${message.mode}` : ""}`;
      const topics = Array.isArray(message.topics) ? message.topics : [];
      const fullContent = cleanDisplayText(message.content || "");
      const collapsedLength = message.role === "user" ? 300 : 260;
      const canExpand = fullContent.length > collapsedLength;
      const expanded = state.expandedMessages.has(messageId);
      const visibleContent = canExpand && !expanded ? `${fullContent.slice(0, collapsedLength)}...` : fullContent;
      return `
        <div class="chat-message ${message.role === "user" ? "user" : "assistant"}">
          <div class="chat-role">${escapeHtml(roleLabel)}</div>
          <div class="chat-bubble ${expanded ? "expanded" : ""}">
            ${message.title ? `<h4>${escapeHtml(shortDisplayText(message.title, 82))}</h4>` : ""}
            <div class="chat-text">${escapeHtml(visibleContent)}</div>
            ${topics.length ? `<ul>${topics.map((topic) => `<li>${escapeHtml(shortDisplayText(topic, 88))}</li>`).join("")}</ul>` : ""}
            ${canExpand ? `<button class="chat-expand-button" type="button" data-expand-message="${escapeHtml(messageId)}">${expanded ? "收起" : "展开全文"}</button>` : ""}
          </div>
        </div>
      `;
    })
    .join("");
  els.chatThread.querySelectorAll("[data-expand-message]").forEach((button) => {
    button.addEventListener("click", () => {
      const messageId = button.getAttribute("data-expand-message");
      if (!messageId) return;
      if (state.expandedMessages.has(messageId)) {
        state.expandedMessages.delete(messageId);
      } else {
        state.expandedMessages.add(messageId);
      }
      renderChatThread();
    });
  });
  els.chatThread.scrollTop = els.chatThread.scrollHeight;
}

function renderRecommended() {
  if (!hasTopics(state.parsed)) {
    const reply = state.parsed?.reply || state.parsed?.summary || "";
    els.recommendedCard.innerHTML = `
      <span class="tag">本轮回复</span>
      <h3>${escapeHtml(shortDisplayText(reply, 120) || "等待回复")}</h3>
    `;
    return;
  }

  const title = recommendedTitle(state.parsed);
  const angle = recommendedAngle(state.parsed);
  els.recommendedCard.innerHTML = `
    <span class="tag">推荐首发</span>
    <h3>${escapeHtml(shortDisplayText(title, 86) || "等待推荐")}</h3>
    ${angle ? `<p>${escapeHtml(shortDisplayText(angle, 132))}</p>` : ""}
  `;
}

function topicTitle(topic, index) {
  return topic.title || topic.event || `选题 ${index + 1}`;
}

function renderTopics() {
  const topics = state.parsed?.topics || [];
  const visibleTopics = state.topicsExpanded ? topics : topics.slice(0, topicPreviewCount);
  els.topicGrid.innerHTML = "";

  if (!topics.length) {
    els.topicGrid.innerHTML = `<div class="empty-state">${escapeHtml(shortDisplayText(state.parsed?.reply || state.parsed?.summary || "这轮是普通对话，没有新的 topic 列表。", 160))}</div>`;
    return;
  }

  visibleTopics.forEach((topic, index) => {
    const expanded = state.expandedTopics.has(index);
    const outline = expanded ? splitOutline(topic.outline).slice(0, 5) : [];
    const topicBody = topicAngle(topic);
    const card = document.createElement("article");
    card.className = `topic-card${expanded ? " expanded" : ""}`;
    card.tabIndex = 0;
    card.innerHTML = `
      <span class="tag">Topic ${index + 1}</span>
      <h3>${escapeHtml(shortDisplayText(topicTitle(topic, index), expanded ? 110 : 46))}</h3>
      <p>${escapeHtml(shortDisplayText(topicBody, expanded ? 300 : 72))}</p>
      ${outline.length ? `<ul>${outline.map((item) => `<li>${escapeHtml(shortDisplayText(item, 78))}</li>`).join("")}</ul>` : ""}
      <div class="topic-meta">
        ${(topic.tags || []).slice(0, 4).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}
      </div>
      <button class="topic-expand" type="button">${expanded ? "收起" : "展开"}</button>
    `;
    const toggleCard = () => {
      if (expanded) {
        state.expandedTopics.delete(index);
      } else {
        state.expandedTopics.add(index);
      }
      renderPreview(topic);
      renderTopics();
    };
    card.addEventListener("click", toggleCard);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleCard();
      }
    });
    els.topicGrid.appendChild(card);
  });

  if (topics.length > topicPreviewCount) {
    const wrapper = document.createElement("div");
    wrapper.className = "topic-toggle-wrap";
    wrapper.appendChild(toggleButton(state.topicsExpanded ? "只看前 2 个选题" : `显示全部 ${topics.length} 个选题`, () => {
      state.topicsExpanded = !state.topicsExpanded;
      renderTopics();
    }));
    els.topicGrid.appendChild(wrapper);
  }
}

function firstTopic() {
  return (state.parsed?.topics || [])[0] || null;
}

function renderPreview(topic = firstTopic()) {
  const title = topic ? topicTitle(topic, 0) : "本轮追问回复";
  const summary =
    topicAngle(topic) ||
    state.parsed?.reply ||
    state.parsed?.summary ||
    "这里会展示首推选题的切入角度、为什么现在写、以及文章结构。";
  const outline = splitOutline(topic?.outline).slice(0, 5);

  els.phonePreview.querySelector("h3").textContent = shortDisplayText(title, 54);
  els.phonePreview.querySelector(".preview-summary").textContent = shortDisplayText(summary, 118);
  els.previewOutline.innerHTML = outline.length
    ? outline.map((item) => `<li>${escapeHtml(shortDisplayText(item, 54))}</li>`).join("")
    : `<li>等待生成</li>`;
}

async function generate() {
  const typedMessage = els.promptInput.value.trim();
  const isOnlyWelcome = state.messages.length === 1 && state.messages[0]?.id === "welcome";
  const message = typedMessage || (isOnlyWelcome ? defaultPrompt : "");
  if (!message) {
    els.requestStatus.textContent = "请输入追问内容";
    els.promptInput.focus();
    return;
  }

  els.generateBtn.disabled = true;
  els.requestStatus.textContent = state.mode === "model" ? "DeepSeek 生成中" : "Local 生成中";
  if (isOnlyWelcome) state.messages = [];
  appendChatMessage({ role: "user", content: message });
  const pendingId = appendChatMessage({
    role: "assistant",
    content: "正在读取今日热点、分析账号风格，并结合当前对话生成回复...",
    mode: "working"
  });
  els.promptInput.value = "";

  try {
    const intentHint = isOnlyWelcome && !typedMessage ? "generate_topics" : undefined;
    const res = await fetch("/topic", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Makers-Conversation-Id": getConversationId()
      },
      body: JSON.stringify({
        message,
        intentHint,
        local: state.mode === "local",
        sandboxTools: state.mode === "model"
      })
    });
    const data = await res.json();
    renderResult(data, { message, pendingId });
  } catch (error) {
    els.requestStatus.textContent = "Error";
    els.rawOutput.textContent = error.message;
    replaceChatMessage(pendingId, {
      role: "assistant",
      title: "请求失败",
      content: error.message,
      mode: "error"
    });
  } finally {
    els.generateBtn.disabled = false;
  }
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

function previewText() {
  const title = els.phonePreview.querySelector("h3").textContent;
  const summary = els.phonePreview.querySelector(".preview-summary").textContent;
  const outline = Array.from(els.previewOutline.querySelectorAll("li")).map((li, index) => `${index + 1}. ${li.textContent}`);
  return [title, "", summary, "", ...outline].join("\n");
}

function downloadResult() {
  const blob = new Blob([JSON.stringify(state.lastRaw || {}, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `topic-agent-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

els.modelModeBtn.addEventListener("click", () => setMode("model"));
els.localModeBtn.addEventListener("click", () => setMode("local"));
els.generateBtn.addEventListener("click", generate);
els.refreshBtn.addEventListener("click", loadMaterials);
els.copyJsonBtn.addEventListener("click", () => copyText(JSON.stringify(state.lastRaw || {}, null, 2)));
els.copyPreviewBtn.addEventListener("click", () => copyText(previewText()));
els.downloadBtn.addEventListener("click", downloadResult);

setMode("model");
initIcons();
loadHistory();
loadChatMessages();
els.promptInput.placeholder = "继续追问，例如：把 Topic 2 改得更适合开发者，或者展开第一个选题的大纲。";
if (state.messages.some((item) => item.id !== "welcome")) {
  els.promptInput.value = "";
}
loadMaterials().catch((error) => {
  els.materialLabel.textContent = "素材读取失败";
  els.rawOutput.textContent = error.message;
});

window.addEventListener("load", initIcons);
