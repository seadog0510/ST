// Prompt Forensics - SillyTavern 提示词诊断扩展
// 兼容性版本:不使用import,从全局对象访问酒馆API

(function() {
  'use strict';
  
  const EXT_ID = "prompt-forensics";
  const LOG_PREFIX = "[PromptForensics]";
  
  // === 状态 ===
  let lastCapture = null;
  let captureHistory = [];
  const MAX_HISTORY = 10;
  let eventSourceRef = null;
  let eventTypesRef = null;
  
  // === Token估算 ===
  function estimateTokens(text) {
    if (!text) return 0;
    const str = String(text);
    let chinese = 0, other = 0;
    for (const ch of str) {
      if (/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch)) chinese++;
      else other++;
    }
    return Math.ceil(chinese * 1.5 + other / 3.5);
  }
  
  // === 模块分类 ===
  function classifyChunk(msg) {
    const id = msg.identifier || "";
    const role = msg.role || "";
    
    if (id === "main") return { type: "main", label: "主提示词" };
    if (id === "nsfw") return { type: "nsfw", label: "NSFW提示" };
    if (id === "jailbreak") return { type: "jailbreak", label: "越狱提示" };
    if (id === "worldInfoBefore" || id === "worldInfoAfter") 
      return { type: "worldinfo", label: "世界书" };
    if (id === "personaDescription") return { type: "persona", label: "用户Persona" };
    if (id === "charDescription") return { type: "char_desc", label: "角色描述" };
    if (id === "charPersonality") return { type: "char_pers", label: "角色性格" };
    if (id === "scenario") return { type: "scenario", label: "场景" };
    if (id === "dialogueExamples") return { type: "examples", label: "对话示例" };
    if (id === "chatHistory") return { type: "history", label: "聊天历史" };
    
    if (role === "system" && id) return { type: "custom_sys", label: "自定义[" + id + "]" };
    
    if (msg.injection_depth !== undefined) 
      return { type: "depth", label: "Depth注入(D" + msg.injection_depth + ")" };
    
    if (role === "user") return { type: "user_msg", label: "用户消息" };
    if (role === "assistant") return { type: "assistant_msg", label: "AI回复" };
    if (role === "system") return { type: "system_msg", label: "系统消息" };
    
    return { type: "unknown", label: "未分类" };
  }
  
  const TYPE_COLORS = {
    main: "#c9b88c", nsfw: "#d97757", jailbreak: "#c44a4a",
    worldinfo: "#7a9ac4", persona: "#9a7ac4",
    char_desc: "#7ac49a", char_pers: "#7ac49a", scenario: "#c4a47a",
    examples: "#a4a4a4", history: "#7a7a8a",
    custom_sys: "#b8a878", depth: "#e08858",
    user_msg: "#a8a8b0", assistant_msg: "#888890", system_msg: "#666670",
    unknown: "#444448",
  };
  
  // === 找酒馆事件系统 ===
  function findEventSystem() {
    // 路径1: 全局window
    if (typeof window.eventSource !== 'undefined' && typeof window.event_types !== 'undefined') {
      return { es: window.eventSource, et: window.event_types, source: 'window' };
    }
    
    // 路径2: SillyTavern全局对象(新版)
    if (window.SillyTavern) {
      const ctx = typeof window.SillyTavern.getContext === 'function' 
        ? window.SillyTavern.getContext() : window.SillyTavern;
      if (ctx && ctx.eventSource && ctx.eventTypes) {
        return { es: ctx.eventSource, et: ctx.eventTypes, source: 'SillyTavern.getContext' };
      }
      if (ctx && ctx.eventSource && ctx.event_types) {
        return { es: ctx.eventSource, et: ctx.event_types, source: 'SillyTavern.getContext (event_types)' };
      }
    }
    
    return null;
  }
  
  // === 捕获事件挂载 ===
  function setupCapture() {
    const sys = findEventSystem();
    if (!sys) {
      console.warn(LOG_PREFIX, "未找到酒馆事件系统,稍后重试");
      return false;
    }
    
    eventSourceRef = sys.es;
    eventTypesRef = sys.et;
    console.log(LOG_PREFIX, "事件系统已挂载,来源:", sys.source);
    console.log(LOG_PREFIX, "可用事件类型:", Object.keys(eventTypesRef || {}).slice(0, 20));
    
    const tryOn = (eventName, handler) => {
      if (!eventName) return false;
      try {
        eventSourceRef.on(eventName, handler);
        console.log(LOG_PREFIX, "已监听:", eventName);
        return true;
      } catch (e) {
        console.warn(LOG_PREFIX, "监听失败:", eventName, e.message);
        return false;
      }
    };
    
    const evChatReady = eventTypesRef.CHAT_COMPLETION_PROMPT_READY 
      || eventTypesRef.chat_completion_prompt_ready
      || 'chat_completion_prompt_ready';
    tryOn(evChatReady, (data) => {
      try { captureChatCompletion(data); }
      catch (e) { console.error(LOG_PREFIX, "captureChatCompletion error:", e); }
    });
    
    const evTextReady = eventTypesRef.GENERATE_AFTER_COMBINE_PROMPTS
      || eventTypesRef.generate_after_combine_prompts
      || 'generate_after_combine_prompts';
    tryOn(evTextReady, (data) => {
      try { captureTextCompletion(data); }
      catch (e) { console.error(LOG_PREFIX, "captureTextCompletion error:", e); }
    });
    
    const evGenStart = eventTypesRef.GENERATION_STARTED || eventTypesRef.generation_started;
    if (evGenStart) {
      tryOn(evGenStart, () => {
        console.log(LOG_PREFIX, "检测到生成开始");
      });
    }
    
    return true;
  }
  
  function captureChatCompletion(data) {
    console.log(LOG_PREFIX, "捕获chat completion数据", data);
    const chat = (data && data.chat) || [];
    const dryRun = data && data.dryRun;
    if (dryRun) return;
    
    if (!Array.isArray(chat) || chat.length === 0) {
      console.warn(LOG_PREFIX, "chat数据为空");
      return;
    }
    
    const chunks = chat.map((msg, idx) => {
      const cls = classifyChunk(msg);
      const tokens = estimateTokens(msg.content);
      return {
        idx,
        role: msg.role || "?",
        identifier: msg.identifier || "",
        type: cls.type,
        label: cls.label,
        content: msg.content || "",
        tokens,
        color: TYPE_COLORS[cls.type] || TYPE_COLORS.unknown,
        injection_depth: msg.injection_depth,
      };
    });
    
    const totalTokens = chunks.reduce((s, c) => s + c.tokens, 0);
    
    const byType = {};
    for (const c of chunks) {
      if (!byType[c.type]) byType[c.type] = { 
        type: c.type, label: c.label, tokens: 0, count: 0, color: c.color 
      };
      byType[c.type].tokens += c.tokens;
      byType[c.type].count += 1;
    }
    
    lastCapture = {
      timestamp: new Date(),
      mode: "chat_completion",
      chunks,
      byType: Object.values(byType).sort((a, b) => b.tokens - a.tokens),
      totalTokens,
    };
    
    pushHistory(lastCapture);
    refreshPanel();
    flashFab();
  }
  
  function captureTextCompletion(data) {
    console.log(LOG_PREFIX, "捕获text completion数据");
    const prompt = typeof data === "string" ? data : ((data && data.prompt) || "");
    if (!prompt) return;
    const tokens = estimateTokens(prompt);
    
    lastCapture = {
      timestamp: new Date(),
      mode: "text_completion",
      chunks: [{
        idx: 0, role: "combined", identifier: "full_prompt",
        type: "unknown", label: "完整Prompt(text completion)",
        content: prompt, tokens, color: TYPE_COLORS.unknown,
      }],
      byType: [{ type: "unknown", label: "完整Prompt", tokens, count: 1, color: TYPE_COLORS.unknown }],
      totalTokens: tokens,
    };
    
    pushHistory(lastCapture);
    refreshPanel();
    flashFab();
  }
  
  function pushHistory(capture) {
    captureHistory.unshift(capture);
    if (captureHistory.length > MAX_HISTORY) captureHistory.length = MAX_HISTORY;
  }
  
  function flashFab() {
    const fab = document.getElementById("pf-fab");
    if (fab) {
      fab.classList.add("pf-fab-flash");
      setTimeout(() => fab.classList.remove("pf-fab-flash"), 1000);
    }
  }
  
  // === UI ===
  function injectUI() {
    if (document.getElementById("pf-fab")) {
      console.log(LOG_PREFIX, "UI已存在,跳过");
      return;
    }
    
    const fab = document.createElement("div");
    fab.id = "pf-fab";
    fab.title = "提示词诊断";
    fab.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5"/><circle cx="11" cy="11" r="2.5" fill="currentColor"/></svg>';
    fab.addEventListener("click", togglePanel);
    document.body.appendChild(fab);
    
    const panel = document.createElement("div");
    panel.id = "pf-panel";
    panel.classList.add("pf-hidden");
    panel.innerHTML = '<div class="pf-header"><div class="pf-title-block"><div class="pf-eyebrow">PROMPT · FORENSICS</div><div class="pf-title">提示词诊断</div></div><div class="pf-header-actions"><button class="pf-icon-btn" id="pf-btn-refresh" title="刷新"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg></button><button class="pf-icon-btn" id="pf-btn-close" title="关闭"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 6l12 12M6 18L18 6"/></svg></button></div></div><div class="pf-tabs"><div class="pf-tab pf-tab-active" data-tab="overview">概览</div><div class="pf-tab" data-tab="modules">分模块</div><div class="pf-tab" data-tab="raw">原始</div><div class="pf-tab" data-tab="history">历史</div><div class="pf-tab" data-tab="debug">调试</div></div><div class="pf-body" id="pf-body"></div>';
    document.body.appendChild(panel);
    
    document.getElementById("pf-btn-close").addEventListener("click", () => {
      panel.classList.add("pf-hidden");
    });
    document.getElementById("pf-btn-refresh").addEventListener("click", refreshPanel);
    panel.querySelectorAll(".pf-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        panel.querySelectorAll(".pf-tab").forEach(t => t.classList.remove("pf-tab-active"));
        tab.classList.add("pf-tab-active");
        renderTab(tab.dataset.tab);
      });
    });
    
    renderTab("overview");
    console.log(LOG_PREFIX, "UI已注入");
  }
  
  function togglePanel() {
    const panel = document.getElementById("pf-panel");
    if (!panel) return;
    panel.classList.toggle("pf-hidden");
    if (!panel.classList.contains("pf-hidden")) refreshPanel();
  }
  
  function refreshPanel() {
    const panel = document.getElementById("pf-panel");
    if (!panel || panel.classList.contains("pf-hidden")) return;
    const activeTab = panel.querySelector(".pf-tab-active") 
      ? panel.querySelector(".pf-tab-active").dataset.tab : "overview";
    renderTab(activeTab);
  }
  
  function renderTab(tabName) {
    const body = document.getElementById("pf-body");
    if (!body) return;
    
    if (tabName === "debug") { renderDebug(body); return; }
    
    if (!lastCapture && tabName !== "history") {
      const sysFound = !!eventSourceRef;
      body.innerHTML = '<div class="pf-empty"><div class="pf-empty-mark">—</div><div class="pf-empty-text">还没有捕获数据</div><div class="pf-empty-hint">' + (sysFound ? '发送一条消息后,这里会显示诊断结果' : '⚠ 事件系统未挂载,请查看「调试」标签') + '</div></div>';
      return;
    }
    
    switch (tabName) {
      case "overview": renderOverview(body); break;
      case "modules": renderModules(body); break;
      case "raw": renderRaw(body); break;
      case "history": renderHistory(body); break;
    }
  }
  
  function renderOverview(body) {
    const c = lastCapture;
    const time = c.timestamp.toLocaleTimeString("zh-CN", { hour12: false });
    const totalChunks = c.chunks.length;
    const maxTokens = Math.max.apply(null, c.byType.map(t => t.tokens));
    
    let typeRows = c.byType.map(t => {
      const pct = ((t.tokens / c.totalTokens) * 100).toFixed(1);
      const barWidth = (t.tokens / maxTokens) * 100;
      return '<div class="pf-type-row"><div class="pf-type-row-head"><div class="pf-type-name"><span class="pf-type-dot" style="background:' + t.color + '"></span>' + escapeHtml(t.label) + '<span class="pf-type-count">×' + t.count + '</span></div><div class="pf-type-stats"><span class="pf-type-tokens">' + t.tokens.toLocaleString() + '</span><span class="pf-type-pct">' + pct + '%</span></div></div><div class="pf-type-bar"><div class="pf-type-bar-fill" style="width:' + barWidth + '%;background:' + t.color + '"></div></div></div>';
    }).join("");
    
    body.innerHTML = '<div class="pf-overview"><div class="pf-stat-grid"><div class="pf-stat"><div class="pf-stat-label">捕获时间</div><div class="pf-stat-value pf-mono">' + time + '</div></div><div class="pf-stat"><div class="pf-stat-label">模式</div><div class="pf-stat-value pf-mono">' + (c.mode === "chat_completion" ? "Chat" : "Text") + '</div></div><div class="pf-stat pf-stat-feature"><div class="pf-stat-label">估算Token</div><div class="pf-stat-value pf-stat-big">' + c.totalTokens.toLocaleString() + '</div><div class="pf-stat-hint">' + totalChunks + ' 个数据块</div></div></div><div class="pf-section-title"><span>Token 分布</span><span class="pf-section-hint">按模块类型聚合</span></div><div class="pf-type-list">' + typeRows + '</div><div class="pf-note"><span class="pf-note-mark">注</span>Token数为估算值,仅供调试参考。真实token以模型tokenizer为准。</div></div>';
  }
  
  function renderModules(body) {
    const c = lastCapture;
    let chunksHtml = c.chunks.map((chunk, i) => {
      const escaped = escapeHtml(chunk.content);
      return '<div class="pf-chunk" data-idx="' + i + '"><div class="pf-chunk-head" data-toggle="' + i + '"><div class="pf-chunk-head-left"><span class="pf-chunk-dot" style="background:' + chunk.color + '"></span><span class="pf-chunk-label">' + escapeHtml(chunk.label) + '</span><span class="pf-chunk-role">' + chunk.role + '</span></div><div class="pf-chunk-head-right"><span class="pf-chunk-tokens">' + chunk.tokens.toLocaleString() + 't</span><button class="pf-chunk-copy" data-copy="' + i + '" title="复制"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="9" y="9" width="13" height="13" rx="1"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><svg class="pf-chunk-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 9l6 6 6-6"/></svg></div></div><div class="pf-chunk-body"><pre class="pf-chunk-content">' + escaped + '</pre></div></div>';
    }).join("");
    
    body.innerHTML = '<div class="pf-modules"><div class="pf-section-title"><span>模块明细</span><span class="pf-section-hint">' + c.chunks.length + ' 块 · 点击展开</span></div><div class="pf-chunk-list">' + chunksHtml + '</div></div>';
    
    body.querySelectorAll("[data-toggle]").forEach(el => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-copy]")) return;
        el.closest(".pf-chunk").classList.toggle("pf-chunk-open");
      });
    });
    body.querySelectorAll("[data-copy]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.copy);
        const text = (c.chunks[idx] && c.chunks[idx].content) || "";
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(() => {
            btn.classList.add("pf-copied");
            setTimeout(() => btn.classList.remove("pf-copied"), 1200);
          });
        }
      });
    });
  }
  
  function renderRaw(body) {
    const c = lastCapture;
    const json = JSON.stringify(c.chunks.map(ch => ({
      role: ch.role, identifier: ch.identifier, label: ch.label,
      tokens: ch.tokens, content: ch.content,
    })), null, 2);
    
    body.innerHTML = '<div class="pf-raw"><div class="pf-section-title"><span>原始数据</span><button class="pf-text-btn" id="pf-copy-raw">复制全部</button></div><pre class="pf-raw-content">' + escapeHtml(json) + '</pre></div>';
    
    const btn = document.getElementById("pf-copy-raw");
    if (btn) {
      btn.addEventListener("click", () => {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(json).then(() => {
            btn.textContent = "已复制";
            setTimeout(() => { btn.textContent = "复制全部"; }, 1200);
          });
        }
      });
    }
  }
  
  function renderHistory(body) {
    if (captureHistory.length === 0) {
      body.innerHTML = '<div class="pf-empty"><div class="pf-empty-mark">—</div><div class="pf-empty-text">还没有历史</div></div>';
      return;
    }
    
    let rows = captureHistory.map((c, i) => {
      const time = c.timestamp.toLocaleTimeString("zh-CN", { hour12: false });
      const date = c.timestamp.toLocaleDateString("zh-CN");
      return '<div class="pf-history-row" data-history="' + i + '"><div class="pf-history-time pf-mono"><div>' + time + '</div><div class="pf-history-date">' + date + '</div></div><div class="pf-history-info"><div class="pf-history-tokens">' + c.totalTokens.toLocaleString() + ' tokens</div><div class="pf-history-meta">' + c.chunks.length + ' 块 · ' + (c.mode === "chat_completion" ? "Chat" : "Text") + '</div></div><div class="pf-history-action">查看 →</div></div>';
    }).join("");
    
    body.innerHTML = '<div class="pf-history"><div class="pf-section-title"><span>捕获历史</span><span class="pf-section-hint">最多 ' + MAX_HISTORY + ' 条</span></div><div class="pf-history-list">' + rows + '</div></div>';
    
    body.querySelectorAll("[data-history]").forEach(row => {
      row.addEventListener("click", () => {
        const idx = parseInt(row.dataset.history);
        lastCapture = captureHistory[idx];
        document.querySelectorAll(".pf-tab").forEach(t => t.classList.remove("pf-tab-active"));
        document.querySelector('.pf-tab[data-tab="overview"]').classList.add("pf-tab-active");
        renderTab("overview");
      });
    });
  }
  
  function renderDebug(body) {
    const sys = findEventSystem();
    const eventNames = eventTypesRef ? Object.keys(eventTypesRef) : [];
    
    let html = '<div class="pf-debug"><div class="pf-section-title"><span>调试信息</span><button class="pf-text-btn" id="pf-debug-retry">重试挂载</button></div>';
    html += '<div class="pf-debug-block"><div class="pf-debug-label">事件系统状态</div><div class="pf-debug-value ' + (sys ? 'pf-debug-ok' : 'pf-debug-fail') + '">' + (sys ? '✓ 已挂载 (' + sys.source + ')' : '✗ 未找到') + '</div></div>';
    html += '<div class="pf-debug-block"><div class="pf-debug-label">window.eventSource</div><div class="pf-debug-value pf-mono">' + typeof window.eventSource + '</div></div>';
    html += '<div class="pf-debug-block"><div class="pf-debug-label">window.event_types</div><div class="pf-debug-value pf-mono">' + typeof window.event_types + '</div></div>';
    html += '<div class="pf-debug-block"><div class="pf-debug-label">window.SillyTavern</div><div class="pf-debug-value pf-mono">' + typeof window.SillyTavern + '</div></div>';
    html += '<div class="pf-debug-block"><div class="pf-debug-label">捕获次数</div><div class="pf-debug-value pf-mono">' + captureHistory.length + '</div></div>';
    
    if (eventNames.length > 0) {
      html += '<div class="pf-debug-block"><div class="pf-debug-label">可用事件 (前30个)</div><pre class="pf-debug-list">' + eventNames.slice(0, 30).join('\n') + '</pre></div>';
    }
    
    html += '<div class="pf-note"><span class="pf-note-mark">注</span>如果"事件系统状态"是✗,说明酒馆版本不兼容当前的检测方式,请把这个调试页截图发给开发者。如果状态是✓但没有捕获,试试发一条消息后回到"概览"标签。</div></div>';
    
    body.innerHTML = html;
    
    const retryBtn = document.getElementById("pf-debug-retry");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => {
        const ok = setupCapture();
        retryBtn.textContent = ok ? "已重新挂载" : "仍未找到";
        setTimeout(() => { retryBtn.textContent = "重试挂载"; refreshPanel(); }, 1500);
      });
    }
  }
  
  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  
  // === 启动 ===
  let initialized = false;
  let retryCount = 0;
  const MAX_RETRY = 30;
  
  function tryInit() {
    if (document.body && !document.getElementById("pf-fab")) {
      try {
        injectUI();
      } catch (e) {
        console.error(LOG_PREFIX, "UI注入失败:", e);
      }
    }
    
    const ok = setupCapture();
    
    if (ok) {
      if (!initialized) {
        initialized = true;
        console.log(LOG_PREFIX, "初始化完成");
      }
    } else {
      retryCount++;
      if (retryCount < MAX_RETRY) {
        setTimeout(tryInit, 1000);
      } else if (!initialized) {
        console.warn(LOG_PREFIX, "事件系统挂载超时,UI可用但无自动捕获。可在「调试」标签手动重试");
        initialized = true;
      }
    }
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInit);
  } else {
    setTimeout(tryInit, 100);
  }
  
  window.__promptForensics = {
    getCapture: () => lastCapture,
    getHistory: () => captureHistory,
    retrySetup: setupCapture,
    findSystem: findEventSystem,
  };
  
})();
  // 优先按identifier匹配
  if (id === "main") return { type: "main", label: "主提示词" };
  if (id === "nsfw") return { type: "nsfw", label: "NSFW提示" };
  if (id === "jailbreak") return { type: "jailbreak", label: "越狱提示" };
  if (id === "worldInfoBefore" || id === "worldInfoAfter") 
    return { type: "worldinfo", label: "世界书" };
  if (id === "personaDescription") return { type: "persona", label: "用户Persona" };
  if (id === "charDescription") return { type: "char_desc", label: "角色描述" };
  if (id === "charPersonality") return { type: "char_pers", label: "角色性格" };
  if (id === "scenario") return { type: "scenario", label: "场景" };
  if (id === "dialogueExamples") return { type: "examples", label: "对话示例" };
  if (id === "chatHistory") return { type: "history", label: "聊天历史" };
  
  // 自定义系统提示词条目(用户在预设里加的)
  if (role === "system" && id) return { type: "custom_sys", label: `自定义系统[${id}]` };
  
  // 注入的depth prompt
  if (msg.injection_depth !== undefined) 
    return { type: "depth", label: `Depth注入(D${msg.injection_depth})` };
  
  // 普通消息
  if (role === "user") return { type: "user_msg", label: "用户消息" };
  if (role === "assistant") return { type: "assistant_msg", label: "AI回复" };
  if (role === "system") return { type: "system_msg", label: "系统消息" };
  
  return { type: "unknown", label: "未分类" };
}

// 模块的视觉颜色
const TYPE_COLORS = {
  main: "#c9b88c",
  nsfw: "#d97757",
  jailbreak: "#c44a4a",
  worldinfo: "#7a9ac4",
  persona: "#9a7ac4",
  char_desc: "#7ac49a",
  char_pers: "#7ac49a",
  scenario: "#c4a47a",
  examples: "#a4a4a4",
  history: "#7a7a8a",
  custom_sys: "#b8a878",
  depth: "#e08858",
  user_msg: "#a8a8b0",
  assistant_msg: "#888890",
  system_msg: "#666670",
  unknown: "#444448",
};

// === 捕获逻辑 ===
// 监听酒馆的 generate prompts 事件
function setupCapture() {
  // 这个事件在chat completion模式下,prompts数组组合完成时触发
  if (event_types.CHAT_COMPLETION_PROMPT_READY) {
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (data) => {
      try {
        captureChatCompletion(data);
      } catch (e) {
        console.error("[PromptForensics] capture error:", e);
      }
    });
  }
  
  // text completion模式的事件(兜底)
  if (event_types.GENERATE_AFTER_COMBINE_PROMPTS) {
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, (data) => {
      try {
        captureTextCompletion(data);
      } catch (e) {
        console.error("[PromptForensics] capture error:", e);
      }
    });
  }
  
  // 监听世界书激活事件,记录哪些条目被触发
  if (event_types.WORLDINFO_FORCE_ACTIVATE || event_types.WORLD_INFO_ACTIVATED) {
    const evt = event_types.WORLD_INFO_ACTIVATED || event_types.WORLDINFO_FORCE_ACTIVATE;
    eventSource.on(evt, (entries) => {
      if (lastCapture) {
        lastCapture.activatedWorldInfo = Array.isArray(entries) ? entries : [];
      }
    });
  }
}

function captureChatCompletion(data) {
  const chat = data?.chat || [];
  const dryRun = data?.dryRun || false;
  if (dryRun) return; // 跳过预览生成
  
  const chunks = chat.map((msg, idx) => {
    const cls = classifyChunk(msg);
    const tokens = estimateTokens(msg.content);
    return {
      idx,
      role: msg.role || "?",
      identifier: msg.identifier || "",
      type: cls.type,
      label: cls.label,
      content: msg.content || "",
      tokens,
      color: TYPE_COLORS[cls.type] || TYPE_COLORS.unknown,
      injection_depth: msg.injection_depth,
    };
  });
  
  const totalTokens = chunks.reduce((s, c) => s + c.tokens, 0);
  
  // 按type聚合统计
  const byType = {};
  for (const c of chunks) {
    if (!byType[c.type]) byType[c.type] = { 
      type: c.type, label: c.label, tokens: 0, count: 0, color: c.color 
    };
    byType[c.type].tokens += c.tokens;
    byType[c.type].count += 1;
  }
  
  lastCapture = {
    timestamp: new Date(),
    mode: "chat_completion",
    chunks,
    byType: Object.values(byType).sort((a, b) => b.tokens - a.tokens),
    totalTokens,
    activatedWorldInfo: [],
  };
  
  pushHistory(lastCapture);
  refreshPanel();
}

function captureTextCompletion(data) {
  // text completion模式下data是单一字符串prompt
  const prompt = typeof data === "string" ? data : (data?.prompt || "");
  const tokens = estimateTokens(prompt);
  
  lastCapture = {
    timestamp: new Date(),
    mode: "text_completion",
    chunks: [{
      idx: 0,
      role: "combined",
      identifier: "full_prompt",
      type: "unknown",
      label: "完整Prompt(text completion模式)",
      content: prompt,
      tokens,
      color: TYPE_COLORS.unknown,
    }],
    byType: [{ type: "unknown", label: "完整Prompt", tokens, count: 1, color: TYPE_COLORS.unknown }],
    totalTokens: tokens,
    activatedWorldInfo: [],
  };
  
  pushHistory(lastCapture);
  refreshPanel();
}

function pushHistory(capture) {
  captureHistory.unshift(capture);
  if (captureHistory.length > MAX_HISTORY) {
    captureHistory.length = MAX_HISTORY;
  }
}

// === UI ===
function injectUI() {
  // 浮动按钮
  const fab = document.createElement("div");
  fab.id = "pf-fab";
  fab.title = "提示词诊断";
  fab.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <circle cx="11" cy="11" r="7"/>
    <path d="M21 21l-4.5-4.5"/>
    <circle cx="11" cy="11" r="2.5" fill="currentColor"/>
  </svg>`;
  fab.addEventListener("click", togglePanel);
  document.body.appendChild(fab);
  
  // 主面板
  const panel = document.createElement("div");
  panel.id = "pf-panel";
  panel.classList.add("pf-hidden");
  panel.innerHTML = `
    <div class="pf-header">
      <div class="pf-title-block">
        <div class="pf-eyebrow">PROMPT · FORENSICS</div>
        <div class="pf-title">提示词诊断</div>
      </div>
      <div class="pf-header-actions">
        <button class="pf-icon-btn" id="pf-btn-refresh" title="等待下一次发送">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
            <path d="M21 3v5h-5"/>
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
            <path d="M3 21v-5h5"/>
          </svg>
        </button>
        <button class="pf-icon-btn" id="pf-btn-close" title="关闭">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M6 6l12 12M6 18L18 6"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="pf-tabs">
      <div class="pf-tab pf-tab-active" data-tab="overview">概览</div>
      <div class="pf-tab" data-tab="modules">分模块</div>
      <div class="pf-tab" data-tab="raw">原始数据</div>
      <div class="pf-tab" data-tab="history">历史</div>
    </div>
    <div class="pf-body" id="pf-body">
      <div class="pf-empty">
        <div class="pf-empty-mark">—</div>
        <div class="pf-empty-text">还没有捕获数据</div>
        <div class="pf-empty-hint">发送一条消息后,这里会显示诊断结果</div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);
  
  // 事件绑定
  document.getElementById("pf-btn-close").addEventListener("click", () => {
    panel.classList.add("pf-hidden");
  });
  document.getElementById("pf-btn-refresh").addEventListener("click", refreshPanel);
  panel.querySelectorAll(".pf-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      panel.querySelectorAll(".pf-tab").forEach(t => t.classList.remove("pf-tab-active"));
      tab.classList.add("pf-tab-active");
      renderTab(tab.dataset.tab);
    });
  });
}

function togglePanel() {
  const panel = document.getElementById("pf-panel");
  if (!panel) return;
  panel.classList.toggle("pf-hidden");
  if (!panel.classList.contains("pf-hidden")) refreshPanel();
}

function refreshPanel() {
  const panel = document.getElementById("pf-panel");
  if (!panel || panel.classList.contains("pf-hidden")) return;
  const activeTab = panel.querySelector(".pf-tab-active")?.dataset?.tab || "overview";
  renderTab(activeTab);
}

function renderTab(tabName) {
  const body = document.getElementById("pf-body");
  if (!body) return;
  
  if (!lastCapture && tabName !== "history") {
    body.innerHTML = `
      <div class="pf-empty">
        <div class="pf-empty-mark">—</div>
        <div class="pf-empty-text">还没有捕获数据</div>
        <div class="pf-empty-hint">发送一条消息后,这里会显示诊断结果</div>
      </div>
    `;
    return;
  }
  
  switch (tabName) {
    case "overview": renderOverview(body); break;
    case "modules": renderModules(body); break;
    case "raw": renderRaw(body); break;
    case "history": renderHistory(body); break;
  }
}

function renderOverview(body) {
  const c = lastCapture;
  const time = c.timestamp.toLocaleTimeString("zh-CN", { hour12: false });
  const totalChunks = c.chunks.length;
  
  // 算每个type的占比
  const maxTokens = Math.max(...c.byType.map(t => t.tokens));
  
  let typeRows = c.byType.map(t => {
    const pct = ((t.tokens / c.totalTokens) * 100).toFixed(1);
    const barWidth = (t.tokens / maxTokens) * 100;
    return `
      <div class="pf-type-row">
        <div class="pf-type-row-head">
          <div class="pf-type-name">
            <span class="pf-type-dot" style="background:${t.color}"></span>
            ${escapeHtml(t.label)}
            <span class="pf-type-count">×${t.count}</span>
          </div>
          <div class="pf-type-stats">
            <span class="pf-type-tokens">${t.tokens.toLocaleString()}</span>
            <span class="pf-type-pct">${pct}%</span>
          </div>
        </div>
        <div class="pf-type-bar">
          <div class="pf-type-bar-fill" style="width:${barWidth}%;background:${t.color}"></div>
        </div>
      </div>
    `;
  }).join("");
  
  body.innerHTML = `
    <div class="pf-overview">
      <div class="pf-stat-grid">
        <div class="pf-stat">
          <div class="pf-stat-label">捕获时间</div>
          <div class="pf-stat-value pf-mono">${time}</div>
        </div>
        <div class="pf-stat">
          <div class="pf-stat-label">模式</div>
          <div class="pf-stat-value pf-mono">${c.mode === "chat_completion" ? "Chat" : "Text"}</div>
        </div>
        <div class="pf-stat pf-stat-feature">
          <div class="pf-stat-label">估算Token</div>
          <div class="pf-stat-value pf-stat-big">${c.totalTokens.toLocaleString()}</div>
          <div class="pf-stat-hint">${totalChunks} 个数据块</div>
        </div>
      </div>
      
      <div class="pf-section-title">
        <span>Token 分布</span>
        <span class="pf-section-hint">按模块类型聚合</span>
      </div>
      <div class="pf-type-list">
        ${typeRows}
      </div>
      
      <div class="pf-note">
        <span class="pf-note-mark">注</span>
        Token数为估算值(中文≈1.5×字符数,英文≈词数×1.3),仅供调试参考。真实token数以模型tokenizer为准。
      </div>
    </div>
  `;
}

function renderModules(body) {
  const c = lastCapture;
  
  let chunksHtml = c.chunks.map((chunk, i) => {
    const preview = chunk.content.slice(0, 200);
    const hasMore = chunk.content.length > 200;
    const escaped = escapeHtml(chunk.content);
    return `
      <div class="pf-chunk" data-idx="${i}">
        <div class="pf-chunk-head" data-toggle="${i}">
          <div class="pf-chunk-head-left">
            <span class="pf-chunk-dot" style="background:${chunk.color}"></span>
            <span class="pf-chunk-label">${escapeHtml(chunk.label)}</span>
            <span class="pf-chunk-role">${chunk.role}</span>
          </div>
          <div class="pf-chunk-head-right">
            <span class="pf-chunk-tokens">${chunk.tokens.toLocaleString()}t</span>
            <button class="pf-chunk-copy" data-copy="${i}" title="复制">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="9" y="9" width="13" height="13" rx="1"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
            <svg class="pf-chunk-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M6 9l6 6 6-6"/>
            </svg>
          </div>
        </div>
        <div class="pf-chunk-body pf-chunk-collapsed">
          <pre class="pf-chunk-content">${escaped}</pre>
        </div>
      </div>
    `;
  }).join("");
  
  body.innerHTML = `
    <div class="pf-modules">
      <div class="pf-section-title">
        <span>模块明细</span>
        <span class="pf-section-hint">按发送顺序 · ${c.chunks.length} 块 · 点击展开</span>
      </div>
      <div class="pf-chunk-list">
        ${chunksHtml}
      </div>
    </div>
  `;
  
  // 绑定折叠/复制
  body.querySelectorAll("[data-toggle]").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-copy]")) return;
      const chunk = el.closest(".pf-chunk");
      chunk.classList.toggle("pf-chunk-open");
    });
  });
  body.querySelectorAll("[data-copy]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.copy);
      const text = c.chunks[idx]?.content || "";
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add("pf-copied");
        setTimeout(() => btn.classList.remove("pf-copied"), 1200);
      });
    });
  });
}

function renderRaw(body) {
  const c = lastCapture;
  const json = JSON.stringify(c.chunks.map(ch => ({
    role: ch.role,
    identifier: ch.identifier,
    label: ch.label,
    tokens: ch.tokens,
    content: ch.content,
  })), null, 2);
  
  body.innerHTML = `
    <div class="pf-raw">
      <div class="pf-section-title">
        <span>原始数据</span>
        <button class="pf-text-btn" id="pf-copy-raw">复制全部</button>
      </div>
      <pre class="pf-raw-content">${escapeHtml(json)}</pre>
    </div>
  `;
  
  document.getElementById("pf-copy-raw")?.addEventListener("click", (e) => {
    navigator.clipboard.writeText(json).then(() => {
      e.target.textContent = "已复制";
      setTimeout(() => { e.target.textContent = "复制全部"; }, 1200);
    });
  });
}

function renderHistory(body) {
  if (captureHistory.length === 0) {
    body.innerHTML = `
      <div class="pf-empty">
        <div class="pf-empty-mark">—</div>
        <div class="pf-empty-text">还没有历史</div>
      </div>
    `;
    return;
  }
  
  let rows = captureHistory.map((c, i) => {
    const time = c.timestamp.toLocaleTimeString("zh-CN", { hour12: false });
    const date = c.timestamp.toLocaleDateString("zh-CN");
    return `
      <div class="pf-history-row" data-history="${i}">
        <div class="pf-history-time pf-mono">
          <div>${time}</div>
          <div class="pf-history-date">${date}</div>
        </div>
        <div class="pf-history-info">
          <div class="pf-history-tokens">${c.totalTokens.toLocaleString()} tokens</div>
          <div class="pf-history-meta">${c.chunks.length} 块 · ${c.mode === "chat_completion" ? "Chat" : "Text"}模式</div>
        </div>
        <div class="pf-history-action">查看 →</div>
      </div>
    `;
  }).join("");
  
  body.innerHTML = `
    <div class="pf-history">
      <div class="pf-section-title">
        <span>捕获历史</span>
        <span class="pf-section-hint">最多保留 ${MAX_HISTORY} 条</span>
      </div>
      <div class="pf-history-list">
        ${rows}
      </div>
    </div>
  `;
  
  body.querySelectorAll("[data-history]").forEach(row => {
    row.addEventListener("click", () => {
      const idx = parseInt(row.dataset.history);
      lastCapture = captureHistory[idx];
      // 切回概览
      document.querySelectorAll(".pf-tab").forEach(t => t.classList.remove("pf-tab-active"));
      document.querySelector('.pf-tab[data-tab="overview"]').classList.add("pf-tab-active");
      renderTab("overview");
    });
  });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// === 启动 ===
jQuery(async () => {
  // 等待主程序就绪
  if (!extension_settings[EXT_ID]) {
    extension_settings[EXT_ID] = { enabled: true };
  }
  
  injectUI();
  setupCapture();
  
  console.log("[PromptForensics] loaded");
});
