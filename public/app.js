const state = {
  materials: null,
  mode: "model",
  lastRaw: null,
  parsed: null
};
const conversationKey = "makers-topic-agent.conversation-id";
const conversationIdPattern = /^[0-9A-Za-z_.-]{6,36}$/;

const els = {
  modeLabel: document.querySelector("#modeLabel"),
  materialLabel: document.querySelector("#materialLabel"),
  hotCount: document.querySelector("#hotCount"),
  articleCount: document.querySelector("#articleCount"),
  hotList: document.querySelector("#hotList"),
  articleList: document.querySelector("#articleList"),
  refreshBtn: document.querySelector("#refreshBtn"),
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

function sourceItem(title, detail) {
  const div = document.createElement("div");
  div.className = "source-item";
  div.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail || "")}</span>`;
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
      return {
        summary: parsed.summary || raw.answer,
        topics: parsed.topics || [],
        recommended: parsed.recommended || "",
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
  return {
    summary: result.recommended?.title || "本地模式已生成选题",
    topics: result.candidates || [],
    recommended: result.recommended?.title || "",
    missingData: (result.nextDataActions || []).join("\n")
  };
}

async function loadMaterials() {
  els.materialLabel.textContent = "读取素材中";
  const res = await fetch("/api/materials");
  if (res.ok) {
    state.materials = await res.json();
  } else {
    const [account, rules, hotUrls, recentArticles] = await Promise.all([
      fetch("/data/account.md").then((r) => r.text()),
      fetch("/data/rules.md").then((r) => r.text()),
      fetch("/data/hot-urls.json").then((r) => r.json()),
      fetch("/data/recent-articles.json").then((r) => r.json())
    ]);
    state.materials = { account, rules, hotUrls, recentArticles };
  }
  renderMaterials();
}

function renderMaterials() {
  const hotUrls = state.materials?.hotUrls || [];
  const articles = state.materials?.recentArticles || [];
  els.hotCount.textContent = hotUrls.length;
  els.articleCount.textContent = articles.length;
  els.materialLabel.textContent = `${hotUrls.length} 热点 · ${articles.length} 文章`;
  els.hotList.innerHTML = "";
  els.articleList.innerHTML = "";

  hotUrls.forEach((item) => els.hotList.appendChild(sourceItem(item.title, shortText(item.note, 76))));
  articles.forEach((item) => els.articleList.appendChild(sourceItem(item.title, shortText(item.summary, 76))));
}

function renderResult(raw) {
  state.lastRaw = raw;
  state.parsed = normalizeResponse(raw);
  els.rawOutput.textContent = JSON.stringify(raw, null, 2);
  els.resultTitle.textContent = raw.mode === "local-fallback" ? "模型失败，已回退本地结果" : "已生成选题";
  els.requestStatus.textContent = `${raw.mode || "done"}${raw.model ? ` · ${raw.model}` : ""}`;

  renderRecommended();
  renderTopics();
  renderPreview();
}

function renderRecommended() {
  const recommended = state.parsed?.recommended || "";
  const text = typeof recommended === "string" ? recommended : JSON.stringify(recommended);
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
  els.topicGrid.innerHTML = "";

  if (!topics.length) {
    els.topicGrid.innerHTML = `<div class="empty-state">模型返回未解析成 topic 列表，可在原始返回里查看。</div>`;
    return;
  }

  topics.forEach((topic, index) => {
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

  try {
    const res = await fetch("/topic", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Makers-Conversation-Id": getConversationId()
      },
      body: JSON.stringify({ message, local: state.mode === "local" })
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
loadMaterials().catch((error) => {
  els.materialLabel.textContent = "素材读取失败";
  els.rawOutput.textContent = error.message;
});

window.addEventListener("load", initIcons);
