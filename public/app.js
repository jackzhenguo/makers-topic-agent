const state = {
  materials: null,
  materialsSource: "",
  history: [],
  hotExpanded: false,
  topicsExpanded: false,
  mode: "model",
  lastRaw: null,
  parsed: null
};
const conversationKey = "makers-topic-agent.conversation-id";
const historyKey = "makers-topic-agent.history";
const conversationIdPattern = /^[0-9A-Za-z_.-]{6,36}$/;

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

function shortText(value, length = 84) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length)}...` : text;
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
  if (Array.isArray(outline)) return outline.filter(Boolean).map(String);
  return String(outline || "")
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

function saveHistoryEntry(entry) {
  state.history = [entry, ...state.history.filter((item) => item.id !== entry.id)].slice(0, 20);
  localStorage.setItem(historyKey, JSON.stringify(state.history));
  renderHistory();
}

function resultHeadline(parsed) {
  const recommended = parsed?.recommended;
  if (recommended && typeof recommended === "object" && recommended.title) return recommended.title;
  if (typeof recommended === "string" && recommended.trim()) return recommended.trim();
  return parsed?.topics?.[0]?.title || parsed?.summary || "已生成选题";
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
      renderResult(item.raw, { skipHistory: true });
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

function normalizeResponse(raw) {
  if (raw?.answer) {
    try {
      const parsed = extractJsonFromAnswer(raw.answer);
      const topics = parsed.topics || parsed.candidates || [];
      const recommended = parsed.recommended || parsed.recommendation || parsed.bestTopic || topics[0] || "";
      return {
        summary: parsed.summary || raw.answer,
        topics,
        recommended,
        missingData: parsed.missingData || ""
      };
    } catch {
      return {
        summary: raw.answer,
        topics: [],
        recommended: raw.answer,
        missingData: ""
      };
    }
  }

  const result = raw?.result || {};
  const topics = result.candidates || result.topics || [];
  return {
    summary: result.recommended?.title || topics[0]?.title || "本地模式已生成选题",
    topics,
    recommended: result.recommended || topics[0] || "",
    missingData: (result.nextDataActions || []).join("\n")
  };
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
  state.topicsExpanded = false;
  els.rawOutput.textContent = JSON.stringify(raw, null, 2);
  els.resultTitle.textContent = raw.mode === "local-fallback" ? "模型失败，已回退本地结果" : "已生成选题";
  els.requestStatus.textContent = `${raw.mode || "done"}${raw.model ? ` · ${raw.model}` : ""}`;

  renderRecommended();
  renderTopics();
  renderPreview();
  renderChat(els.promptInput.value.trim(), state.parsed, raw);

  if (!options.skipHistory) {
    saveHistoryEntry({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      message: els.promptInput.value.trim(),
      title: resultHeadline(state.parsed),
      raw
    });
  }
}

function renderChat(message, parsed, raw) {
  const topics = parsed?.topics || [];
  const recommendedTitle = resultHeadline(parsed);
  const mode = raw?.mode || "done";

  els.chatThread.innerHTML = `
    <div class="chat-message user">
      <div class="chat-role">You</div>
      <div class="chat-bubble">${escapeHtml(message || "生成今日公众号选题")}</div>
    </div>
    <div class="chat-message assistant">
      <div class="chat-role">Agent · ${escapeHtml(mode)}</div>
      <div class="chat-bubble">
        <h4>${escapeHtml(recommendedTitle)}</h4>
        <div>${escapeHtml(shortText(parsed?.summary || "", 220))}</div>
        ${
          topics.length
            ? `<ul>${topics
                .slice(0, 5)
                .map((topic, index) => `<li>${escapeHtml(`Topic ${index + 1}: ${topicTitle(topic, index)}`)}</li>`)
                .join("")}</ul>`
            : ""
        }
      </div>
    </div>
  `;
  els.chatThread.scrollTop = els.chatThread.scrollHeight;
}

function renderPendingChat(message) {
  els.chatThread.innerHTML = `
    <div class="chat-message user">
      <div class="chat-role">You</div>
      <div class="chat-bubble">${escapeHtml(message || "生成今日公众号选题")}</div>
    </div>
    <div class="chat-message assistant">
      <div class="chat-role">Agent</div>
      <div class="chat-bubble">正在读取今日热点、分析账号风格并生成选题...</div>
    </div>
  `;
  els.chatThread.scrollTop = els.chatThread.scrollHeight;
}

function renderRecommended() {
  const recommended = state.parsed?.recommended || "";
  const text =
    typeof recommended === "string"
      ? recommended
      : [recommended.title, recommended.angle || recommended.whyNow].filter(Boolean).join("。");
  els.recommendedCard.innerHTML = `
    <span class="tag">推荐首发</span>
    <h3>${escapeHtml(shortText(text, 140) || "未返回推荐")}</h3>
    ${state.parsed?.missingData ? `<p>${escapeHtml(shortText(state.parsed.missingData, 260))}</p>` : ""}
  `;
}

function topicTitle(topic, index) {
  return topic.title || topic.event || `选题 ${index + 1}`;
}

function renderTopics() {
  const topics = state.parsed?.topics || [];
  const visibleTopics = state.topicsExpanded ? topics : topics.slice(0, 3);
  els.topicGrid.innerHTML = "";

  if (!topics.length) {
    els.topicGrid.innerHTML = `<div class="empty-state">模型返回未解析成 topic 列表，可在原始返回里查看。</div>`;
    return;
  }

  visibleTopics.forEach((topic, index) => {
    const outline = splitOutline(topic.outline).slice(0, 5);
    const card = document.createElement("article");
    card.className = "topic-card";
    card.innerHTML = `
      <span class="tag">Topic ${index + 1}</span>
      <h3>${escapeHtml(topicTitle(topic, index))}</h3>
      <p>${escapeHtml(topic.angle || topic.whyNow || topic.summary || "")}</p>
      ${outline.length ? `<ul>${outline.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
      <div class="topic-meta">
        ${(topic.tags || []).slice(0, 4).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}
      </div>
    `;
    card.addEventListener("click", () => renderPreview(topic));
    els.topicGrid.appendChild(card);
  });

  if (topics.length > 3) {
    const wrapper = document.createElement("div");
    wrapper.className = "topic-toggle-wrap";
    wrapper.appendChild(toggleButton(state.topicsExpanded ? "收起选题" : `展开全部 ${topics.length} 个选题`, () => {
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
  const title = topic ? topicTitle(topic, 0) : "选题生成后显示标题";
  const summary = topic?.angle || topic?.whyNow || state.parsed?.summary || "这里会展示首推选题的切入角度、为什么现在写、以及文章结构。";
  const outline = splitOutline(topic?.outline);

  els.phonePreview.querySelector("h3").textContent = title;
  els.phonePreview.querySelector(".preview-summary").textContent = summary;
  els.previewOutline.innerHTML = outline.length
    ? outline.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
    : `<li>等待生成</li>`;
}

async function generate() {
  const message = els.promptInput.value.trim();
  els.generateBtn.disabled = true;
  els.requestStatus.textContent = state.mode === "model" ? "DeepSeek 生成中" : "Local 生成中";
  renderPendingChat(message);

  try {
    const res = await fetch("/topic", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Makers-Conversation-Id": getConversationId()
      },
      body: JSON.stringify({
        message,
        local: state.mode === "local",
        sandboxTools: state.mode === "model"
      })
    });
    const data = await res.json();
    renderResult(data);
  } catch (error) {
    els.requestStatus.textContent = "Error";
    els.rawOutput.textContent = error.message;
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
els.chatThread.innerHTML = `
  <div class="chat-message assistant">
    <div class="chat-role">Agent</div>
    <div class="chat-bubble">
      <h4>今天想追哪条 AI 热点？</h4>
      <div>我会结合左侧今日热点、最近文章和账号规则，生成适合公众号的选题方案。</div>
    </div>
  </div>
`;
loadMaterials().catch((error) => {
  els.materialLabel.textContent = "素材读取失败";
  els.rawOutput.textContent = error.message;
});

window.addEventListener("load", initIcons);
