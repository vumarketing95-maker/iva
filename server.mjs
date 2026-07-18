import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { IVA_SYSTEM_PROMPT, DEFAULT_HISTORY } from "./iva_rules.mjs";

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "iva_verify_2026";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";
const PAGE_TOKENS_RAW = process.env.PAGE_TOKENS || "";
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v25.0";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const AGENTIC_REVIEW_ENABLED = process.env.AGENTIC_REVIEW_ENABLED !== "false";
const MIN_REPLY_DELAY_MS = Number(process.env.MIN_REPLY_DELAY_MS || 2500);
const MAX_REPLY_DELAY_MS = Number(process.env.MAX_REPLY_DELAY_MS || 6500);
const CHAT_LOG_DIR = process.env.CHAT_LOG_DIR || path.join(process.cwd(), "iva-chat-logs");
const HUMAN_LOCK_FILE = process.env.HUMAN_LOCK_FILE || path.join(process.cwd(), "iva-human-locks.json");
const REPORT_TOKEN = process.env.REPORT_TOKEN || VERIFY_TOKEN;

const conversations = new Map();
const customerStates = new Map();
const processedMessageIds = new Set();
const humanTakenOverConversations = loadHumanTakeovers();
const recentBotEchoes = new Map();
const conversationMemories = new Map();

function parsePageTokens(rawValue) {
  if (!rawValue) return {};
  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([pageId, token]) => [String(pageId).trim(), String(token).trim()])
        .filter(([pageId, token]) => pageId && token),
    );
  } catch (error) {
    console.error("Invalid PAGE_TOKENS JSON. Use format: {\"PAGE_ID\":\"PAGE_TOKEN\"}");
    return {};
  }
}

const PAGE_TOKENS = parsePageTokens(PAGE_TOKENS_RAW);

function loadHumanTakeovers() {
  try {
    if (!fs.existsSync(HUMAN_LOCK_FILE)) return new Set();
    const parsed = JSON.parse(fs.readFileSync(HUMAN_LOCK_FILE, "utf8"));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map(String).filter(Boolean));
  } catch (error) {
    console.error("Cannot load human takeover locks:", error.message);
    return new Set();
  }
}

function saveHumanTakeovers() {
  try {
    fs.writeFileSync(HUMAN_LOCK_FILE, JSON.stringify([...humanTakenOverConversations], null, 2));
  } catch (error) {
    console.error("Cannot save human takeover locks:", error.message);
  }
}

function tokenForPage(pageId = "") {
  const pageToken = pageId ? PAGE_TOKENS[String(pageId)] : "";
  return pageToken || PAGE_ACCESS_TOKEN;
}

function tokenSourceForPage(pageId = "") {
  if (pageId && PAGE_TOKENS[String(pageId)]) return "PAGE_TOKENS";
  if (PAGE_ACCESS_TOKEN) return "PAGE_ACCESS_TOKEN_FALLBACK";
  return "MISSING";
}

function conversationKey(pageId, senderId) {
  return `${pageId || "default"}:${senderId}`;
}

function markHumanTakeover(pageId, customerId, reason = "page echo", humanText = "") {
  if (!pageId || !customerId) return;
  const chatKey = conversationKey(pageId, customerId);
  humanTakenOverConversations.add(chatKey);
  saveHumanTakeovers();
  const state = getCustomerState(chatKey);
  state.humanTakeover = true;
  state.stage = "human_takeover";
  recordChatEvent("human_takeover", { pageId, chatKey, senderId: customerId, text: humanText, reason, state: stateSnapshot(state) });
  console.log("Human takeover locked", { chatKey, reason });
}

function lockConversation(pageId, customerId, reason = "conversation locked", customerText = "") {
  if (!pageId || !customerId) return;
  const chatKey = conversationKey(pageId, customerId);
  humanTakenOverConversations.add(chatKey);
  saveHumanTakeovers();
  const state = getCustomerState(chatKey);
  state.humanTakeover = true;
  state.stage = "conversation_locked";
  recordChatEvent("conversation_locked", { pageId, chatKey, senderId: customerId, text: customerText, reason, state: stateSnapshot(state) });
  console.log("Conversation locked", { chatKey, reason });
}

function lockChatKey(chatKey, reason = "conversation locked", customerText = "") {
  if (!chatKey) return;
  humanTakenOverConversations.add(chatKey);
  saveHumanTakeovers();
  const state = getCustomerState(chatKey);
  state.humanTakeover = true;
  state.stage = "conversation_locked";
  recordChatEvent("conversation_locked", { chatKey, text: customerText, reason, state: stateSnapshot(state) });
  console.log("Conversation locked", { chatKey, reason });
}

function isHumanTakenOver(chatKey) {
  if (humanTakenOverConversations.has(chatKey)) return true;
  const state = customerStates.get(chatKey);
  return Boolean(state?.humanTakeover);
}

function unlockConversation(pageId, customerId, reason = "manual start bot") {
  if (!pageId || !customerId) return;
  const chatKey = conversationKey(pageId, customerId);
  humanTakenOverConversations.delete(chatKey);
  saveHumanTakeovers();
  const state = getCustomerState(chatKey);
  state.humanTakeover = false;
  state.stage = "bot_reenabled";
  recordChatEvent("bot_reenabled", { pageId, chatKey, senderId: customerId, text: "", reason, state: stateSnapshot(state) });
  console.log("Bot re-enabled", { chatKey, reason });
}

function isKnownPageId(id = "") {
  const value = String(id || "").trim();
  if (!value) return false;
  if (Object.prototype.hasOwnProperty.call(PAGE_TOKENS, value)) return true;
  return value === process.env.PAGE_ID || value === process.env.PAGE_ID_PAGE_CU || value === process.env.PAGE_ID_PAGE_MOI;
}

function botEchoKey(pageId, customerId, text = "") {
  return `${conversationKey(pageId, customerId)}::${normalizeText(text).slice(0, 220)}`;
}

function rememberBotEcho(pageId, customerId, text = "") {
  if (!pageId || !customerId || !text) return;
  const key = botEchoKey(pageId, customerId, text);
  recentBotEchoes.set(key, Date.now());
  if (recentBotEchoes.size > 1000) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [echoKey, createdAt] of recentBotEchoes) {
      if (createdAt < cutoff) recentBotEchoes.delete(echoKey);
    }
  }
}

function isKnownBotEcho(pageId, customerId, text = "") {
  const key = botEchoKey(pageId, customerId, text);
  const createdAt = recentBotEchoes.get(key);
  if (!createdAt) return false;
  recentBotEchoes.delete(key);
  return Date.now() - createdAt < 10 * 60 * 1000;
}

function rememberConversationTurn(chatKey, role, text = "", meta = {}) {
  if (!chatKey) return;
  const history = conversationMemories.get(chatKey) || [];
  history.push({
    at: new Date().toISOString(),
    role,
    text: maskPrivateText(text || ""),
    reason: meta.reason || "",
    type: meta.type || "",
  });
  while (history.length > 40) history.shift();
  conversationMemories.set(chatKey, history);
}

function recentConversation(chatKey, limit = 15) {
  return (conversationMemories.get(chatKey) || []).slice(-limit);
}

function lastOutboundRole(chatKey) {
  const history = recentConversation(chatKey, 20).slice().reverse();
  const row = history.find((item) => item.role === "bot" || item.role === "human");
  return row?.role || "";
}

function hasHumanOutboundInMemory(chatKey) {
  return recentConversation(chatKey, 20).some((item) => item.role === "human");
}

const CLINIC = {
  address:
    "Dạ IVA có 2 cơ sở: 33N Hoàng Quốc Việt, Tân Mỹ và 94 Đường 56, Bình Trưng ạ.",
  branchAsk: "Mình qua chi nhánh 1 Hoàng Quốc Việt hay chi nhánh 2 Bình Trưng ạ?",
  addressAsk: "Mình qua chi nhánh 1 Hoàng Quốc Việt hay chi nhánh 2 Bình Trưng để em giữ lịch cho mình ạ?",
  price:
    "Sau khi khám bác sĩ sẽ trao đổi kỹ lộ trình và chi phí cho mình ạ. Đặt lịch online bên em đang có ưu đãi 499k/5 buổi trị liệu bấm huyệt.",
  priceClose: "Mình tiện qua hôm nay hay ngày mai ạ?",
  methods:
    "Bên em hỗ trợ bằng vật lý trị liệu, có kết hợp máy như kéo giãn cột sống, sóng từ trường, điện xung, siêu âm tuỳ tình trạng sau khi bác sĩ kiểm tra ạ.",
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function text(res, status, payload) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(payload);
}

function html(res, status, payload) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(payload);
}

function ensureChatLogDir() {
  try {
    fs.mkdirSync(CHAT_LOG_DIR, { recursive: true });
  } catch (error) {
    console.error("Cannot create chat log dir:", error.message);
  }
}

function chatLogFile(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return path.join(CHAT_LOG_DIR, `${day}.jsonl`);
}

function maskPrivateText(value = "") {
  return String(value || "").replace(/(\+?84|0)(\d[\s.-]?){8,10}\d/g, "[phone]");
}

function stateSnapshot(state = {}) {
  return {
    intent: state.customerIntent || "",
    stage: state.stage || "",
    group: state.leadGroup || "",
    temperature: state.temperature || "",
    pain: state.pain || "",
    primaryPain: state.primaryPain || "",
    disease: state.disease || "",
    duration: state.duration || "",
    trigger: state.trigger || "",
    radiation: state.radiation || "",
    askedPrice: Boolean(state.askedPrice),
    askedAddress: Boolean(state.askedAddress),
    priceSent: Boolean(state.priceSent),
    addressSent: Boolean(state.addressSent),
    bookingAsked: Boolean(state.bookingAsked),
    assessmentSent: Boolean(state.assessmentSent),
    humanTakeover: Boolean(state.humanTakeover),
  };
}

function recordChatEvent(type, payload = {}) {
  try {
    ensureChatLogDir();
    const row = {
      at: new Date().toISOString(),
      type,
      pageId: payload.pageId || "",
      chatKey: payload.chatKey || "",
      senderId: payload.senderId || "",
      text: maskPrivateText(payload.text || ""),
      reason: payload.reason || "",
      state: payload.state || null,
      decision: payload.decision || null,
      attemptedReply: payload.attemptedReply ? maskPrivateText(payload.attemptedReply) : "",
      quality: payload.quality || null,
    };
    if (row.chatKey) {
      const role =
        type === "customer" ? "customer" :
        type === "bot" ? "bot" :
        type === "human_takeover" ? "human" :
        "system";
      rememberConversationTurn(row.chatKey, role, row.text, { reason: row.reason, type });
    }
    fs.appendFileSync(chatLogFile(), `${JSON.stringify(row)}\n`, "utf8");
  } catch (error) {
    console.error("Cannot write chat log:", error.message);
  }
}

function readRecentChatRows(days = 7) {
  const rows = [];
  for (let i = 0; i < days; i += 1) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const file = chatLogFile(date);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(-3000)) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        // skip bad line
      }
    }
  }
  return rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function addCount(map, key = "khác") {
  const cleanKey = key || "khác";
  map.set(cleanKey, (map.get(cleanKey) || 0) + 1);
}

function topCounts(map, limit = 12) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function detectReportTopic(text = "") {
  if (isPriceQuestion(text)) return "hỏi giá/chi phí";
  if (isAddressQuestion(text)) return "hỏi địa chỉ";
  if (isBookingIntent(text)) return "hỏi lịch/đặt lịch";
  if (isOutcomeQuestion(text)) return "hỏi hiệu quả/liệu trình";
  if (isCostProcessQuestion(text)) return "hỏi phát sinh/ép mua";
  if (isCustomerCorrection(text)) return "khách sửa lại/bắt lỗi";
  const disease = detectDisease(text);
  if (disease) return `bệnh lý: ${disease}`;
  const pain = detectPain(text);
  if (pain) return `triệu chứng: ${pain}`;
  if (isPing(text)) return "chào/tư vấn chung";
  return "khác";
}

function botRiskFlags(row, previousBotByChat) {
  const flags = [];
  const textValue = normalizeText(row.text || "");
  const state = row.state || {};
  const lastBot = previousBotByChat.get(row.chatKey);
  if (lastBot && normalizeText(lastBot) === textValue) flags.push("lặp y nguyên");
  if (/\bban\b|quy khach|tinh trang cu the|vi tri nao|dau o dau/.test(textValue)) flags.push("ngôn từ/rập khuôn");
  if (state.pain === "lưng" && /(khop goi|co vai gay|te tay|xuong tay)/.test(textValue)) flags.push("sai vùng đau");
  if ((state.pain === "cổ tay" || state.pain === "ngón tay cái" || state.pain === "tay") && /(di lai|dung len ngoi xuong|khop hang|khop goi|than kinh toa)/.test(textValue)) flags.push("sai luồng tay/cổ tay");
  if ((state.intent === "address" || state.intent === "price_and_address") && !/(33n|94|hoang quoc viet|binh trung|chi nhanh)/.test(textValue)) flags.push("khách hỏi địa chỉ nhưng chưa trả lời thẳng");
  if (state.intent === "price" && state.assessmentSent && !/(499|uu dai|chi phi|lo trinh)/.test(textValue)) flags.push("khách hỏi giá sau đánh giá nhưng chưa báo ưu đãi");
  return flags;
}

function qualityByConversation(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    if (!row.chatKey) continue;
    if (!grouped.has(row.chatKey)) grouped.set(row.chatKey, []);
    grouped.get(row.chatKey).push(row);
  }

  const results = [];
  for (const [chatKey, chatRows] of grouped.entries()) {
    const flags = new Set();
    let score = 10;
    let lastCustomer = "";
    let lastBot = "";
    let humanSeen = false;
    let phoneSeen = false;
    let lastBotText = "";
    let botAfterHuman = 0;

    for (const row of chatRows) {
      if (row.type === "customer") {
        lastCustomer = row.text || "";
        if (hasPhoneNumber(row.text || "")) phoneSeen = true;
      }
      if (row.type === "human_takeover" || String(row.reason || "").includes("human")) {
        humanSeen = true;
      }
      if (row.type === "bot") {
        lastBot = row.text || "";
        if (humanSeen || phoneSeen) {
          flags.add("Bot van nhan sau khi nguoi that/SDT xuat hien");
          botAfterHuman += 1;
        }
        if (lastBotText && normalizeText(lastBotText) === normalizeText(row.text || "")) {
          flags.add("Bot lap lai cau cu");
        }
        for (const flag of botRiskFlags(row, new Map([[chatKey, lastBotText]]))) flags.add(flag);
        lastBotText = row.text || "";
      }
      if (row.type === "handoff" && /final gate|graph history|memory detected|human already/.test(row.reason || "")) {
        flags.add("Bot da tu chan dung tinh huong can dung");
      }
    }

    if (botAfterHuman) score -= 5;
    if ([...flags].some((flag) => /sai v|sai lu/.test(normalizeText(flag)))) score -= 3;
    if ([...flags].some((flag) => /lap/.test(normalizeText(flag)))) score -= 2;
    if ([...flags].some((flag) => /ngon tu|dia chi|gia/.test(normalizeText(flag)))) score -= 1;

    results.push({
      chatKey,
      score: Math.max(0, Math.min(10, score)),
      flags: [...flags],
      lastCustomer,
      lastBot,
      messages: chatRows.length,
    });
  }

  return results.sort((a, b) => a.score - b.score || b.messages - a.messages);
}

function reportHtml(rows) {
  const customerTopics = new Map();
  const pains = new Map();
  const intents = new Map();
  const botRisks = new Map();
  const examples = [];
  const humanExamples = [];
  const previousBotByChat = new Map();
  const chatSet = new Set();
  let customerMessages = 0;
  let botMessages = 0;
  let handoffs = 0;
  let humanLocks = 0;

  for (const row of rows) {
    if (row.chatKey) chatSet.add(row.chatKey);
    if (row.type === "customer") {
      customerMessages += 1;
      addCount(customerTopics, detectReportTopic(row.text));
      const pain = detectPain(row.text);
      if (pain) addCount(pains, pain);
      const intent = detectReportTopic(row.text);
      addCount(intents, intent);
    }
    if (row.type === "bot") {
      botMessages += 1;
      const flags = botRiskFlags(row, previousBotByChat);
      for (const flag of flags) addCount(botRisks, flag);
      if (flags.length && examples.length < 20) {
        examples.push({ at: row.at, chatKey: row.chatKey, flags, text: row.text });
      }
      previousBotByChat.set(row.chatKey, row.text || "");
    }
    if (row.type === "handoff") handoffs += 1;
    if (row.type === "human_takeover") {
      humanLocks += 1;
      if (row.text && humanExamples.length < 80) {
        humanExamples.push({ at: row.at, chatKey: row.chatKey, reason: row.reason, text: row.text });
      }
    }
  }

  const esc = (v = "") => String(v).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const list = (items) => items.length ? items.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("") : `<tr><td colspan="2">Chưa có dữ liệu</td></tr>`;
  const exampleList = examples.length
    ? examples.map((item) => `<li><b>${esc(item.flags.join(", "))}</b><br><small>${esc(item.at)} | ${esc(item.chatKey)}</small><br>${esc(item.text)}</li>`).join("")
    : "<li>Chưa phát hiện lỗi nổi bật trong dữ liệu đã lưu.</li>";
  const humanList = humanExamples.length
    ? humanExamples.map((item) => `<li><b>${esc(item.text)}</b><br><small>${esc(item.at)} | ${esc(item.chatKey)} | ${esc(item.reason)}</small></li>`).join("")
    : "<li>Chưa có nội dung người thật nhắn được ghi nhận.</li>";

  const qualityRows = qualityByConversation(rows);
  const avgQuality = qualityRows.length ? (qualityRows.reduce((sum, item) => sum + item.score, 0) / qualityRows.length).toFixed(1) : "10.0";
  const qualityTable = qualityRows.slice(0, 40).map((item) => `<tr><td>${esc(item.chatKey)}</td><td><b>${item.score}/10</b></td><td>${esc(item.flags.join("; ") || "On")}</td><td>${esc(item.lastCustomer)}</td><td>${esc(item.lastBot)}</td></tr>`).join("") || `<tr><td colspan="5">Chua co du lieu</td></tr>`;

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Báo cáo chatpage IVA</title>
  <style>
    body{font-family:Arial,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:24px}
    .wrap{max-width:1100px;margin:auto}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
    .card,table,ol{background:white;border:1px solid #e2e8f0;border-radius:12px;padding:16px}
    .num{font-size:30px;font-weight:700}
    table{width:100%;border-collapse:collapse;margin:12px 0 24px}
    td,th{border-bottom:1px solid #e2e8f0;padding:10px;text-align:left}
    h1{margin-top:0}.muted{color:#64748b}li{margin-bottom:14px}
  </style>
</head>
<body><div class="wrap">
  <h1>Báo cáo rà soát chatpage IVA</h1>
  <p class="muted">Dữ liệu lấy từ log bot trong 7 ngày gần nhất. Số điện thoại đã được ẩn bớt.</p>
  <div class="grid">
    <div class="card"><div class="num">${chatSet.size}</div><div>Cuộc chat</div></div>
    <div class="card"><div class="num">${customerMessages}</div><div>Tin khách</div></div>
    <div class="card"><div class="num">${botMessages}</div><div>Tin bot</div></div>
    <div class="card"><div class="num">${handoffs}</div><div>Lần bot dừng</div></div>
    <div class="card"><div class="num">${humanLocks}</div><div>Khóa khi người thật nhắn</div></div>
    <div class="card"><div class="num">${avgQuality}</div><div>Điểm chất lượng TB</div></div>
  </div>
  <h2>Chat cần ưu tiên kiểm tra</h2>
  <table><tr><th>Cuộc chat</th><th>Điểm</th><th>Cờ lỗi/cảnh báo</th><th>Tin khách gần nhất</th><th>Tin bot gần nhất</th></tr>${qualityTable}</table>
  <h2>Khách hay hỏi/chia sẻ gì</h2>
  <table><tr><th>Nhóm nội dung</th><th>Số lần</th></tr>${list(topCounts(customerTopics))}</table>
  <h2>Vùng đau được nhắc nhiều</h2>
  <table><tr><th>Vùng đau</th><th>Số lần</th></tr>${list(topCounts(pains))}</table>
  <h2>Lỗi/rủi ro bot cần xem</h2>
  <table><tr><th>Loại rủi ro</th><th>Số lần</th></tr>${list(topCounts(botRisks))}</table>
  <h2>Nội dung người thật đã nhắn</h2>
  <ol>${humanList}</ol>
  <h2>Đoạn cần rà lại</h2>
  <ol>${exampleList}</ol>
</div></body></html>`;
}

const privacyPolicyHtml = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Chính sách quyền riêng tư - Phòng khám PHCN IVA</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; max-width: 880px; margin: 40px auto; padding: 0 18px; color: #1f2937; }
    h1, h2 { color: #0f172a; }
  </style>
</head>
<body>
  <h1>Chính sách quyền riêng tư và xóa dữ liệu người dùng</h1>
  <p><strong>Phòng khám Phục hồi chức năng IVA</strong></p>
  <p>IVA sử dụng thông tin khách hàng nhắn qua Fanpage để tư vấn ban đầu, hỗ trợ đặt lịch, xác nhận lịch hẹn và chăm sóc khách hàng.</p>
  <h2>Thông tin có thể tiếp nhận</h2>
  <p>Họ tên, số điện thoại, nội dung tư vấn, tình trạng cơ xương khớp khách chủ động chia sẻ, thời gian/cơ sở muốn đặt lịch.</p>
  <h2>Chia sẻ dữ liệu</h2>
  <p>IVA không bán hoặc chia sẻ thông tin cá nhân của khách hàng cho bên thứ ba vì mục đích thương mại.</p>
  <h2>Xóa dữ liệu</h2>
  <p>Khách hàng có thể nhắn Fanpage với nội dung “Yêu cầu xóa dữ liệu”. IVA sẽ kiểm tra và xóa/ẩn thông tin liên quan trong phạm vi hệ thống quản lý của phòng khám.</p>
  <h2>Liên hệ</h2>
  <p>CN1: 33N Hoàng Quốc Việt, Tân Mỹ, TP.HCM</p>
  <p>CN2: 94 Đường 56, Bình Trưng, TP.HCM</p>
</body>
</html>`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function naturalDelay(message = "") {
  const base = MIN_REPLY_DELAY_MS + Math.min(message.length * 28, 1400);
  const jitter = Math.floor(Math.random() * Math.max(500, MAX_REPLY_DELAY_MS - MIN_REPLY_DELAY_MS));
  return Math.min(MAX_REPLY_DELAY_MS, base + jitter);
}

function normalizeText(text = "") {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chatText(rawText = "") {
  return ` ${normalizeText(rawText)} `
    .replace(/\bbn\b/g, " bao nhieu ")
    .replace(/\bbnhieu\b/g, " bao nhieu ")
    .replace(/\bdc\b/g, " duoc ")
    .replace(/\bdc k\b/g, " duoc khong ")
    .replace(/\bdc ko\b/g, " duoc khong ")
    .replace(/\bk\b/g, " khong ")
    .replace(/\bko\b/g, " khong ")
    .replace(/\bkh\b/g, " khong ")
    .replace(/\bc\b/g, " co ")
    .replace(/\s+/g, " ")
    .trim();
}

function getHistory(senderId) {
  if (!conversations.has(senderId)) conversations.set(senderId, [...DEFAULT_HISTORY]);
  return conversations.get(senderId);
}

function getCustomerState(senderId) {
  if (!customerStates.has(senderId)) {
    customerStates.set(senderId, {
      persona: "mình",
      pain: "",
      primaryPain: "",
      disease: "",
      duration: "",
      trigger: "",
      radiation: "",
      treated: "",
      askedPrice: false,
      askedAddress: false,
      wantsBooking: false,
      hasPhone: false,
      objection: "",
      stage: "new",
      leadGroup: "unknown",
      temperature: "cold",
      nextGoal: "discover_need",
      customerIntent: "unknown",
      nextBestAction: "ask_problem",
      areaHint: "",
      preferredBranch: "",
      customerName: "",
      phoneNumber: "",
      appointmentTime: "",
      lastQuestion: "",
      askedFields: new Set(),
      assessmentSent: false,
      priceSent: false,
      addressSent: false,
      bookingAsked: false,
      specificDiseaseAnswered: false,
      humanTakeover: false,
      lastBotMessage: "",
      sentQuestionKeys: new Set(),
      sentMessageFingerprints: new Set(),
      messageCount: 0,
    });
  }
  return customerStates.get(senderId);
}

function subject(state) {
  return state.persona || "mình";
}

function capitalizeFirst(textValue) {
  return textValue ? textValue.charAt(0).toUpperCase() + textValue.slice(1) : textValue;
}

function alignPronouns(state, message) {
  const persona = subject(state);
  if (persona === "mình") return message;

  return message
    .replace(/\bMình\b/g, capitalizeFirst(persona))
    .replace(/\bmình\b/g, persona);
}

function pickTone(state, options) {
  if (!options.length) return "";
  const index = Math.abs((state.messageCount || 0) + (state.stage || "").length) % options.length;
  return options[index];
}

function painPhrase(state) {
  if (state.pain === "ngón tay cái") return "ngón cái";
  if (state.pain === "cổ tay") return "cổ tay";
  return state.pain || "phần này";
}

function durationQuestion(state) {
  const s = subject(state);
  if (state.disease) {
    return pickTone(state, [
      `Dạ ${s} bị lâu chưa ạ?`,
      `Dạ tình trạng này của ${s} kéo dài lâu chưa ạ?`,
    ]);
  }
  return pickTone(state, [
    `Dạ ${s} đau ${painPhrase(state)} lâu chưa ạ?`,
    `Dạ ${s} mới đau gần đây hay kéo dài rồi ạ?`,
  ]);
}

function triggerQuestion(state) {
  const s = subject(state);
  if (state.pain === "lưng") return `Dạ ${s} ngồi lâu hoặc đi lại có thấy đau hơn không ạ?`;
  if (state.pain === "gối") return `Dạ ${s} đi lại có đau nhiều hơn không ạ?`;
  if (state.pain === "háng") return `Dạ ${s} đau khi đi lại hay lúc đứng lên ngồi xuống ạ?`;
  if (state.pain === "vai" || state.pain === "vai gáy") return `Dạ ${s} ngồi lâu hoặc dùng điện thoại có nhanh mỏi hơn không ạ?`;
  if (state.pain === "ngón tay cái") return `Dạ ${s} cầm nắm hoặc gập duỗi ngón cái có đau hơn không ạ?`;
  if (state.pain === "cổ tay") return `Dạ ${s} xoay cổ tay hoặc cầm nắm có đau hơn không ạ?`;
  if (state.pain === "tay") return `Dạ ${s} cầm nắm hoặc xoay tay có đau hơn không ạ?`;
  return `Dạ phần này mình thấy đau hơn khi cử động hay lúc nghỉ cũng đau ạ?`;
}

function detectPersona(rawText, state) {
  const raw = rawText.toLowerCase();
  const text = chatText(rawText);
  if (/(^|\s)anh(\s|$)/.test(text)) state.persona = "anh";
  if (/(^|\s)(chị|chi)(\s|$)/.test(raw) || /(^|\s)chi(\s|$)/.test(text)) state.persona = "chị";
  if (/(^|\s)cô(\s|$)/.test(raw)) state.persona = "cô";
  if (/(^|\s)(chú|chu)(\s|$)/.test(raw) || /(^|\s)chu(\s|$)/.test(text)) state.persona = "chú";
}

function detectPain(rawText) {
  const text = chatText(rawText);
  if (isMixedHandLegNumbness(rawText)) return "";
  if (isUnclearJointComplaint(rawText)) return "";
  if (/(hoi chung ong co tay|ong co tay|te dau ngon tay|te ngon tay|te dau ngon|te ngon cai|te dau ngon cai)/.test(text)) return "cổ tay";
  if (/(co vai gay|vai gay|dau vai gay|co gay|dau vung co|vung co|dau co|mo co|te tay)/.test(text)) return "vai gáy";
  if (/(dau vai|vai\b)/.test(text)) return "vai";
  if (/(that lung|dau lung|song lung|lung|te chan|than kinh toa)/.test(text)) return "lưng";
  if (/(dau goi|goi\b)/.test(text)) return "gối";
  if (/(khop hang|dau hang|vung hang|\bhang\b)/.test(text)) return "háng";
  if (/(ngon tay cai|ngon cai|dau ngon tay|dau ngon cai)/.test(text)) return "ngón tay cái";
  if (/(co tay|dau co tay)/.test(text)) return "cổ tay";
  if (/(khuyu tay|elbow|tennis elbow|dau tay|\btay\b)/.test(text)) return "tay";
  return "";
}

function detectExplicitPain(rawText) {
  const text = chatText(rawText);
  if (isMixedHandLegNumbness(rawText)) return "";
  if (isUnclearJointComplaint(rawText)) return "";

  if (/(hoi chung ong co tay|ong co tay|te dau ngon tay|te ngon tay|te dau ngon|te ngon cai|te dau ngon cai)/.test(text)) return "cá»• tay";
  if (/(co vai gay|vai gay|dau vai gay|dau moi vai gay|dau co vai gay|co gay|dau vung co|vung co|dau co|mo co)/.test(text)) return "vai gÃ¡y";
  if (/(dau vai|moi vai|nhuc vai)/.test(text)) return "vai";
  if (/(that lung|dau lung|dau that lung|song lung|dau song lung|te chan|than kinh toa)/.test(text)) return "lÆ°ng";
  if (/(dau goi|khop goi|vung goi|nhuc goi|moi goi|^goi$)/.test(text)) return "gá»‘i";
  if (/(khop hang|dau hang|vung hang)/.test(text)) return "hÃ¡ng";
  if (/(ngon tay cai|ngon cai|dau ngon tay|dau ngon cai|te ngon tay|te ngon cai)/.test(text)) return "ngÃ³n tay cÃ¡i";
  if (/(co tay|dau co tay|te co tay)/.test(text)) return "cá»• tay";
  if (/(khuyu tay|khuu tay|elbow|tennis elbow|dau tay)/.test(text)) return "tay";
  return "";
}

function isMixedHandLegNumbness(rawText) {
  const text = chatText(rawText);
  return /(te tay chan|te chan tay|tay chan.*te|te ca tay.*chan|te ca chan.*tay|te deu tay chan|te het tay chan)/.test(text);
}

function shouldAllowPainUpdate(state, pain, explicitPain = "") {
  if (!pain) return false;
  const lockedPain = state.primaryPain || state.pain || "";
  if (!lockedPain) return true;
  if (explicitPain) return true;
  return pain === lockedPain;
}

function isUnclearJointComplaint(rawText) {
  const text = chatText(rawText);
  const mentionsJoint = /(dau khop|moi khop|nhuc khop|viem khop|thoai hoa khop|khop bi dau|khop dau)/.test(text);
  if (!mentionsJoint) return false;
  const hasSpecificJoint = /(vai|gay|co|lung|that lung|goi|khop hang|dau hang|\bhang\b|co tay|ngon tay|ngon cai|khuyu tay|tay|chan|mong|mat ca|ban chan|khuu tay)/.test(text);
  return !hasSpecificJoint;
}

function detectDisease(rawText) {
  const text = chatText(rawText);
  if (/(hoi chung ong co tay|ong co tay)/.test(text)) return "hội chứng ống cổ tay";
  if (/thoat vi/.test(text)) return "thoát vị đĩa đệm";
  if (/than kinh toa/.test(text)) return "đau thần kinh tọa";
  if (/thoai hoa/.test(text)) return "thoái hóa";
  if (/viem khop hang/.test(text)) return "viêm khớp háng";
  if (/viem khop/.test(text)) return "viêm khớp";
  if (/elbow|tennis elbow/.test(text)) return "elbow";
  return "";
}

function detectDuration(rawText) {
  const text = chatText(rawText);
  if (/^\d+\s*(ngay|tuan|thang|nam)/.test(text)) return rawText.trim();
  if (/(hom qua|moi day|gan day|vua bi|moi bi|moi gan day|may hom|vai hom|tuan|thang|nam|ngay)/.test(text)) return rawText.trim();
  if (/^(moi|moi em|moi a|moi anh|moi chi|gan day|gan day em)$/.test(text)) return rawText.trim();
  return "";
}

function detectTrigger(rawText) {
  const text = chatText(rawText);
  if (/(di moi dau|di lai|di dung|di la dau|di thay dau|di lai thay dau|di lai.*dau)/.test(text)) return "đi lại đau";
  if (/(ngoi lau|ngoi lam viec|ngoi)/.test(text)) return "ngồi lâu đau";
  if (/(cam nam|nam do|gap duoi|xoay tay|bam dien thoai|dung chuot|go phim)/.test(text)) return "cầm nắm đau";
  if (/(van dong|choi the thao|be nang|tap gym|tap|the thao)/.test(text)) return "vận động";
  if (/(tu nhien|tu dung)/.test(text)) return "tự nhiên";
  return "";
}

function detectRadiation(rawText) {
  const text = chatText(rawText);
  if (/(te chu khong phai dau|te hon|te buot|te dau ngon|te ngon tay|te ngon cai)/.test(text)) return "tay";
  if (/(te tay|lan xuong tay|moi tay|dau dau)/.test(text)) return "tay";
  if (/(te chan|lan xuong chan|lan xuong mong|xuong mong|moi chan|dau xuong mong)/.test(text)) return "chân";
  if (/^(co|uh|u|vang|da co|co em|vang em|da|co a|co chi)$/.test(text)) return "có";
  if (/^(khong|khong em|khong a|khong chi|khong dau|khong co|chua|chua em)$/.test(text)) return "không";
  return "";
}

function detectTreatment(rawText) {
  const text = chatText(rawText);
  if (/^(chua|chua em|chua a|chua chi)$/.test(text)) return "chưa";
  if (/(cham cuu|vat ly tri lieu|vltl|uong thuoc|da dieu tri|co di|da chua|phau thuat|tap)/.test(text)) return rawText.trim();
  return "";
}

function detectYesNo(rawText) {
  const text = chatText(rawText);
  if (/^(co|uh|u|vang|da|co em|vang em|da co|co a|co anh|co chi)$/.test(text)) return "có";
  if (/^(khong|khong em|khong a|khong anh|khong chi|khong dau|khong co|chua|chua em)$/.test(text)) return "không";
  return "";
}

function hasPhoneNumber(rawText) {
  return /(?:\+?84|0)(?:\d[\s.-]?){8,10}\d/.test(rawText);
}

function extractPhoneNumber(rawText = "") {
  const match = rawText.match(/(?:\+?84|0)(?:\d[\s.-]?){8,10}\d/);
  return match ? match[0].replace(/[^\d+]/g, "") : "";
}

function detectCustomerName(rawText = "") {
  const noPhone = rawText.replace(/(?:\+?84|0)(?:\d[\s.-]?){8,10}\d/g, " ");
  const cleaned = noPhone.replace(/[()\-–—:;,.]/g, " ").replace(/\s+/g, " ").trim();
  const text = chatText(cleaned);
  if (!cleaned || cleaned.length < 4) return "";
  if (/(hom nay|ngay mai|mai|qua|binh trung|hoang quoc viet|dia chi|gia|phi|dau|moi|lau|co|khong|kham|lich|sang|chieu|toi)/.test(text)) {
    return "";
  }
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 5) return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  return "";
}

function detectAppointmentTime(rawText = "") {
  const text = chatText(rawText);
  const raw = rawText.trim();
  const timeMatch = raw.match(/\b(\d{1,2})\s*(h|g|giờ|gio)(?:\s*(\d{1,2}))?\b/i);
  const day = /ngay mai|mai/.test(text) ? "mai" : /hom nay|nay/.test(text) ? "hôm nay" : "";
  if (timeMatch) {
    const hour = timeMatch[1];
    const minute = timeMatch[3] ? `${timeMatch[3]}p` : "";
    return `${hour}h${minute}${day ? ` ${day}` : ""}`.trim();
  }
  if (/sang mai|mai sang/.test(text)) return "sáng mai";
  if (/chieu mai|mai chieu/.test(text)) return "chiều mai";
  if (/toi mai|mai toi/.test(text)) return "tối mai";
  if (/lat|chut nua/.test(text)) return "lát nữa";
  return "";
}

function isPriceQuestion(rawText) {
  const text = chatText(rawText);
  return /(gia|phi|chi phi|bao nhieu|bao nhiu|bao tien|bao nhieu tien|bn tien|mac|dat|dat khong|dat k|ton kem|bang gia|buoi le|phat sinh|ep mua|uu dai|chuong trinh|499|5 buoi|nam buoi|dung khong|nhu nao)/.test(text);
}

function isCostProcessQuestion(rawText) {
  const text = chatText(rawText);
  return /(phat sinh|ep mua|co ep|mua goi|bat buoc mua|bat mua|phai mua|co bi ep|co bat buoc)/.test(text);
}

function isAddressQuestion(rawText) {
  const text = chatText(rawText);
  return /(dia chi|cho dia chi|cho xin dia chi|xin dia chi|o dau|kiem tra o dau|kham o dau|ben minh o dau|ben minh co kiem tra khong|co kiem tra khong|so may|la so may|duong nao|so nha|dia chi cu the)/.test(text);
}

function isBookingIntent(rawText) {
  const text = chatText(rawText);
  if (/(moi hom nay|hom nay moi|vua hom nay)/.test(text)) return false;
  return /(hom nay|ngay mai|mai toi qua|mai qua|may gio|lich may gio|co lich khong|co lich may gio|dat lich|giu lich|lich nhu the nao|qua duoc|qua dc|qua duoc khong|qua kham|toi qua duoc khong)/.test(text);
}

function isScheduleChangeOrDelay(rawText) {
  const text = chatText(rawText);
  return /(hoan|doi lich|doi gio|doi sang|doi chieu|doi ngay|huy lich|khong qua duoc|chua qua duoc|mai khong qua|hom nay khong qua|ban viec|co viec dot xuat|doi buoi|de hom khac|hen lai|qua tre|tre gio)/.test(text);
}

function isCustomerEndingOrDeclining(rawText) {
  const text = chatText(rawText);
  return /(cam on|cảm ơn|thoi|thoi de|de minh thu xep|de minh tu xep|tu thu xep|thu xep sau|de sau|khong can|ko can|k can|khong tu van nua|k tu van nua|bo qua|khoi|de minh di mo|di mo luon|mo luon|di mo cho tien|khong lam|k lam|khong dat|k dat|tu van vay duoc roi|duoc roi em|vay thoi|sap xep duoc se qua|neu sap xep duoc|de toi tinh|de minh tinh)/.test(text);
}

function isCustomerReplyingToHumanPrice(rawText, state = {}) {
  const text = chatText(rawText);
  if (state.priceSent) return false;
  return /(gia goc|gia gốc|800|189|mien phi kham|miễn phí khám|ho tro 100|hỗ trợ 100|mung sinh nhat|mừng sinh nhật|chi kham thoi|chỉ khám thôi|da bao gia|đã báo giá|phi kham dc ho tro|phí khám dc hỗ trợ|khong ton phi|không tốn phí)/.test(text);
}

function isBranchChoice(rawText) {
  const text = chatText(rawText);
  return /(binh trung|hoang quoc viet|quan 7|q7|tan my|tan hung|duong 56|quan 9|q9|thu duc|tp thu duc|quan 2|q2|cat lai|an phu)/.test(text);
}

function inferBranchFromText(rawText) {
  const text = chatText(rawText);
  if (/(binh trung|duong 56|quan 9|q9|thu duc|tp thu duc|quan 2|q2|cat lai|an phu)/.test(text)) {
    return "Bình Trưng";
  }
  if (/(hoang quoc viet|quan 7|q7|tan my|tan hung|nha be|phu my hung|nguyen thi thap)/.test(text)) {
    return "Hoàng Quốc Việt";
  }
  return "";
}

function detectAreaHint(rawText) {
  const text = chatText(rawText);

  if (/(quan 9|q9|thu duc|tp thu duc|binh trung|an phu|cat lai|quan 2|q2)/.test(text)) {
    return { area: rawText.trim(), branch: "Bình Trưng" };
  }

  if (/(quan 7|q7|tan my|tan hung|nha be|phu my hung|nguyen thi thap)/.test(text)) {
    return { area: rawText.trim(), branch: "Hoàng Quốc Việt" };
  }

  if (/(go vap|binh thanh|tan binh|phu nhuan|quan 1|q1|quan 3|q3|quan 10|q10)/.test(text)) {
    return { area: rawText.trim(), branch: "" };
  }

  if (/(xa qua|xa khong|gan khong|gan cho nao)/.test(text)) {
    return { area: rawText.trim(), branch: "" };
  }

  return null;
}

function isSpecificDiseaseQuestion(rawText) {
  const text = chatText(rawText);
  return /(cu the la benh gi|benh gi|bi gi|la gi|co phai benh)/.test(text);
}

function isMethodQuestion(rawText) {
  const text = chatText(rawText);
  return /(phuong phap|pp nao|dieu tri the nao|tri lieu the nao|co nhung pp|co may gi|vat ly tri lieu)/.test(text);
}

function isOutcomeQuestion(rawText) {
  const text = chatText(rawText);
  return /(lieu trinh|5 buoi|nam buoi|co that su|co het|het khong|co khoi|khoi khong|cai thien|hieu qua|do khong|giam khong)/.test(text);
}

function isCustomerCorrection(rawText) {
  const text = chatText(rawText);
  return /(khong phai|ko phai|k phai|te chu khong phai dau|nham|bam nham|xl|xin loi)/.test(text);
}

function isNumbnessComplaint(rawText) {
  const text = chatText(rawText);
  return /(te buot|te dau ngon|te ngon tay|te ngon cai|te tay|hoi chung ong co tay|ong co tay|te chu khong phai dau)/.test(text);
}

function isPing(rawText) {
  const text = chatText(rawText);
  return /^(alo|hello|helo|hi|chao|tu van|can tu van|em oi|e oi|co ai khong)$/.test(text);
}

function isOutOfScopeQuestion(rawText) {
  const text = chatText(rawText);
  return /(ai dang tra loi|ai tu van|bot ha|robot ha|co phai ai|may tra loi|nguoi hay may|bac si nao|gio lam viec|may gio dong cua|may gio mo cua|buoi le|cam ket khoi|co khoi khong|massage thu gian|mat xa thu gian|bao hanh|chac khoi)/.test(text);
}

function detectCustomerIntent(rawText, state) {
  if (hasPhoneNumber(rawText)) return "leave_phone";
  if (isScheduleChangeOrDelay(rawText)) return "schedule_change";
  if (isCustomerCorrection(rawText)) return "customer_correction";
  if (isOutcomeQuestion(rawText)) return "outcome_question";
  if (isCostProcessQuestion(rawText)) return "cost_process";
  if (isOutOfScopeQuestion(rawText)) return "out_of_scope";
  if (isPriceQuestion(rawText) && isAddressQuestion(rawText)) return "price_and_address";
  if (isPriceQuestion(rawText) && isBookingIntent(rawText)) return "price_and_booking";
  if (isAddressQuestion(rawText) && isBookingIntent(rawText)) return "address_and_booking";
  if (isPriceQuestion(rawText)) return "price";
  if (isAddressQuestion(rawText)) return "address";
  if (isBookingIntent(rawText)) return "booking";
  if (isBranchChoice(rawText) || detectAreaHint(rawText)) return state.assessmentSent || state.priceSent ? "branch_for_booking" : "area_or_branch";
  if (isSpecificDiseaseQuestion(rawText)) return "specific_disease";
  if (isMethodQuestion(rawText)) return "method";
  if (isPing(rawText)) return "open_consult";
  if (detectDisease(rawText)) return "known_disease";
  if (detectPain(rawText)) return "symptom";
  return "answer_followup";
}

function detectObjection(rawText) {
  const text = chatText(rawText);
  if (/(so dat|dat qua|so phat sinh|ep mua|co ep|phat sinh gi)/.test(text)) return "cost_concern";
  if (/(dang ban|anh dang ban|chi dang ban|chua sap xep|de suy nghi|chua co thoi gian)/.test(text)) return "busy";
  return "";
}

function detectCustomerEmotion(rawText) {
  const text = chatText(rawText);
  if (/(dat qua|so dat|so ton tien|toi so dat|mac qua|chi phi cao)/.test(text)) return "lo_gia";
  if (/(ep mua|phat sinh|co ep|so bi ep|co phat sinh)/.test(text)) return "so_bi_ban_hang";
  if (/(dang ban|khong co thoi gian|chua sap xep|lat nua|de sau)/.test(text)) return "dang_ban";
  if (/(sao hoi lai|hoi roi|toi noi roi|nham|khong phai|bot|may tra loi)/.test(text)) return "kho_chiu";
  if (/(hom nay|mai|lat qua|qua duoc|dat lich|may gio|dia chi|o dau|chi phi|gia)/.test(text)) return "co_tin_hieu_chot";
  return "binh_thuong";
}

function estimateLeadHeat(state, customerText = "") {
  const text = chatText(customerText);
  let score = 0;
  if (state.pain || state.disease || detectPain(customerText) || detectDisease(customerText)) score += 2;
  if (state.duration || detectDuration(customerText)) score += 1;
  if (state.trigger || detectTrigger(customerText)) score += 1;
  if (state.radiation || detectRadiation(customerText)) score += 1;
  if (state.assessmentSent) score += 1;
  if (state.askedPrice || isPriceQuestion(customerText)) score += 2;
  if (state.askedAddress || isAddressQuestion(customerText)) score += 2;
  if (state.wantsBooking || isBookingIntent(customerText)) score += 3;
  if (state.hasPhone || hasPhoneNumber(customerText)) score += 4;
  if (/(hom nay|mai|lat qua|chieu nay|sang mai|toi qua)/.test(text)) score += 2;

  if (score >= 8) return "rat_nong";
  if (score >= 5) return "nong";
  if (score >= 2) return "am";
  return "lanh";
}

function resetClinicalIfNewTopic(state, pain, disease) {
  const changedPain = pain && state.pain && pain !== state.pain;
  const changedDisease = disease && state.disease && disease !== state.disease;
  if (!changedPain && !changedDisease) return;

  state.pain = "";
  state.primaryPain = pain || "";
  state.disease = "";
  state.duration = "";
  state.trigger = "";
  state.radiation = "";
  state.treated = "";
  state.lastQuestion = "";
  state.askedFields = new Set();
  state.assessmentSent = false;
  state.priceSent = false;
  state.bookingAsked = false;
  state.specificDiseaseAnswered = false;
}

function classifyLead(state) {
  const hasSignal = Boolean(state.pain || state.disease || state.duration || state.trigger || state.radiation);
  const strongerSignal =
    Boolean(state.disease) ||
    Boolean(state.radiation && state.radiation !== "không") ||
    Boolean(state.treated && state.treated !== "chưa") ||
    /(thang|nam)/.test(normalizeText(state.duration));

  const heat = estimateLeadHeat(state);
  if (heat === "rat_nong" || heat === "nong") state.temperature = "hot";
  else if (heat === "am") state.temperature = "warm";
  else if (state.askedPrice || state.askedAddress || strongerSignal) state.temperature = "warm";
  else state.temperature = hasSignal ? "warm" : "cold";

  if (state.hasPhone) state.leadGroup = "left_phone";
  else if (state.wantsBooking) state.leadGroup = "booking_intent";
  else if (state.objection) state.leadGroup = state.objection;
  else if (state.askedPrice) state.leadGroup = "price_question";
  else if (state.askedAddress) state.leadGroup = "address_question";
  else if (state.disease) state.leadGroup = "known_disease";
  else if (state.pain) state.leadGroup = strongerSignal ? "likely_pathology" : "symptom_unknown";
  else state.leadGroup = "unknown";

  if (state.hasPhone) state.nextGoal = "confirm_branch";
  else if (state.wantsBooking || state.priceSent) state.nextGoal = "book_appointment";
  else if (state.askedPrice && !hasEnoughForPrice(state)) state.nextGoal = "collect_missing_before_price";
  else if (state.askedPrice && hasEnoughForPrice(state)) state.nextGoal = "present_offer";
  else if (state.assessmentSent) state.nextGoal = "move_to_price_or_booking";
  else if (hasSignal) state.nextGoal = "complete_assessment";
  else state.nextGoal = "discover_need";

  if (state.nextGoal === "confirm_branch") state.nextBestAction = "confirm_branch";
  else if (state.nextGoal === "book_appointment") state.nextBestAction = "ask_name_phone_or_branch";
  else if (state.nextGoal === "present_offer") state.nextBestAction = "send_offer";
  else if (state.nextGoal === "move_to_price_or_booking") state.nextBestAction = "answer_intent_then_close";
  else if (state.nextGoal === "complete_assessment") state.nextBestAction = "ask_one_missing_or_assess";
  else state.nextBestAction = "ask_problem";
}

function areaReply(state) {
  state.stage = "area_routing";
  const s = subject(state);

  if (state.preferredBranch) {
    return result(state, `Dạ vậy ${s} tiện cơ sở ${state.preferredBranch} hơn ạ. ${capitalizeFirst(s)} đang cần kiểm tra đau/mỏi phần nào ạ?`, "problem");
  }

  return result(state, `${CLINIC.address} ${CLINIC.branchAsk}`, "branch_distance");
}

function branchChoiceReply(state, rawText = "") {
  const branch = inferBranchFromText(rawText) || state.preferredBranch;
  if (branch) state.preferredBranch = branch;
  const s = subject(state);

  const bookingStatus = bookingInfoReply(state);
  if (bookingStatus) return bookingStatus;

  if (state.bookingAsked || state.wantsBooking || state.priceSent || state.assessmentSent) {
    state.bookingAsked = true;
    state.stage = "booking_phone";
    return result(state, `Dạ ${branch ? `${s} tiện cơ sở ${branch} ạ. ` : ""}${capitalizeFirst(s)} cho em xin tên và SĐT để em giữ lịch cho mình ạ?`, "phone");
  }

  state.stage = "branch_selected";
  return result(state, `Dạ vậy ${s} tiện cơ sở ${branch || "này"} hơn ạ. ${capitalizeFirst(s)} đang cần hỗ trợ đau/mỏi phần nào ạ?`, "problem");
}

function updateStateFromText(state, rawText) {
  detectPersona(rawText, state);
  if (!state.primaryPain && state.pain) state.primaryPain = state.pain;

  const explicitPain = detectExplicitPain(rawText);
  const detectedPain = detectPain(rawText);
  const pain = explicitPain || detectedPain;
  const disease = detectDisease(rawText);
  const canUpdatePain = shouldAllowPainUpdate(state, pain, explicitPain);
  resetClinicalIfNewTopic(state, canUpdatePain ? pain : "", disease);

  const yesNo = detectYesNo(rawText);
  const duration = detectDuration(rawText);
  const trigger = detectTrigger(rawText);
  const radiation = detectRadiation(rawText);
  const treated = detectTreatment(rawText);
  const phoneNumber = extractPhoneNumber(rawText);
  const customerName = detectCustomerName(rawText);
  const appointmentTime = detectAppointmentTime(rawText);

  if (pain && canUpdatePain) {
    state.pain = pain;
    if (!state.primaryPain || explicitPain) state.primaryPain = pain;
  }
  if (disease) state.disease = disease;
  const painBeforeNumbness = { pain: state.pain, primaryPain: state.primaryPain };
  if (isNumbnessComplaint(rawText)) {
    state.pain = "cổ tay";
    state.radiation = "tay";
    if (!state.disease && /ong co tay|hoi chung ong co tay/.test(chatText(rawText))) {
      state.disease = "hội chứng ống cổ tay";
    }
    if (/khong phai dau|ko phai dau|k phai dau|te chu/.test(chatText(rawText))) {
      state.trigger = "";
    }
  }
  if (painBeforeNumbness.primaryPain && painKey(painBeforeNumbness.primaryPain) !== "tay" && painKey(painBeforeNumbness.primaryPain) !== "co_tay" && painKey(painBeforeNumbness.primaryPain) !== "ngon_tay_cai") {
    state.pain = painBeforeNumbness.pain;
    state.primaryPain = painBeforeNumbness.primaryPain;
  }
  if (!pain && /(te chu khong phai dau|te hon|te buot|te dau ngon|te ngon tay|te ngon cai|ong co tay)/.test(chatText(rawText))) {
    if (state.pain === "háng" || state.pain === "gối" || !state.pain) state.pain = "cổ tay";
    if (!state.disease && /ong co tay/.test(chatText(rawText))) state.disease = "hội chứng ống cổ tay";
  }
  if (painBeforeNumbness.primaryPain && painKey(painBeforeNumbness.primaryPain) !== "tay" && painKey(painBeforeNumbness.primaryPain) !== "co_tay" && painKey(painBeforeNumbness.primaryPain) !== "ngon_tay_cai") {
    state.pain = painBeforeNumbness.pain;
    state.primaryPain = painBeforeNumbness.primaryPain;
  }
  if (duration) state.duration = duration;
  if (trigger) state.trigger = trigger;
  if (radiation) state.radiation = radiation;
  if (treated) state.treated = treated;
  if (phoneNumber) state.phoneNumber = phoneNumber;
  if (customerName) state.customerName = customerName;
  if (appointmentTime) {
    state.appointmentTime = appointmentTime;
    state.wantsBooking = true;
  }

  if (yesNo && state.lastQuestion === "radiation") state.radiation = yesNo;
  if (yesNo && state.lastQuestion === "treated") state.treated = yesNo === "không" ? "chưa" : "có";

  if (!trigger && state.lastQuestion === "trigger") {
    const text = chatText(rawText);
    if (/di/.test(text)) state.trigger = "đi lại đau";
    if (/ngoi/.test(text)) state.trigger = "ngồi lâu đau";
    if (/tu nhien/.test(text)) state.trigger = "tự nhiên";
    if (/tap|gym|the thao/.test(text)) state.trigger = "vận động";
  }

  if (isPriceQuestion(rawText)) state.askedPrice = true;
  if (isAddressQuestion(rawText)) state.askedAddress = true;
  if (isBookingIntent(rawText)) state.wantsBooking = true;
  if (hasPhoneNumber(rawText)) state.hasPhone = true;
  const areaHint = detectAreaHint(rawText);
  if (areaHint) {
    state.areaHint = areaHint.area;
    if (areaHint.branch) state.preferredBranch = areaHint.branch;
  }

  const objection = detectObjection(rawText);
  if (objection) state.objection = objection;

  state.customerIntent = detectCustomerIntent(rawText, state);
  classifyLead(state);
}

function result(state, message, lastQuestion = "") {
  const clean = alignPronouns(state, message).trim();
  state.lastQuestion = lastQuestion;
  if (lastQuestion) state.askedFields.add(lastQuestion);
  return { action: "REPLY", message: clean };
}

function multiResult(state, messages, lastQuestion = "") {
  const cleanMessages = messages.map((message) => alignPronouns(state, message).trim()).filter(Boolean);
  state.lastQuestion = lastQuestion;
  if (lastQuestion) state.askedFields.add(lastQuestion);
  return { action: "REPLY", messages: cleanMessages, message: cleanMessages.join("\n") };
}

function handoff(reason = "") {
  if (reason) console.log("Silent handoff reason:", reason);
  return { action: "HANDOFF", message: "" };
}

function agenticProfile(state, customerText = "") {
  const pain = state.primaryPain || state.pain || "";
  const painRegion = painKey(pain);
  const missing = [];
  if (!pain && !state.disease) missing.push("pain");
  if ((pain || state.disease) && !state.duration && !state.askedFields.has("duration")) missing.push("duration");
  if (pain && !state.trigger && !state.askedFields.has("trigger")) missing.push("trigger");
  if ((painRegion === "lung" || painRegion === "vai" || painRegion === "vai_gay" || painRegion === "tay" || painRegion === "co_tay" || painRegion === "ngon_tay_cai") && !state.radiation && !state.askedFields.has("radiation")) {
    missing.push("radiation");
  }

  return {
    mode: "agentic_iva_v1",
    intent: detectCustomerIntent(customerText, state),
    pain,
    painRegion,
    disease: state.disease || "",
    duration: state.duration || "",
    trigger: state.trigger || "",
    radiation: state.radiation || "",
    askedPrice: Boolean(state.askedPrice || isPriceQuestion(customerText)),
    askedAddress: Boolean(state.askedAddress || isAddressQuestion(customerText)),
    humanTakeover: Boolean(state.humanTakeover),
    missing,
    canAssess: missing.filter((item) => item !== "radiation").length === 0 && (missing.indexOf("radiation") === -1 || state.askedFields.has("radiation")),
    canPrice: hasEnoughForPrice(state),
  };
}

function agenticDecisionSummary(state, customerText = "") {
  const directNeeds = [];
  if (isPriceQuestion(customerText)) directNeeds.push("price");
  if (isAddressQuestion(customerText)) directNeeds.push("address");
  if (isBookingIntent(customerText)) directNeeds.push("booking");
  if (hasPhoneNumber(customerText)) directNeeds.push("phone_handoff");
  if (isMixedHandLegNumbness(customerText)) directNeeds.push("separate_hand_leg_numbness");
  if (isSpecificDiseaseQuestion(customerText)) directNeeds.push("specific_disease");

  let chosenAction = "clinical_next_step";
  if (state.humanTakeover) chosenAction = "handoff_human_takeover";
  else if (directNeeds.includes("phone_handoff")) chosenAction = "handoff_phone";
  else if (directNeeds.includes("address") && directNeeds.includes("price")) chosenAction = "answer_address_and_price_if_ready";
  else if (directNeeds.includes("price") && hasEnoughForPrice(state)) chosenAction = "answer_price_offer";
  else if (directNeeds.includes("price")) chosenAction = "ask_one_missing_before_price";
  else if (directNeeds.includes("address")) chosenAction = "answer_address";
  else if (directNeeds.includes("booking")) chosenAction = "move_to_booking";
  else if (directNeeds.includes("separate_hand_leg_numbness")) chosenAction = "ask_which_numbness_stronger";
  else if (directNeeds.includes("specific_disease")) chosenAction = "answer_specific_disease";

  return {
    directNeeds,
    chosenAction,
    knownPain: state.primaryPain || state.pain || "",
    enoughForPrice: hasEnoughForPrice(state),
    customerEmotion: detectCustomerEmotion(customerText),
    leadHeat: estimateLeadHeat(state, customerText),
    shouldStop: Boolean(state.humanTakeover || hasPhoneNumber(customerText) || isCustomerEndingOrDeclining(customerText) || isScheduleChangeOrDelay(customerText)),
  };
}

function agenticMissingReply(state) {
  const profile = agenticProfile(state);
  if (profile.missing.includes("pain")) return askProblem(state);
  if (profile.missing.includes("duration")) return askDuration(state);
  if (profile.missing.includes("trigger")) return askTrigger(state);
  if (profile.missing.includes("radiation")) return askRadiation(state);
  return null;
}

function branchAddress(branch = "") {
  if (/bình|binh/i.test(branch)) return "Dạ cơ sở Bình Trưng bên em ở 94 Đường 56, Bình Trưng, TP.HCM ạ.";
  if (/hoàng|hoang|quốc|quoc/i.test(branch)) return "Dạ cơ sở Hoàng Quốc Việt bên em ở 33N Hoàng Quốc Việt, Tân Mỹ, TP.HCM ạ.";
  return CLINIC.address;
}

function bookingInfoReply(state) {
  if (!(state.bookingAsked || state.wantsBooking || state.priceSent || state.assessmentSent || state.preferredBranch || state.hasPhone)) return null;

  if (state.customerName && state.phoneNumber && state.appointmentTime && state.preferredBranch) {
    state.stage = "booking_confirmed";
    return result(state, `Dạ em xác nhận lịch cho ${state.customerName} ${state.appointmentTime} tại cơ sở ${state.preferredBranch} rồi ạ.`);
  }

  if (state.phoneNumber && state.appointmentTime && state.preferredBranch && !state.customerName) {
    state.stage = "booking_need_name";
    return result(state, "Dạ mình cho em xin tên để em giữ lịch ạ?", "name");
  }

  if (state.customerName && state.appointmentTime && state.preferredBranch && !state.phoneNumber) {
    state.stage = "booking_need_phone";
    return result(state, "Dạ mình cho em xin SĐT để em giữ lịch ạ?", "phone");
  }

  if (state.customerName && state.phoneNumber && state.preferredBranch && !state.appointmentTime) {
    state.stage = "booking_need_time";
    return result(state, "Dạ mình muốn qua khoảng mấy giờ ạ?", "appointment_time");
  }

  if (state.customerName && state.phoneNumber && state.appointmentTime && !state.preferredBranch) {
    state.stage = "booking_need_branch";
    return result(state, `Dạ ${CLINIC.branchAsk}`, "ask_branch");
  }

  return null;
}

function askProblem(state) {
  state.stage = "asking_problem";
  return result(state, "Dạ mình đang đau/mỏi phần nào ạ?", "problem");
}

function askWhichJoint(state) {
  state.stage = "asking_joint_area";
  return result(state, "Dạ mình đau khớp nào ạ?", "joint_area");
}

function outcomeQuestionReply(state, rawText = "") {
  const s = subject(state);
  state.stage = "answering_outcome";
  if (isNumbnessComplaint(rawText) || painKey(state.pain) === "co_tay" || painKey(state.pain) === "ngon_tay_cai" || painKey(state.pain) === "tay") {
    state.pain = state.pain || "cổ tay";
    state.radiation = state.radiation || "tay";
    if (!state.duration) {
      return result(state, "Dạ 5 buổi là gói hỗ trợ cải thiện ban đầu, mức phục hồi còn tùy nguyên nhân tê của mình. Mình bị tê đầu ngón tay lâu chưa ạ?", "duration");
    }
    state.assessmentSent = true;
    return result(state, `Dạ 5 buổi là gói hỗ trợ cải thiện ban đầu, mức phục hồi còn tùy nguyên nhân tê và mức độ của ${s}. Mình nên qua để bác sĩ kiểm tra kỹ hơn ạ.`);
  }
  if (!state.duration && (state.pain || state.disease)) {
    return result(state, `Dạ mức cải thiện còn tùy nguyên nhân và mức độ của ${s}. Tình trạng này mình bị lâu chưa ạ?`, "duration");
  }
  return result(state, `Dạ mức cải thiện còn tùy nguyên nhân và mức độ của ${s}. Mình nên qua để bác sĩ kiểm tra kỹ hơn ạ.`);
}

function customerCorrectionReply(state, rawText = "") {
  const text = chatText(rawText);
  const s = subject(state);
  if (/(xl|xin loi|bam nham|nham)/.test(text)) return handoff("manual correction/apology needs human");
  if (isNumbnessComplaint(rawText) || /khong phai dau|ko phai dau|k phai dau|te chu/.test(text)) {
    state.pain = "cổ tay";
    state.radiation = "tay";
    state.stage = "customer_corrected_numbness";
    if (!state.duration) return result(state, "Dạ em hiểu rồi ạ, mình là tê đầu ngón tay chứ không phải đau. Mình bị tê lâu chưa ạ?", "duration");
    state.assessmentSent = true;
    return result(state, `Dạ em hiểu rồi ạ, mình là tê đầu ngón tay. Dấu hiệu này có thể liên quan ống cổ tay hoặc chèn ép thần kinh vùng cổ tay, ${s} nên qua để bác sĩ kiểm tra kỹ hơn ạ.`);
  }
  return handoff("customer corrected bot but meaning unclear");
}

function askDuration(state) {
  if (state.duration || state.askedFields.has("duration")) return askTrigger(state);
  state.stage = "asking_duration";
  return result(state, durationQuestion(state), "duration");
}

function askTrigger(state) {
  if (state.trigger || state.askedFields.has("trigger")) {
    return needsRadiationQuestion(state) ? askRadiation(state) : assessmentReply(state);
  }
  state.stage = "asking_trigger";
  return result(state, triggerQuestion(state), "trigger");
}

function needsRadiationQuestion(state) {
  return (
    state.pain === "lưng" ||
    state.pain === "vai" ||
    state.pain === "vai gáy" ||
    state.pain === "ngón tay cái" ||
    state.pain === "cổ tay" ||
    /(tọa|thoát vị|cổ)/.test(state.disease || "")
  );
}

function askRadiation(state) {
  if (!needsRadiationQuestion(state)) return assessmentReply(state);
  if (state.radiation || state.askedFields.has("radiation")) return assessmentReply(state);
  state.stage = "asking_radiation";
  const s = subject(state);
  if (state.pain === "lưng" || /(tọa|thoát vị)/.test(state.disease)) {
    return result(state, `Dạ ${s} có đau lan xuống mông, chân hoặc tê chân không ạ?`, "radiation");
  }
  if (state.pain === "vai" || state.pain === "vai gáy" || /cổ/.test(state.disease)) {
    return result(state, `Dạ ${s} có đau lan xuống tay hoặc tê tay không ạ?`, "radiation");
  }
  if (state.pain === "ngón tay cái") {
    return result(state, `Dạ ${s} cầm nắm hoặc gập duỗi ngón cái có đau hơn không ạ?`, "radiation");
  }
  if (state.pain === "cổ tay") {
    return result(state, `Dạ ${s} xoay cổ tay hoặc cầm nắm có đau hơn không ạ?`, "radiation");
  }
  if (state.pain === "tay") {
    return result(state, `Dạ ${s} còn đau khi cầm nắm hoặc xoay tay không ạ?`, "radiation");
  }
  return assessmentReply(state);
}

function diseaseLabel(state) {
  const noRadiation = state.radiation === "không";
  const hasRadiation = state.radiation && state.radiation !== "không";
  const longTime = /(thang|nam)/.test(normalizeText(state.duration));
  const sport = /(tap|gym|the thao|van dong)/.test(normalizeText(state.trigger));

  const clinicalPain = state.primaryPain || state.pain;
  const clinicalPainKey = painKey(clinicalPain);
  if (state.disease) return state.disease;
  if (clinicalPainKey === "lung" && hasRadiation) return "thoát vị đĩa đệm thắt lưng hoặc đau thần kinh tọa";
  if (clinicalPainKey === "lung" && (noRadiation || sport)) return sport ? "căng cơ vùng thắt lưng hoặc vấn đề cột sống thắt lưng nhẹ" : "vấn đề cột sống thắt lưng";
  if (clinicalPainKey === "lung") return longTime ? "vấn đề cột sống thắt lưng" : "căng cơ hoặc vấn đề cột sống thắt lưng";
  if ((clinicalPainKey === "vai" || clinicalPainKey === "vai_gay") && hasRadiation) return "thoái hóa đốt sống cổ hoặc chèn ép rễ thần kinh";
  if (clinicalPainKey === "vai" || clinicalPainKey === "vai_gay") return longTime ? "căng cơ vùng vai gáy hoặc vấn đề đốt sống cổ" : "căng cơ vùng vai gáy";
  if (clinicalPainKey === "goi") return "vấn đề khớp gối";
  if (clinicalPainKey === "hang") return "vấn đề khớp háng";
  if (clinicalPainKey === "co_tay") return hasRadiation ? "viêm gân hoặc vấn đề khớp cổ tay" : "vấn đề cơ gân vùng cổ tay";
  if (clinicalPainKey === "ngon_tay_cai") return hasRadiation ? "viêm gân hoặc vấn đề khớp vùng ngón cái" : "vấn đề gân/khớp vùng ngón cái";
  if (clinicalPainKey === "tay") return sport ? "căng cơ/gân vùng tay do vận động" : "vấn đề cơ gân vùng tay";
  if (state.pain === "lưng" && hasRadiation) return "thoát vị đĩa đệm thắt lưng hoặc đau thần kinh tọa";
  if (state.pain === "lưng" && (noRadiation || sport)) return sport ? "căng cơ vùng thắt lưng hoặc vấn đề cột sống thắt lưng nhẹ" : "vấn đề cột sống thắt lưng";
  if (state.pain === "lưng") return longTime ? "vấn đề cột sống thắt lưng" : "căng cơ hoặc vấn đề cột sống thắt lưng";
  if ((state.pain === "vai" || state.pain === "vai gáy") && hasRadiation) return "thoái hóa đốt sống cổ hoặc chèn ép rễ thần kinh";
  if (state.pain === "vai" || state.pain === "vai gáy") return longTime ? "căng cơ vùng vai gáy hoặc vấn đề đốt sống cổ" : "căng cơ vùng vai gáy";
  if (state.pain === "gối") return "vấn đề khớp gối";
  if (state.pain === "háng") return "vấn đề khớp háng";
  if (state.pain === "ngón tay cái") return hasRadiation ? "viêm gân hoặc vấn đề khớp vùng ngón cái" : "vấn đề gân/khớp vùng ngón cái";
  if (state.pain === "cổ tay") return hasRadiation ? "viêm gân hoặc vấn đề khớp cổ tay" : "vấn đề cơ gân vùng cổ tay";
  if (state.pain === "tay") return sport ? "căng cơ/gân vùng tay do vận động" : "vấn đề cơ gân vùng tay";
  return "";
}

function assessmentReply(state) {
  if (state.assessmentSent) return handoff("assessment already sent");
  const missingReply = agenticMissingReply(state);
  if (missingReply) return missingReply;

  const s = subject(state);
  const likely = diseaseLabel(state);
  state.assessmentSent = true;
  state.stage = "assessed";

  if (!likely) return handoff("no likely label");
  return result(state, `Dạ dấu hiệu này có thể nghiêng về ${likely}. ${s} nên qua để bác sĩ kiểm tra kỹ hơn ạ.`);
}

function specificDiseaseReply(state) {
  if (state.specificDiseaseAnswered) return handoff("specific disease already answered");
  const s = subject(state);
  const likely = diseaseLabel(state);
  state.specificDiseaseAnswered = true;
  state.assessmentSent = true;
  state.stage = "specific_disease_answered";

  if (!likely) return handoff("no disease label for specific question");
  return result(state, `Dạ hiện tại em chỉ nhận định sơ bộ là nghiêng về ${likely}. ${s} qua bác sĩ kiểm tra sẽ rõ mức độ hơn ạ.`);
}

function priceReply(state) {
  if (!hasEnoughForPrice(state)) return priceNeedInfoReply(state);
  if (!state.assessmentSent) {
    state.assessmentSent = true;
    const likely = diseaseLabel(state);
    state.priceSent = true;
    state.stage = "price_presented";
    const messages = [];
    if (likely) messages.push(`Dạ dấu hiệu này có thể nghiêng về ${likely}. ${subject(state)} nên qua để bác sĩ kiểm tra kỹ hơn ạ.`);
    messages.push(`${CLINIC.price} ${CLINIC.priceClose}`);
    return multiResult(state, messages);
  }
  if (state.priceSent) return bookingReply(state);
  state.priceSent = true;
  state.stage = "price_presented";
  return result(state, `${CLINIC.price} ${CLINIC.priceClose}`);
}

function priceNeedInfoReply(state) {
  state.stage = "price_need_info";
  const s = subject(state);

  if (!state.pain && !state.disease) {
    if (state.sentQuestionKeys.has("ask_price_problem") || state.sentQuestionKeys.has("ask_problem_location")) {
      return result(state, "Dạ em cần nắm vùng mình đang đau trước rồi mới báo đúng ưu đãi được ạ.");
    }
    return result(state, "Dạ để em báo đúng phần ưu đãi, mình đang đau/mỏi phần nào ạ?", "price_problem");
  }

  if (state.disease && !state.treated) {
    return result(state, `Dạ để em tư vấn sát hơn, ${s} đã điều trị phương pháp nào chưa ạ?`, "price_treated");
  }

  if (!state.duration) {
    if (state.sentQuestionKeys.has("ask_duration")) {
      return result(state, "Dạ em cần nắm mình đau lâu chưa trước rồi mới báo sát phần ưu đãi được ạ.");
    }
    if (state.disease) return result(state, `Dạ ${s} bị lâu chưa ạ?`, "price_duration");
    return result(state, `Dạ ${s} đau ${state.pain || "phần này"} lâu chưa ạ?`, "price_duration");
  }

  if (!state.trigger && state.pain === "vai gáy") {
    if (state.sentQuestionKeys.has("ask_trigger")) {
      return result(state, "Dạ em cần nắm thêm lúc nào mình đau/mỏi hơn rồi mới báo sát phần ưu đãi được ạ.");
    }
    return result(state, `Dạ ${s} ngồi lâu hoặc dùng điện thoại có nhanh mỏi hơn không ạ?`, "price_trigger");
  }

  if (!state.trigger && state.pain === "lưng") {
    if (state.sentQuestionKeys.has("ask_trigger")) {
      return result(state, "Dạ em cần nắm thêm lúc nào mình đau hơn rồi mới báo sát phần ưu đãi được ạ.");
    }
    return result(state, `Dạ ${s} ngồi lâu hoặc đi lại có thấy đau hơn không ạ?`, "price_trigger");
  }

  if (!state.trigger) {
    if (state.sentQuestionKeys.has("ask_trigger")) {
      return result(state, "Dạ em cần nắm thêm lúc nào mình đau hơn rồi mới báo sát phần ưu đãi được ạ.");
    }
    return result(state, `Dạ phần này mình thấy đau hơn khi cử động hay lúc nghỉ cũng đau ạ?`, "price_trigger");
  }

  if (!state.radiation && (state.pain === "vai" || state.pain === "vai gáy")) {
    if (state.sentQuestionKeys.has("ask_arm_radiation")) {
      return result(state, "Dạ em cần nắm thêm có lan/tê tay không rồi mới báo sát phần ưu đãi được ạ.");
    }
    return result(state, `Dạ ${s} có đau lan xuống tay hoặc tê tay không ạ?`, "price_radiation");
  }

  if (!state.radiation && state.pain === "lưng") {
    if (state.sentQuestionKeys.has("ask_leg_radiation")) {
      return result(state, "Dạ em cần nắm thêm có lan/tê chân không rồi mới báo sát phần ưu đãi được ạ.");
    }
    return result(state, `Dạ ${s} có đau lan xuống mông, chân hoặc tê chân không ạ?`, "price_radiation");
  }

  return handoff("price asked but missing unclear info");
}

function costProcessReply(state) {
  state.stage = "cost_process_answered";
  const answer = "Dạ sau khi khám bác sĩ sẽ trao đổi rõ lộ trình và chi phí, mình đồng ý thì mình làm ạ.";
  if (hasEnoughForPrice(state) || state.assessmentSent) return result(state, answer);
  const question = nextQuestionTextBeforePrice(state);
  return multiResult(state, [answer, question], messageQuestionKey(question) || "cost_process_followup");
}

function priceAndAddressReply(state) {
  state.addressSent = true;
  state.stage = "price_and_address_sent";
  if (!hasEnoughForPrice(state)) {
    const question = nextQuestionTextBeforePrice(state);
    return multiResult(state, [CLINIC.address, question], messageQuestionKey(question) || "price_followup");
  }
  state.priceSent = true;
  const likely = !state.assessmentSent ? diseaseLabel(state) : "";
  state.assessmentSent = true;
  const messages = [];
  if (likely) messages.push(`Dạ dấu hiệu này có thể nghiêng về ${likely}. ${subject(state)} nên qua để bác sĩ kiểm tra kỹ hơn ạ.`);
  messages.push(CLINIC.price);
  messages.push(CLINIC.address);
  return multiResult(state, messages);
}

function priceAndBookingReply(state, rawText = "") {
  if (!hasEnoughForPrice(state)) return priceNeedInfoReply(state);

  state.priceSent = true;
  state.assessmentSent = true;
  state.bookingAsked = true;
  state.stage = "price_then_booking";

  const text = chatText(rawText);
  const day = /ngay mai|mai/.test(text) ? "mai" : "hôm nay";
  return multiResult(state, [CLINIC.price, `Dạ ${day} mình qua được ạ. ${CLINIC.branchAsk}`], "ask_branch");
}

function addressAndBookingReply(state, rawText = "") {
  state.addressSent = true;
  state.bookingAsked = true;
  state.stage = "address_then_booking";
  const text = chatText(rawText);
  const day = /ngay mai|mai/.test(text) ? "mai" : "hôm nay";
  return multiResult(state, [CLINIC.address, `Dạ ${day} mình qua được ạ. ${CLINIC.branchAsk}`], "ask_branch");
}

function hasEnoughForPrice(state) {
  if (state.assessmentSent && (state.pain || state.disease)) return true;

  if (state.disease) {
    return Boolean(state.duration && (state.treated || state.radiation));
  }

  if (!state.pain && !state.primaryPain) return false;
  const clinicalPainKey = painKey(state.primaryPain || state.pain);
  if (clinicalPainKey === "lung" || clinicalPainKey === "vai" || clinicalPainKey === "vai_gay") {
    return Boolean(state.duration && state.trigger && state.radiation);
  }
  if (clinicalPainKey === "ngon_tay_cai" || clinicalPainKey === "co_tay" || clinicalPainKey === "tay") {
    return Boolean(state.duration && state.trigger && state.radiation);
  }
  if (clinicalPainKey === "goi" || clinicalPainKey === "hang") {
    return Boolean(state.duration && state.trigger);
  }

  if (!state.pain) return false;
  if (state.pain === "lưng" || state.pain === "vai" || state.pain === "vai gáy") {
    return Boolean(state.duration && state.trigger && state.radiation);
  }

  if (state.pain === "ngón tay cái" || state.pain === "cổ tay") {
    return Boolean(state.duration && state.trigger && state.radiation);
  }

  if (state.pain === "gối" || state.pain === "háng" || state.pain === "tay") {
    return Boolean(state.duration && state.trigger);
  }

  return Boolean(state.duration && state.trigger);
}

function nextClinicalQuestionBeforePrice(state) {
  if (!state.pain && !state.disease) return askProblem(state);
  if (state.disease) return knownDiseaseFlow(state, "");
  return symptomFlow(state);
}

function nextQuestionTextBeforePrice(state) {
  const s = subject(state);
  if (!state.pain && !state.disease) return "Mình đang cần hỗ trợ đau/mỏi phần nào ạ?";
  if (state.disease && !state.treated) return `${capitalizeFirst(s)} đã điều trị phương pháp nào chưa ạ?`;
  if (!state.duration) {
    if (state.disease) return `${capitalizeFirst(s)} bị lâu chưa ạ?`;
    return `${capitalizeFirst(s)} đau ${state.pain || "phần này"} lâu chưa ạ?`;
  }
  if (!state.trigger && state.pain === "vai gáy") return `${capitalizeFirst(s)} ngồi lâu hoặc dùng điện thoại có nhanh mỏi hơn không ạ?`;
  if (!state.trigger && state.pain === "lưng") return `${capitalizeFirst(s)} ngồi lâu hoặc đi lại có thấy đau hơn không ạ?`;
  if (!state.trigger && state.pain === "ngón tay cái") return `${capitalizeFirst(s)} cầm nắm hoặc gập duỗi ngón cái có đau hơn không ạ?`;
  if (!state.trigger && state.pain === "cổ tay") return `${capitalizeFirst(s)} xoay cổ tay hoặc cầm nắm có đau hơn không ạ?`;
  if (!state.trigger) return `Phần này mình thấy đau hơn khi cử động hay lúc nghỉ cũng đau ạ?`;
  if (!state.radiation && (state.pain === "vai" || state.pain === "vai gáy")) return `${capitalizeFirst(s)} có đau lan xuống tay hoặc tê tay không ạ?`;
  if (!state.radiation && state.pain === "lưng") return `${capitalizeFirst(s)} có đau lan xuống mông, chân hoặc tê chân không ạ?`;
  if (!state.radiation && state.pain === "ngón tay cái") return `${capitalizeFirst(s)} cầm nắm hoặc gập duỗi ngón cái có đau hơn không ạ?`;
  if (!state.radiation && state.pain === "cổ tay") return `${capitalizeFirst(s)} xoay cổ tay hoặc cầm nắm có đau hơn không ạ?`;
  return "Mình tiện qua hôm nay hay ngày mai ạ?";
}

function questionToKey(question) {
  return messageQuestionKey(question).replace(/^ask_/, "") || "";
}

function addressReply(state) {
  state.addressSent = true;
  state.stage = "address_sent";
  if (state.preferredBranch) {
    return result(state, branchAddress(state.preferredBranch));
  }
  if (state.assessmentSent || state.wantsBooking || state.priceSent) {
    return multiResult(state, [CLINIC.address, CLINIC.addressAsk], "ask_branch");
  }
  return multiResult(
    state,
    [
      CLINIC.address,
      CLINIC.branchAsk,
    ],
    "branch_distance",
  );
}

function bookingReply(state, rawText = "") {
  const bookingStatus = bookingInfoReply(state);
  if (bookingStatus) return bookingStatus;

  if (state.hasPhone) {
    state.stage = "phone_captured";
    if (!state.preferredBranch) return result(state, `Dạ em nhận được SĐT rồi ạ. ${CLINIC.branchAsk}`);
    if (!state.appointmentTime) return result(state, "Dạ em nhận được SĐT rồi ạ. Mình muốn qua khoảng mấy giờ ạ?", "appointment_time");
    if (!state.customerName) return result(state, "Dạ em nhận được SĐT rồi ạ. Mình cho em xin tên để em giữ lịch ạ?", "name");
  }

  if (!state.bookingAsked) {
    state.bookingAsked = true;
    state.stage = "booking_branch";
    const text = chatText(rawText);
    const day = /ngay mai|mai/.test(text) ? "mai" : "hôm nay";
    return result(state, `Dạ ${day} mình qua được ạ. ${CLINIC.branchAsk}`);
  }

  state.stage = "booking_phone";
  return result(state, "Dạ mình cho em xin tên và SĐT để em giữ lịch cho mình ạ?");
}

function knownDiseaseFlow(state, customerText) {
  const s = subject(state);

  if (isMethodQuestion(customerText)) {
    return result(state, `${CLINIC.methods} ${s} đã điều trị phương pháp nào chưa ạ?`, "treated");
  }

  if (!state.treated && !state.askedFields.has("treated")) {
    return result(state, `Dạ ${s} đã điều trị phương pháp nào chưa ạ?`, "treated");
  }
  if (!state.duration) return askDuration(state);
  if (!state.radiation) return askRadiation(state);
  if (state.askedPrice) return priceReply(state);
  return assessmentReply(state);
}

function symptomFlow(state) {
  if (!state.duration) return askDuration(state);
  if (!state.trigger) return askTrigger(state);
  if (needsRadiationQuestion(state) && !state.radiation) return askRadiation(state);
  if (state.askedPrice) return priceReply(state);
  return assessmentReply(state);
}

function handleDeterministicFlow(senderId, customerText) {
  const state = getCustomerState(senderId);
  state.messageCount += 1;
  updateStateFromText(state, customerText);
  const currentPain = detectExplicitPain(customerText) || (!state.primaryPain ? detectPain(customerText) : "");
  const currentDisease = detectDisease(customerText);
  const currentArea = detectAreaHint(customerText);

  if (isCustomerEndingOrDeclining(customerText)) {
    lockChatKey(senderId, "customer ended/declined inside deterministic flow", customerText);
    return handoff("customer ended/declined");
  }
  if (isCustomerReplyingToHumanPrice(customerText, state)) {
    lockChatKey(senderId, "customer replied to human price inside deterministic flow", customerText);
    return handoff("customer replied to human price");
  }
  if (isOutOfScopeQuestion(customerText)) return handoff("out of scope needs human");
  if (isScheduleChangeOrDelay(customerText)) return handoff("schedule change/delay needs human");
  if (isMixedHandLegNumbness(customerText) && !state.primaryPain) {
    state.stage = "separate_hand_leg_numbness";
    return result(state, "Dạ mình thấy tê tay nhiều hơn hay tê chân nhiều hơn ạ?", "ask_mixed_numbness");
  }
  if (hasPhoneNumber(customerText)) {
    lockChatKey(senderId, "phone received inside deterministic flow - human follow up only", customerText);
    return handoff("phone received - human follow up only");
  }
  if (isCustomerCorrection(customerText)) return customerCorrectionReply(state, customerText);
  if (isOutcomeQuestion(customerText)) return outcomeQuestionReply(state, customerText);
  if (isUnclearJointComplaint(customerText) && !state.pain) return askWhichJoint(state);
  if (
    isBranchChoice(customerText) &&
    !currentPain &&
    !currentDisease &&
    !isPriceQuestion(customerText) &&
    !isAddressQuestion(customerText) &&
    (!isBookingIntent(customerText) || state.bookingAsked || state.wantsBooking || state.priceSent || state.assessmentSent)
  ) {
    return branchChoiceReply(state, customerText);
  }
  if (currentArea && !currentPain && !currentDisease && !isPriceQuestion(customerText) && !isBookingIntent(customerText)) {
    return areaReply(state);
  }
  if (isPriceQuestion(customerText) && isBookingIntent(customerText)) return priceAndBookingReply(state, customerText);
  if (isPriceQuestion(customerText) && isAddressQuestion(customerText)) return priceAndAddressReply(state);
  if (isAddressQuestion(customerText) && isBookingIntent(customerText)) return addressAndBookingReply(state, customerText);
  if (isCostProcessQuestion(customerText)) return costProcessReply(state);
  if (isBookingIntent(customerText)) return bookingReply(state, customerText);
  if (isAddressQuestion(customerText)) return addressReply(state);
  if (isSpecificDiseaseQuestion(customerText)) return specificDiseaseReply(state);
  if (isMethodQuestion(customerText)) return result(state, CLINIC.methods);

  if (isPriceQuestion(customerText)) {
    return priceReply(state);
  }

  if (state.objection === "busy") {
    state.stage = "soft_close_busy";
    return result(state, "Dạ không sao ạ, khi nào mình sắp xếp được em giữ ưu đãi phù hợp cho mình nhé.");
  }

  if (isPing(customerText)) {
    if (state.lastQuestion === "duration") return askDuration(state);
    if (state.lastQuestion === "trigger") return askTrigger(state);
    if (state.lastQuestion === "radiation") return askRadiation(state);
    return askProblem(state);
  }

  if (state.disease) return knownDiseaseFlow(state, customerText);
  if (state.pain) return symptomFlow(state);

  return null;
}

function responseGuard(state, ai) {
  if (!ai || ai.action !== "REPLY") return ai;
  const messages = Array.isArray(ai.messages) ? ai.messages : [ai.message].filter(Boolean);
  if (!messages.length) return handoff("empty reply");

  const guardedMessages = [];
  for (const rawMessage of messages) {
    const guarded = responseGuardSingle(state, rawMessage);
    if (guarded.action !== "REPLY" || !guarded.message) return guarded;
    guardedMessages.push(guarded.message);
  }

  return { action: "REPLY", messages: guardedMessages, message: guardedMessages.join("\n") };
}

function messageFingerprint(message = "") {
  return normalizeText(message).slice(0, 180);
}

function isPriceOfferMessage(message = "") {
  const text = normalizeText(message);
  return /(499|189|800|uu dai|5 buoi|nam buoi|phi kham|chi phi|gia goc|ho tro 100|mien phi kham|khong ton phi|dat lich online)/.test(text);
}

function isAddressAnswerMessage(message = "") {
  const text = normalizeText(message);
  return /(33n|hoang quoc viet|94 duong 56|binh trung|chi nhanh 1|chi nhanh 2|co so 1|co so 2)/.test(text);
}

function diagnosisRegionKeys(message = "") {
  const text = normalizeText(message);
  const regions = new Set();

  if (/(khop hang|dau hang|vung hang|\bhang\b)/.test(text)) regions.add("hang");
  if (/(khop goi|dau goi|vung goi|thoai hoa khop goi)/.test(text)) regions.add("goi");
  if (/(cot song that lung|that lung|thoat vi dia dem|than kinh toa|te chan|xuong mong|xuong chan)/.test(text)) regions.add("lung");
  if (/(dot song co|cot song co|thoai hoa dot song co|chen ep re than kinh|vai gay|vung vai gay|cang co vung vai gay)/.test(text)) regions.add("vai_gay");
  if (/(co tay|ngon tay|ngon cai|ong co tay|vung tay|dau tay|te tay)/.test(text)) regions.add("tay");

  return regions;
}

function allowedDiagnosisRegionsForPain(state) {
  const currentPainKey = painKey(state.primaryPain || state.pain);
  if (currentPainKey === "lung") return new Set(["lung"]);
  if (currentPainKey === "vai" || currentPainKey === "vai_gay") return new Set(["vai_gay", "tay"]);
  if (currentPainKey === "goi") return new Set(["goi"]);
  if (currentPainKey === "hang") return new Set(["hang"]);
  if (currentPainKey === "ngon_tay_cai" || currentPainKey === "co_tay" || currentPainKey === "tay") return new Set(["tay"]);
  return new Set();
}

function diagnosisRegionConflictReason(state, message = "") {
  const lockedPain = state.primaryPain || state.pain;
  if (!lockedPain) return "";
  const mentionedRegions = diagnosisRegionKeys(message);
  if (!mentionedRegions.size) return "";

  const allowedRegions = allowedDiagnosisRegionsForPain(state);
  if (!allowedRegions.size) return "";

  const wrongRegions = [...mentionedRegions].filter((region) => !allowedRegions.has(region));
  if (!wrongRegions.length) return "";

  return `blocked diagnosis region mismatch: pain=${painKey(lockedPain)} replyRegions=${[...mentionedRegions].join(",")}`;
}

function isClinicalQuestionMessage(message = "") {
  const text = normalizeText(message);
  return /(dau .* lau chua|lau chua|bao lau|ngoi lau|dung dien thoai|di lai|van dong|tu nhien|lan xuong|te tay|te chan|cam nam|gap duoi|xoay co tay|dau khop nao|dau phan nao|dau moi phan nao)/.test(text);
}

function customerAskedTwoOrMoreClosingIntents(customerText = "") {
  let count = 0;
  if (isPriceQuestion(customerText)) count += 1;
  if (isAddressQuestion(customerText)) count += 1;
  if (isBookingIntent(customerText)) count += 1;
  if (hasPhoneNumber(customerText)) count += 1;
  return count >= 2;
}

function selfCheckReplyAgainstCustomerIntent(state, customerText = "", combinedReply = "", stateBeforeReply = {}) {
  const reply = normalizeText(combinedReply);
  const customer = chatText(customerText);
  const askedPriceNow = isPriceQuestion(customerText);
  const askedAddressNow = isAddressQuestion(customerText);
  const askedBookingNow = isBookingIntent(customerText);
  const enoughForPriceNow = hasEnoughForPrice(state) || stateBeforeReply.assessmentSent;

  if (/te tay chan|te chan tay|tay chan deu te|te ca tay va chan/.test(customer)) {
    if (!/(tay nhieu hon|chan nhieu hon|te tay nhieu hon|te chan nhieu hon)/.test(reply)) {
      return "agentic self-check: numbness in both hand/leg must ask which side is stronger";
    }
  }

  if (askedPriceNow && enoughForPriceNow && !/(499|uu dai|chi phi|lo trinh|sau khi kham)/.test(reply)) {
    return "agentic self-check: customer asked price after enough info but reply did not answer price";
  }

  if (askedPriceNow && enoughForPriceNow && isClinicalQuestionMessage(combinedReply)) {
    return "agentic self-check: asked clinical question after price-ready customer";
  }

  if (askedAddressNow && !isAddressAnswerMessage(combinedReply)) {
    return "agentic self-check: customer asked address but reply did not answer address";
  }

  if (askedBookingNow && !/(chi nhanh 1|chi nhanh 2|hoang quoc viet|binh trung|ten|sdt|so dien thoai|giu lich|qua duoc|may gio|lich)/.test(reply)) {
    return "agentic self-check: customer asked booking but reply did not move to booking";
  }

  if (customerAskedTwoOrMoreClosingIntents(customerText)) {
    if (askedPriceNow && enoughForPriceNow && !/(499|uu dai|chi phi|lo trinh|sau khi kham)/.test(reply)) return "agentic self-check: missed price in multi-intent customer message";
    if (askedAddressNow && !isAddressAnswerMessage(combinedReply)) return "agentic self-check: missed address in multi-intent customer message";
    if (askedBookingNow && !/(chi nhanh|ten|sdt|giu lich|may gio|qua duoc)/.test(reply)) return "agentic self-check: missed booking in multi-intent customer message";
  }

  if ((state.priceSent || stateBeforeReply.priceSent) && /(499|uu dai|chi phi|lo trinh)/.test(reply) && !askedPriceNow) {
    return "agentic self-check: repeated price without customer asking price";
  }

  if ((state.assessmentSent || stateBeforeReply.assessmentSent) && /dau hieu nay co the nghieng ve/.test(reply) && !isSpecificDiseaseQuestion(customerText) && !askedPriceNow) {
    return "agentic self-check: repeated assessment while customer moved to another intent";
  }

  return "";
}

function scoreReplyQuality(state, customerText = "", combinedReply = "", stateBeforeReply = {}) {
  const issues = [];
  let score = 10;
  const reply = normalizeText(combinedReply);
  const customer = chatText(customerText);

  if (!combinedReply || !reply) {
    return { score: 0, issues: ["empty_reply"] };
  }
  if (combinedReply.length > 190) {
    score -= 2;
    issues.push("too_long");
  }
  if (/\bban\b|quy khach|tinh trang cu the|vi tri nao|dau o dau/.test(reply)) {
    score -= 3;
    issues.push("robotic_wording");
  }
  if (state.lastBotMessage && normalizeText(state.lastBotMessage) === reply) {
    score -= 5;
    issues.push("duplicate_last_bot");
  }
  const questionKey = messageQuestionKey(combinedReply);
  if (questionKey && state.sentQuestionKeys?.has?.(questionKey)) {
    score -= 5;
    issues.push(`repeat_question_${questionKey}`);
  }
  if (diagnosisRegionConflictReason(state, combinedReply)) {
    score -= 6;
    issues.push("wrong_region");
  }
  if ((isPriceQuestion(customerText) || /gia|chi phi|bao nhieu|bn|dat/.test(customer)) && (hasEnoughForPrice(state) || stateBeforeReply.assessmentSent) && !/(499|uu dai|chi phi|lo trinh|sau khi kham)/.test(reply)) {
    score -= 5;
    issues.push("missed_price_answer");
  }
  if (isAddressQuestion(customerText) && !isAddressAnswerMessage(combinedReply)) {
    score -= 5;
    issues.push("missed_address_answer");
  }
  if (isBookingIntent(customerText) && !/(chi nhanh|ten|sdt|so dien thoai|giu lich|may gio|qua duoc|lich)/.test(reply)) {
    score -= 4;
    issues.push("missed_booking_signal");
  }
  if (detectCustomerEmotion(customerText) === "kho_chiu" && isClinicalQuestionMessage(combinedReply)) {
    score -= 4;
    issues.push("asked_more_when_customer_unhappy");
  }

  return { score: Math.max(0, Math.min(10, score)), issues };
}

function finalReplyGate(chatKey, pageId, senderId, customerText, messages, stateBeforeReply = {}) {
  const state = getCustomerState(chatKey);
  if (!state.sentMessageFingerprints) state.sentMessageFingerprints = new Set();

  const combined = messages.join("\n");
  const combinedText = normalizeText(combined);
  const customer = chatText(customerText);
  const askedAddressNow = isAddressQuestion(customerText);
  const askedPriceNow = isPriceQuestion(customerText);
  const hasPriceOffer = messages.some(isPriceOfferMessage);

  const intentMismatch = selfCheckReplyAgainstCustomerIntent(state, customerText, combined, stateBeforeReply);
  if (intentMismatch) {
    return { ok: false, reason: `final gate: ${intentMismatch}` };
  }
  const quality = scoreReplyQuality(state, customerText, combined, stateBeforeReply);
  if (quality.score < 7) {
    return { ok: false, reason: `final gate: low reply quality ${quality.score}/10 ${quality.issues.join(",")}` };
  }

  if (isHumanTakenOver(chatKey) || state.humanTakeover) {
    return { ok: false, reason: "final gate: human takeover" };
  }

  if (isCustomerEndingOrDeclining(customerText)) {
    lockConversation(pageId, senderId, "final gate: customer ended/declined", customerText);
    return { ok: false, reason: "final gate: customer ended/declined" };
  }

  if (isCustomerReplyingToHumanPrice(customerText, stateBeforeReply)) {
    lockConversation(pageId, senderId, "final gate: customer replied to human price", customerText);
    return { ok: false, reason: "final gate: customer replied to human price" };
  }

  if (askedAddressNow && !isAddressAnswerMessage(combined)) {
    return { ok: false, reason: "final gate: customer asked address but reply has no address" };
  }

  if (hasPriceOffer) {
    if (stateBeforeReply.priceSent) return { ok: false, reason: "final gate: repeated price" };
    if (!askedPriceNow && !isBookingIntent(customerText) && !stateBeforeReply.askedPrice) {
      return { ok: false, reason: "final gate: price without customer price/booking intent" };
    }
  }

  if (/gia goc|800|189|phi kham|chi kham thoi|khong ton phi/.test(customer) && hasPriceOffer) {
    lockConversation(pageId, senderId, "final gate: human price thread detected", customerText);
    return { ok: false, reason: "final gate: human price thread detected" };
  }

  const diagnosisConflict = diagnosisRegionConflictReason(state, combined);
  if (diagnosisConflict) {
    return { ok: false, reason: `final gate: ${diagnosisConflict}` };
  }

  for (const message of messages) {
    const fp = messageFingerprint(message);
    if (fp && state.sentMessageFingerprints.has(fp)) {
      return { ok: false, reason: "final gate: repeated exact/near message" };
    }
    const questionKey = messageQuestionKey(message);
    if (questionKey && state.sentQuestionKeys.has(questionKey)) {
      return { ok: false, reason: `final gate: repeated question ${questionKey}` };
    }
  }

  if (state.pain && /(minh dang bi dau phan nao|minh dau phan nao|dau vung nao|dau o dau|vi tri nao)/.test(combinedText)) {
    return { ok: false, reason: "final gate: asked pain again after known pain" };
  }

  if (state.duration && /(lau chua|bao lau|keo dai bao lau)/.test(combinedText)) {
    return { ok: false, reason: "final gate: asked duration again after known duration" };
  }

  return { ok: true, reason: "" };
}

function painKey(value = "") {
  const text = normalizeText(value);
  if (/lung|that lung|song lung/.test(text)) return "lung";
  if (/vai gay|co vai gay|co gay/.test(text)) return "vai_gay";
  if (/vai/.test(text)) return "vai";
  if (/goi|khop goi/.test(text)) return "goi";
  if (/ngon tay cai|ngon cai/.test(text)) return "ngon_tay_cai";
  if (/co tay/.test(text)) return "co_tay";
  if (/tay/.test(text)) return "tay";
  if (/(khop hang|dau hang|vung hang|\bhang\b)/.test(text)) return "hang";
  return text;
}

function responseGuardSingle(state, rawMessage) {
  const message = rawMessage.trim();
  const textValue = normalizeText(message);
  const lastText = normalizeText(state.lastBotMessage || "");
  const questionKey = messageQuestionKey(message);
  const currentPainKey = painKey(state.primaryPain || state.pain);
  const diagnosisConflict = diagnosisRegionConflictReason(state, message);
  if (diagnosisConflict) return handoff(diagnosisConflict);

  if (currentPainKey === "lung" && /(te tay|xuong tay|canh tay|co vai gay|vai gay)/.test(textValue)) {
    return handoff("blocked wrong region: back reply mentioned neck/hand");
  }

  if (currentPainKey === "lung" && /(khop goi|van de khop goi|goi)/.test(textValue)) {
    return handoff("blocked wrong diagnosis: back cannot become knee");
  }

  if (currentPainKey !== "goi" && /(khop goi|van de khop goi)/.test(textValue)) {
    return handoff("blocked wrong diagnosis: knee without knee pain");
  }

  if ((currentPainKey === "vai" || currentPainKey === "vai_gay") && /(te chan|xuong chan|xuong mong|than kinh toa|that lung|khop hang|vung hang|dau hang)/.test(textValue)) {
    return handoff("blocked wrong region: neck/shoulder cannot become leg/back");
  }

  if (currentPainKey !== "hang" && /(khop hang|vung hang|dau hang)/.test(textValue)) {
    return handoff("blocked wrong diagnosis: hip without hip pain");
  }

  if ((currentPainKey === "ngon_tay_cai" || currentPainKey === "co_tay" || currentPainKey === "tay") && /(khop goi|than kinh toa|xuong mong|xuong chan)/.test(textValue)) {
    return handoff("blocked wrong region: hand/arm reply drifted to another region");
  }

  if ((currentPainKey === "ngon_tay_cai" || currentPainKey === "co_tay" || currentPainKey === "tay") && /(di lai|dung len ngoi xuong|khop hang|vung hang|dau hang|vai gay)/.test(textValue)) {
    return handoff("blocked wrong region: hand/arm cannot ask hip/walking/neck");
  }

  if (lastText && textValue === lastText) return handoff("blocked exact duplicate");
  if (questionKey && state.sentQuestionKeys.has(questionKey)) return handoff(`blocked repeated question key: ${questionKey}`);
  if (hasPronounConflict(state, message)) return handoff("blocked pronoun conflict");
  if (/\bban\b|quy khach|tinh trang cu the/.test(textValue)) return handoff("blocked robotic wording");
  if (message.length > 190) return handoff("blocked long message");
  const intentCheck = responseMatchesIntent(state, textValue);
  if (intentCheck) return handoff(intentCheck);
  if (state.pain && /vi tri nao|dau o dau/.test(textValue)) return handoff("blocked repeated pain location");
  if (state.pain && /(dang dau phan nao|dau moi phan nao|can ho tro dau moi phan nao)/.test(textValue)) return handoff("blocked repeated known symptom");
  if (state.duration && /bao lau|lau chua|keo dai/.test(textValue) && state.askedFields.has("duration")) return handoff("blocked repeated duration");
  if (state.trigger && /(van dong hay tu nhien|di lai hay ngoi lau)/.test(textValue) && state.askedFields.has("trigger")) return handoff("blocked repeated trigger");
  if (state.radiation && /(lan dau|te khong|te tay|te chan)/.test(textValue) && state.askedFields.has("radiation")) return handoff("blocked repeated radiation");
  if (state.phoneNumber && /(sdt|so dien thoai)/.test(textValue)) return handoff("blocked repeated phone request");
  if (state.customerName && /cho em xin ten|xin ten/.test(textValue)) return handoff("blocked repeated name request");
  if (state.appointmentTime && /may gio|khoang may gio/.test(textValue)) return handoff("blocked repeated appointment time request");
  if (state.preferredBranch && /(chi nhanh 1|chi nhanh 2|hoang quoc viet hay binh trung|tien co so)/.test(textValue)) return handoff("blocked repeated branch request");
  if ((state.bookingAsked || state.wantsBooking || state.appointmentTime || state.phoneNumber) && /(dang dau phan nao|dau moi phan nao|bao lau|lau chua|ngoi lau|di lai|te tay|te chan|lan xuong)/.test(textValue)) {
    return handoff("blocked clinical question after booking context");
  }
  if ((state.customerName || state.phoneNumber || state.appointmentTime || state.preferredBranch) && /(dang dau|dau moi|dau phan nao|dau lau|bi lau|co te|co lan|ngoi lau|di lai)/.test(textValue)) {
    return handoff("blocked asking symptoms after appointment info captured");
  }

  if (state.pain === "lưng" && /(te tay|xuong tay)/.test(textValue)) {
    return handoff("blocked wrong region: back asked hand");
  }

  if (state.pain === "lưng" && /(khop goi|cung khop|dau nhoi)/.test(textValue)) {
    return handoff("blocked wrong region: back asked knee/joint");
  }

  if (state.pain !== "gối" && /khop goi/.test(textValue)) {
    return handoff("blocked wrong diagnosis: knee without knee pain");
  }

  if ((state.pain === "vai" || state.pain === "vai gáy") && /(te chan|xuong chan|xuong mong)/.test(textValue)) {
    return handoff("blocked wrong region: neck asked leg");
  }

  return { action: "REPLY", message };
}

function responseMatchesIntent(state, textValue) {
  const intent = state.customerIntent || "";

  if (intent === "address" || intent === "address_and_booking" || intent === "price_and_address") {
    const hasAddress = /33n|hoang quoc viet|94|duong 56|binh trung/.test(textValue);
    const asksBranch = /hoang quoc viet hay binh trung|chi nhanh 1|chi nhanh 2|tien co so|gan co so/.test(textValue);
    if (!hasAddress && !asksBranch) return "blocked intent mismatch: address requested";
  }

  if (intent === "booking" || intent === "price_and_booking" || intent === "branch_for_booking") {
    const movesToBooking = /ten|sdt|so dien thoai|hoang quoc viet|binh trung|giu lich|qua duoc/.test(textValue);
    if (!movesToBooking) return "blocked intent mismatch: booking requested";
  }

  if ((intent === "price" || intent === "price_and_booking" || intent === "price_and_address") && hasEnoughForPrice(state)) {
    const hasOfferOrClose = /499|uu dai|chi phi|lo trinh|ten|sdt|giu lich|hoang quoc viet|binh trung|qua duoc/.test(textValue);
    if (!hasOfferOrClose) return "blocked intent mismatch: price requested after enough info";
  }

  if (intent === "specific_disease") {
    const hasDiseaseView = /nghieng ve|nhan dinh|co the|van de|thoat vi|thoai hoa|than kinh|cang co|viem gan|khop/.test(textValue);
    if (!hasDiseaseView) return "blocked intent mismatch: specific disease requested";
  }

  return "";
}

function messageQuestionKey(message) {
  const textValue = normalizeText(message);
  if (/dau o vung nao|dang dau o vung nao|vi tri nao|dau o dau/.test(textValue)) return "ask_problem_location";
  if (/dang dau phan nao|dau phan nao/.test(textValue)) return "ask_problem_location";
  if (/dau moi phan nao|can ho tro dau moi/.test(textValue)) return "ask_problem_location";
  if (/dau khop nao|khop nao/.test(textValue)) return "ask_joint_area";
  if (/bao dung phan uu dai|bao dung uu dai/.test(textValue)) return "ask_price_problem";
  if (/bao lau|lau chua|keo dai/.test(textValue)) return "ask_duration";
  if (/bi lau chua|dau .* lau chua/.test(textValue)) return "ask_duration";
  if (/van dong hay tu nhien|sau van dong hay tu nhien|di lai ngoi lau hay tu nhien|di lai hay ngoi lau/.test(textValue)) return "ask_trigger";
  if (/ngoi lau|dung dien thoai|di lai co thay dau hon|nhanh moi hon/.test(textValue)) return "ask_trigger";
  if (/cam nam|gap duoi|xoay co tay|xoay tay/.test(textValue)) return "ask_hand_function";
  if (/te tay nhieu hon|te chan nhieu hon/.test(textValue)) return "ask_mixed_numbness";
  if (/lan xuong tay|te tay/.test(textValue)) return "ask_arm_radiation";
  if (/lan xuong mong|lan xuong chan|te chan/.test(textValue)) return "ask_leg_radiation";
  if (/dieu tri phuong phap nao|da dieu tri|da di dieu tri/.test(textValue)) return "ask_treatment";
  if (/co so hoang quoc viet hay binh trung|hoang quoc viet hay binh trung|chi nhanh 1|chi nhanh 2|tien co so nao|tien hoang quoc viet hay binh trung/.test(textValue)) return "ask_branch";
  if (/gan co so nao/.test(textValue)) return "ask_branch";
  if (/xin ten va sdt|cho em xin ten|so dien thoai/.test(textValue)) return "ask_phone";
  return "";
}

function hasPronounConflict(state, message) {
  const textValue = normalizeText(message);
  if (/\bban\b|quy khach/.test(textValue)) return true;

  const raw = message.toLowerCase();
  const pronouns = [];
  if (/(^|\s)anh(\s|$)/.test(textValue)) pronouns.push("anh");
  if (/(^|\s)(chị|chi)(\s|$)/.test(raw) || /(^|\s)chi(\s|$)/.test(textValue)) pronouns.push("chị");
  if (/(^|\s)cô(\s|$)/.test(raw)) pronouns.push("cô");
  if (/(^|\s)(chú|chu)(\s|$)/.test(raw) || /(^|\s)chu(\s|$)/.test(textValue)) pronouns.push("chú");
  if (/\bminh\b/.test(textValue)) pronouns.push("mình");

  const uniquePronouns = [...new Set(pronouns)];
  const persona = state.persona || "mình";

  if (persona === "mình") {
    return uniquePronouns.some((p) => ["anh", "chị", "cô", "chú"].includes(p));
  }

  if (uniquePronouns.includes("mình")) return true;
  return uniquePronouns.some((p) => ["anh", "chị", "cô", "chú"].includes(p) && p !== persona);
}

function logLeadSignal(senderId, state, customerText, botMessage = "") {
  console.log("Lead signal:", {
    senderId,
    customerText,
    botMessage,
    customerIntent: state.customerIntent,
    group: state.leadGroup,
    temperature: state.temperature,
    emotion: detectCustomerEmotion(customerText),
    leadHeat: estimateLeadHeat(state, customerText),
    nextGoal: state.nextGoal,
    nextBestAction: state.nextBestAction,
    stage: state.stage,
    areaHint: state.areaHint,
    preferredBranch: state.preferredBranch,
    pain: state.pain,
    disease: state.disease,
    duration: state.duration,
    trigger: state.trigger,
    radiation: state.radiation,
    askedPrice: state.askedPrice,
    askedAddress: state.askedAddress,
    hasPhone: state.hasPhone,
    customerName: state.customerName,
    phoneNumber: state.phoneNumber ? "[captured]" : "",
    appointmentTime: state.appointmentTime,
    priceSent: state.priceSent,
    addressSent: state.addressSent,
    bookingAsked: state.bookingAsked,
    assessmentSent: state.assessmentSent,
  });
}

function agenticOperatingCore(state = {}) {
  return {
    name: "IVA_AGENTIC_CORE_V2",
    mission: [
      "Tu van nhu nhan su chatpage that, ngan gon, gan, co muc tieu dua khach den phong kham kiem tra.",
      "Khong hoi theo suon may moc. Moi cau phai co y do: khai thac dau hieu, tra loi y khach, chot lich, hoac im de nguoi lam.",
      "Khach hoi gi thi xu ly dung y do truoc. Khong keo khach quay lai cau hoi trieu chung neu khach dang hoi gia, dia chi, lich, so may, hoac da gui SDT.",
    ],
    thinkingLoopBeforeEveryReply: [
      "Doc lai mach chat gan nhat, khong chi doc tin cuoi.",
      "Xac dinh khach vua hoi gi that su va co bao nhieu y trong mot tin.",
      "Kiem tra knownInfo: vung dau, thoi gian, nguyen nhan, lan/te, da dieu tri, gia/dia chi/lich da noi chua.",
      "Neu thong tin da co thi cam hoi lai duoi moi hinh thuc.",
      "Chon dung mot hanh dong: tra loi thang, hoi 1 y con thieu, nhan dinh so bo, bao uu dai, gui dia chi, xin ten/SDT, hoac HANDOFF im lang.",
      "Tu kiem tra cau sap gui: co lap khong, co sai vung khong, co qua dai khong, co giong bot khong, co lam khach kho chiu khong.",
      "Neu khong chac hoac cau sap gui khong dat, HANDOFF im lang.",
    ],
    actionPriority: [
      "Nguoi that/Page da nhan hoac da co SDT: dung bot ngay.",
      "Khach hoi dia chi/o dau/so may/duong nao: gui dia chi truoc, sau do hoi khach qua chi nhanh 1 hay chi nhanh 2 neu can giu lich.",
      "Khach hoi gia dau cuoc: chua bao gia, hoi 1 y de nam tinh trang.",
      "Khach da du dau hieu hoac da co nhan dinh so bo roi hoi gia: bao uu dai ngay, khong hoi them.",
      "Khach noi se qua/hom nay/mai/may gio/dat lich: xin hoac xac nhan co so + ten + SDT + gio, chi hoi phan con thieu.",
      "Khach hoi 2 y trong 1 tin: xu ly du 2 y, khong bo sot.",
      "Khach hoi benh gi/cu the la gi: nhan dinh so bo dung vung, khong lap cau chung chung.",
    ],
    regionLogic: [
      "Lung/that lung: chi hoi ngoi lau, di lai, lan xuong mong/chan, te chan; nhan dinh cot song that lung, thoat vi dia dem that lung, than kinh toa, hoac cang co lung.",
      "Co/vai gay: chi hoi ngoi lau, dung dien thoai, lan/te tay, dau dau neu can; nhan dinh cang co vai gay, thoai hoa dot song co, chen ep re than kinh.",
      "Tay/co tay/ngon tay/ngon cai: hoi te/buot/cam nam/cam do, van dong ngon/co tay; khong hoi di lai hay khop hang/goi.",
      "Goi: chi khi khach noi ro goi; hoi di lai, len xuong cau thang, dau nhoi/cung khop.",
      "Hang: chi khi khach noi ro hang/khop hang; khong duoc doc nham 'thang' thanh 'hang'.",
      "Dau khop chung chung: hoi khop nao, khong tu hieu la khop goi.",
      "Te tay chan: hoi tach vung 'minh thay te tay nhieu hon hay te chan nhieu hon a?', khong ket luan voi.",
    ],
    languageStyle: [
      "Dung 'minh' neu chua ro vai ve; chi dung anh/chi/co/chu khi khach tu xung hoac ngu canh ro.",
      "Khong dung: ban, quy khach, tinh trang cu the, dau vi tri nao.",
      "Moi tin 1 diem cham, ngan va co cam giac nguoi that.",
      "Khach ngan thi dap ngan; khach voi thi di thang vao lich; khach lo gia thi noi mem.",
    ],
    absoluteStops: [
      "Co tin nhan nguoi that/Page khong phai bot trong cuoc chat.",
      "Khach gui so dien thoai.",
      "Khach dang hoan/doi/huy lich/bao ban sau khi da co lich.",
      "Khach hoi ngoai thong tin phong kham chua duoc cap: gio lam viec chua cap, cam ket khoi, bac si cu the, bao hanh, massage thu gian, buoi le.",
      "Cau tra loi sap gui lap y cu, sai vung, hoac khong tra loi dung cau khach vua hoi.",
    ],
    pricingRule: [
      "Khong bao gia theo benh ly khi chua nam tinh trang.",
      "Chi bao uu dai sau khi da co du dau hieu/nhan dinh so bo.",
      "Cau gia dung: Sau khi kham bac si se trao doi ky lo trinh va chi phi cho minh. Dat lich online ben em dang co uu dai 499k/5 buoi tri lieu bam huyet.",
      "Khach hoi phat sinh/ep mua: Sau khi kham bac si se trao doi ro lo trinh va chi phi, minh dong y thi minh lam a.",
    ],
    currentKnownState: {
      pain: state.primaryPain || state.pain || "",
      disease: state.disease || "",
      duration: state.duration || "",
      trigger: state.trigger || "",
      radiation: state.radiation || "",
      assessmentSent: Boolean(state.assessmentSent),
      priceSent: Boolean(state.priceSent),
      addressSent: Boolean(state.addressSent),
      bookingAsked: Boolean(state.bookingAsked),
      humanTakeover: Boolean(state.humanTakeover),
    },
  };
}

function buildBrainContext(state, customerText, chatKey = "") {
  return {
    customerText,
    recentConversation: recentConversation(chatKey, 12),
    lastOutboundRole: lastOutboundRole(chatKey),
    agenticOperatingCore: agenticOperatingCore(state),
    agenticDecision: agenticDecisionSummary(state, customerText),
    mustThinkBeforeReply: [
      "1. Khách vừa hỏi/nhắn điều gì thật sự?",
      "2. Ý khách đang cần xử lý ngay là giá, địa chỉ, lịch, triệu chứng, SĐT, hay đổi/hoãn lịch?",
      "3. Khách đã cung cấp thông tin nào rồi? Tuyệt đối không hỏi lại.",
      "4. Nếu khách hỏi 2 ý trong 1 tin thì phải xử lý đủ 2 ý, ưu tiên ý chốt.",
      "5. Lúc này nên trả lời thẳng, hỏi đúng 1 ý còn thiếu, xác nhận lịch, hay HANDOFF?",
      "6. Câu sắp gửi có đúng vùng đau và đúng ngữ cảnh không?",
      "7. Câu sắp gửi có làm khách thấy bị làm phiền, bị hỏi lại, hoặc bị máy móc không?",
    ],
    intent: state.customerIntent,
    stage: state.stage,
    knownInfo: {
      pain: state.pain,
      disease: state.disease,
      duration: state.duration,
      trigger: state.trigger,
      radiation: state.radiation,
      treated: state.treated,
      askedPrice: state.askedPrice,
      askedAddress: state.askedAddress,
      assessmentSent: state.assessmentSent,
      priceSent: state.priceSent,
      addressSent: state.addressSent,
      bookingAsked: state.bookingAsked,
      preferredBranch: state.preferredBranch,
      customerName: state.customerName,
      hasPhoneNumber: Boolean(state.phoneNumber || state.hasPhone),
      appointmentTime: state.appointmentTime,
    },
    missingInfoForBooking: {
      missingName: !state.customerName,
      missingPhone: !(state.phoneNumber || state.hasPhone),
      missingTime: !state.appointmentTime,
      missingBranch: !state.preferredBranch,
    },
    nextGoal: state.nextGoal,
    nextBestAction: state.nextBestAction,
    hardRules: [
      "Trả lời đúng ý khách vừa hỏi trước, không quay lại sườn cũ.",
      "Nếu khách hỏi địa chỉ/số mấy/đường nào thì gửi địa chỉ.",
      "Nếu đủ tên/SĐT/giờ/cơ sở thì xác nhận lịch, không hỏi lại.",
      "Nếu thiếu thông tin đặt lịch thì chỉ hỏi đúng phần thiếu.",
      "Nếu khách hoãn/đổi/hủy lịch hoặc báo bận sau khi đã đặt lịch thì HANDOFF im lặng.",
      "Nếu khách hỏi giá sau khi đủ dấu hiệu thì báo ưu đãi 499k/5 buổi.",
      "Không hỏi lặp lại bất kỳ thông tin nào đã có trong knownInfo.",
      "Nếu khách chỉ nói đau khớp/viêm khớp nhưng chưa nói khớp nào thì hỏi 'Dạ mình đau khớp nào ạ?', không tự hiểu là khớp gối.",
      "Không sai vùng: lưng hỏi mông/chân, cổ/vai gáy hỏi tay, gối hỏi gối.",
      "Nếu không chắc thì HANDOFF.",
    ],
  };
}

async function openaiReply(senderId, customerText) {
  if (!OPENAI_API_KEY) return handoff("missing OPENAI_API_KEY");

  const history = getHistory(senderId);
  const state = getCustomerState(senderId);
  const brainContext = buildBrainContext(state, customerText, senderId);
  console.log("AI brain context:", brainContext);
  history.push({
    role: "user",
    content: `KHACH_NHAN: ${customerText}\nBO_NHO_VA_Y_DINH_NOI_BO: ${JSON.stringify(brainContext)}`,
  });

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: IVA_SYSTEM_PROMPT,
      input: history.slice(-16),
      temperature: 0.15,
      max_output_tokens: 180,
    }),
  });

  if (!response.ok) {
    console.error("OpenAI error", response.status, await response.text());
    return handoff("openai error");
  }

  const data = await response.json();
  const outputText =
    data.output_text ||
    data.output?.flatMap((item) => item.content || [])?.map((c) => c.text || "").join("") ||
    "";

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    console.error("AI returned non-JSON:", outputText);
    parsed = { action: "HANDOFF", message: "" };
  }
  console.log("AI brain output:", {
    customerText,
    action: parsed.action,
    message: parsed.message || "",
    intent: state.customerIntent,
    stage: state.stage,
    nextBestAction: state.nextBestAction,
  });

  if (parsed.action === "REPLY" && parsed.message) {
    history.push({ role: "assistant", content: parsed.message });
  } else {
    history.push({ role: "assistant", content: "[HANDOFF_SILENT]" });
  }

  if (history.length > 24) history.splice(0, history.length - 24);
  return parsed;
}

async function agenticReviewReply(chatKey, customerText, candidateReply, source = "unknown") {
  if (!AGENTIC_REVIEW_ENABLED) return candidateReply;
  if (!OPENAI_API_KEY) return candidateReply;
  if (!candidateReply || candidateReply.action !== "REPLY") return candidateReply;

  const state = getCustomerState(chatKey);
  const candidateMessages = Array.isArray(candidateReply.messages) ? candidateReply.messages : [candidateReply.message].filter(Boolean);
  const candidateText = candidateMessages.join("\n").trim();
  if (!candidateText) return handoff("agentic reviewer: empty candidate");

  const reviewerPayload = {
    task: "review_before_send",
    source,
    customerText,
    candidateText,
    recentConversation: recentConversation(chatKey, 16),
    lastOutboundRole: lastOutboundRole(chatKey),
    state: stateSnapshot(state),
    knownInfo: {
      pain: state.primaryPain || state.pain || "",
      disease: state.disease || "",
      duration: state.duration || "",
      trigger: state.trigger || "",
      radiation: state.radiation || "",
      preferredBranch: state.preferredBranch || "",
      priceSent: Boolean(state.priceSent),
      addressSent: Boolean(state.addressSent),
      assessmentSent: Boolean(state.assessmentSent),
      bookingAsked: Boolean(state.bookingAsked),
      hasPhone: Boolean(state.phoneNumber || state.hasPhone),
    },
    rules: [
      "Neu lich su gan nhat co tin nhan Page/nguoi that khong phai bot thi tra HANDOFF, khong sua va khong gui.",
      "Neu khach da gui so dien thoai thi HANDOFF.",
      "Khong hoi lai thong tin khach da tra loi.",
      "Khong gui cau lap y/cau lap lai.",
      "Doc y khach vua nhan truoc: neu khach hoi gia/dia chi/lich thi phai xu ly dung y do, khong quay ve hoi trieu chung.",
      "Neu khach hoi 2 y trong 1 tin thi phai xu ly du cac y quan trong.",
      "Khong chan doan sai vung: lung khong thanh goi/hang/tay; co-vai-gay khong thanh goi/hang/lung; tay/ngon tay khong hoi di lai/hang/goi.",
      "Tu 'thang' la thoi gian, khong duoc hieu thanh 'hang'.",
      "Khach noi dau khop ma chua ro khop nao thi chi hoi: Da minh dau khop nao a?",
      "Neu khach hoi gia sau khi da du dau hieu thi phai tra loi uu dai, khong hoi them.",
      "Neu khong chac hoac cau nhap khong dat thi HANDOFF.",
      "Van phong gan gui, ngan, 1 diem cham, khong dung ban/quy khach/tinh trang cu the/dau vi tri nao.",
    ],
    outputFormat: {
      action: "REPLY or HANDOFF",
      message: "final message if REPLY, otherwise empty",
      reason: "short reason",
      score: "0-10",
    },
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions:
        "Ban la lop KIEM DUYET CUOI cua AI chatpage phong kham IVA. Viec quan trong nhat la CHAN tin sai, lap, hoi lai, chen vao khi nguoi that da nhan. Chi cho gui neu chac dung ngu canh. Tra ve JSON hop le, khong giai thich ngoai JSON.",
      input: [
        {
          role: "user",
          content: JSON.stringify(reviewerPayload),
        },
      ],
      temperature: 0,
      max_output_tokens: 220,
    }),
  });

  if (!response.ok) {
    console.error("Agentic reviewer OpenAI error", response.status, await response.text());
    return handoff("agentic reviewer error");
  }

  const data = await response.json();
  const outputText =
    data.output_text ||
    data.output?.flatMap((item) => item.content || [])?.map((c) => c.text || "").join("") ||
    "";

  let reviewed;
  try {
    reviewed = JSON.parse(outputText);
  } catch {
    console.error("Agentic reviewer returned non-JSON:", outputText);
    return handoff("agentic reviewer non-json");
  }

  const score = Number(reviewed.score || 0);
  const action = String(reviewed.action || "").toUpperCase();
  const message = String(reviewed.message || "").trim();
  console.log("Agentic reviewer:", {
    chatKey,
    source,
    action,
    score,
    reason: reviewed.reason || "",
    candidateText,
    finalMessage: message,
  });

  if (action !== "REPLY" || !message || score < 8) {
    return handoff(`agentic reviewer blocked: ${reviewed.reason || "low score"}`);
  }

  return responseGuard(state, { action: "REPLY", message });
}

async function smartReply(chatKey, customerText, deterministicReply = null) {
  const state = getCustomerState(chatKey);
  if (deterministicReply) {
    if (deterministicReply.action !== "REPLY") {
      console.log("Decision source: controlled_stop", {
        chatKey,
        customerText,
        intent: state.customerIntent,
        stage: state.stage,
        reason: deterministicReply.message || "handoff",
      });
      return deterministicReply;
    }
    const guarded = responseGuard(state, deterministicReply);
    if (guarded.action === "REPLY" && guarded.message) {
      console.log("Decision source: controlled_rule", {
        chatKey,
        customerText,
        intent: state.customerIntent,
        stage: state.stage,
        nextBestAction: state.nextBestAction,
        reply: guarded.message,
      });
      return agenticReviewReply(chatKey, customerText, guarded, "controlled_rule");
    }
    console.log("Decision source: controlled_guard_stop", {
      chatKey,
      customerText,
      intent: state.customerIntent,
      stage: state.stage,
      reason: guarded.message || "guarded",
    });
    return guarded;
  }

  const aiReply = await openaiReply(chatKey, customerText);
  const guardedAi = responseGuard(state, aiReply);
  console.log("Decision source: ai_brain", {
    chatKey,
    customerText,
    intent: state.customerIntent,
    stage: state.stage,
    nextBestAction: state.nextBestAction,
    action: guardedAi.action,
    reply: guardedAi.message || "",
  });
  return agenticReviewReply(chatKey, customerText, guardedAi, "ai_brain");
}

async function graphApi(path, body, pageId = "") {
  const accessToken = tokenForPage(pageId);
  const tokenSource = tokenSourceForPage(pageId);
  if (!accessToken) {
    console.error("Missing page token", { pageId });
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${path}?access_token=${encodeURIComponent(accessToken)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error("Graph API error", response.status, {
      pageId,
      tokenSource,
      recipientId: body?.recipient?.id || "",
      graphPath: path,
      error: await response.text(),
    });
  }
}

async function graphApiGet(path, pageId = "", params = {}) {
  const accessToken = tokenForPage(pageId);
  const tokenSource = tokenSourceForPage(pageId);
  if (!accessToken) {
    console.error("Missing page token for GET", { pageId });
    return null;
  }

  const query = new URLSearchParams({ ...params, access_token: accessToken });
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${path}?${query.toString()}`;
  const response = await fetch(url, { method: "GET" });
  const bodyText = await response.text();
  let data = null;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    data = { raw: bodyText };
  }
  if (!response.ok) {
    console.error("Graph API GET error", response.status, {
      pageId,
      tokenSource,
      graphPath: path,
      error: bodyText,
    });
    return null;
  }
  return data;
}

function looksLikeKnownBotMessage(textValue = "", state = {}) {
  const textNorm = normalizeText(textValue);
  if (!textNorm) return false;
  if (state.lastBotMessage && normalizeText(state.lastBotMessage) === textNorm) return true;
  if (state.sentMessageFingerprints?.has?.(messageFingerprint(textValue))) return true;
  if (/minh dang dau vung nao|cho iva xin sdt|bac si chao|da minh|dau .* lau chua|moi dau gan day|ngoi lau|dung dien thoai|di lai|lan xuong|te tay|te chan|bac si kiem tra|dat lich online|499k|chi nhanh 1|chi nhanh 2|33n|94 duong 56/.test(textNorm)) return true;
  return false;
}

function looksLikeHumanManualMessage(textValue = "") {
  const textNorm = normalizeText(textValue);
  if (!textNorm) return false;
  if (looksLikeKnownBotMessage(textValue)) return false;
  if (/(nham|bam nham|pk nhan|phong kham nhan|quan ly lien he|em nhan duoc|anh chi cho em xin|cho pk xin|co so nao|chi nhanh nao|hoang quoc viet hay binh trung|da em dat hen|em xac nhan|lich hen|gui lich|giu lich|hotline|sdt|so dien thoai)/.test(textNorm)) return true;
  if (/(chi|anh|co|chu)\s+(qua|den|sap xep|cho em xin|cho minh xin|minh tien|tien qua)/.test(textNorm)) return true;
  if (/(hom nay|ngay mai|lat|may gio).*(qua|den|lich)|(?:qua|den).*(hom nay|ngay mai|lat|may gio)/.test(textNorm)) return true;
  return false;
}

async function hasExternalPageReply(pageId, customerId, chatKey) {
  if (!pageId || !customerId) return false;
  const state = getCustomerState(chatKey);
  const data = await graphApiGet("me/conversations", pageId, {
    user_id: customerId,
    fields: "messages.limit(8){from,message,created_time}",
    limit: "1",
  });
  const thread = data?.data?.[0];
  const messages = Array.isArray(thread?.messages?.data) ? thread.messages.data : [];
  for (const item of messages) {
    const fromId = String(item?.from?.id || "");
    const textValue = item?.message || "";
    if (fromId !== String(pageId) || !textValue) continue;
    if (looksLikeKnownBotMessage(textValue, state)) continue;
    if (!looksLikeHumanManualMessage(textValue)) {
      console.log("External page message ignored as non-human/manual", {
        chatKey,
        pageId,
        text: maskPrivateText(textValue).slice(0, 180),
      });
      continue;
    }
    return { text: textValue, createdTime: item?.created_time || "" };
  }
  return false;
}

async function senderAction(recipientId, action, pageId = "") {
  await graphApi("me/messages", {
    recipient: { id: recipientId },
    sender_action: action,
  }, pageId);
}

async function sendMessage(recipientId, message, pageId = "") {
  await graphApi("me/messages", {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: { text: message },
  }, pageId);
}

function isDuplicate(messageId) {
  if (!messageId) return false;
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > 5000) {
    const first = processedMessageIds.values().next().value;
    processedMessageIds.delete(first);
  }
  return false;
}

async function handleMessagingEvent(event) {
  const senderId = event.sender?.id;
  const pageId = event.recipient?.id || "";
  const message = event.message;

  if (!senderId || !message) return;
  if (!message.is_echo && isKnownPageId(senderId) && event.recipient?.id) {
    markHumanTakeover(senderId, event.recipient.id, "page message without echo", message.text?.trim() || "");
    return;
  }
  if (message.is_echo) {
    const echoPageId = event.sender?.id || "";
    const echoCustomerId = event.recipient?.id || "";
    const echoText = message.text?.trim() || "";
    if (/^\/stopbot\b/i.test(echoText)) {
      markHumanTakeover(echoPageId, echoCustomerId, "manual /stopbot", echoText);
      return;
    }
    if (/^\/startbot\b/i.test(echoText)) {
      unlockConversation(echoPageId, echoCustomerId, "manual /startbot");
      return;
    }
    if (isKnownBotEcho(echoPageId, echoCustomerId, echoText)) {
      console.log("Ignored bot echo", { pageId: echoPageId, customerId: echoCustomerId, appId: message.app_id || "" });
      return;
    }
    markHumanTakeover(echoPageId, echoCustomerId, `page echo not sent by bot${message.app_id ? " with app_id" : ""}`, echoText);
    return;
  }
  if (isDuplicate(message.mid)) return;

  const customerText = message.text?.trim();
  if (!customerText) return;

  try {
    const chatKey = conversationKey(pageId, senderId);
    recordChatEvent("customer", { pageId, chatKey, senderId, text: customerText });
    const stateBeforeReply = getCustomerState(chatKey);
    const stateBeforeReplySnapshot = {
      askedPrice: Boolean(stateBeforeReply.askedPrice),
      askedAddress: Boolean(stateBeforeReply.askedAddress),
      priceSent: Boolean(stateBeforeReply.priceSent),
      addressSent: Boolean(stateBeforeReply.addressSent),
      bookingAsked: Boolean(stateBeforeReply.bookingAsked),
      assessmentSent: Boolean(stateBeforeReply.assessmentSent),
      humanTakeover: Boolean(stateBeforeReply.humanTakeover),
    };
    if (hasHumanOutboundInMemory(chatKey) || lastOutboundRole(chatKey) === "human") {
      lockConversation(pageId, senderId, "memory detected human already replied - bot stopped", customerText);
      recordChatEvent("handoff", { pageId, chatKey, senderId, text: customerText, reason: "memory detected human already replied" });
      return;
    }
    const externalPageReply = await hasExternalPageReply(pageId, senderId, chatKey);
    if (externalPageReply) {
      markHumanTakeover(pageId, senderId, "graph history detected page/human reply before bot send", externalPageReply.text || "");
      recordChatEvent("handoff", { pageId, chatKey, senderId, text: customerText, reason: "graph history detected page/human reply" });
      return;
    }
    if (isCustomerEndingOrDeclining(customerText)) {
      lockConversation(pageId, senderId, "customer ended/declined - do not continue", customerText);
      return;
    }
    if (isCustomerReplyingToHumanPrice(customerText, stateBeforeReplySnapshot)) {
      lockConversation(pageId, senderId, "customer is replying to human price - do not quote again", customerText);
      return;
    }
    if (hasPhoneNumber(customerText)) {
      const phoneNumber = extractPhoneNumber(customerText);
      stateBeforeReply.phoneNumber = phoneNumber;
      stateBeforeReply.hasPhone = true;
      stateBeforeReply.stage = "phone_captured_human_followup";
      recordChatEvent("lead_phone", { pageId, chatKey, senderId, text: customerText, phoneNumber: "[captured]", reason: "phone received - human follow up only", state: stateSnapshot(stateBeforeReply) });
      lockConversation(pageId, senderId, "phone received - stop bot for human follow up", customerText);
      return;
    }
    if (isHumanTakenOver(chatKey)) {
      console.log("AI skipped because human already took over", { chatKey, customerText });
      recordChatEvent("handoff", { pageId, chatKey, senderId, text: customerText, reason: "human already took over" });
      return;
    }
    await senderAction(senderId, "typing_on", pageId);
    const deterministic = handleDeterministicFlow(chatKey, customerText);
    const state = getCustomerState(chatKey);
    const profile = agenticProfile(state, customerText);
    const agenticDecision = agenticDecisionSummary(state, customerText);
    const guarded = await smartReply(chatKey, customerText, deterministic);
    const decisionTrace = {
      detectedPainFromCustomer: detectPain(customerText) || "",
      detectedDiseaseFromCustomer: detectDisease(customerText) || "",
      detectedDurationFromCustomer: detectDuration(customerText) || "",
      detectedTriggerFromCustomer: detectTrigger(customerText) || "",
      detectedRadiationFromCustomer: detectRadiation(customerText) || "",
      intent: state.customerIntent,
      stage: state.stage,
      painInMemory: state.pain,
      primaryPainInMemory: state.primaryPain,
      diseaseInMemory: state.disease,
      durationInMemory: state.duration,
      triggerInMemory: state.trigger,
      radiationInMemory: state.radiation,
      agenticProfile: profile,
      agenticDecision,
      deterministicAction: deterministic?.action || "",
      deterministicMessage: deterministic?.message || "",
      guardedAction: guarded?.action || "",
      guardedMessage: guarded?.message || "",
      replyDiagnosisRegions: guarded?.message ? [...diagnosisRegionKeys(guarded.message)] : [],
      allowedDiagnosisRegions: [...allowedDiagnosisRegionsForPain(state)],
    };
    recordChatEvent("decision", { pageId, chatKey, senderId, text: customerText, reason: "before final gate", decision: decisionTrace, state: stateSnapshot(state) });

    if (guarded.action !== "REPLY" || !guarded.message) {
      logLeadSignal(chatKey, state, customerText, "");
      recordChatEvent("handoff", { pageId, chatKey, senderId, text: customerText, reason: guarded.message || "silent handoff", decision: decisionTrace, state: stateSnapshot(state) });
      await senderAction(senderId, "typing_off", pageId);
      return;
    }

    const messagesToSend = Array.isArray(guarded.messages) ? guarded.messages : [guarded.message];
    const finalGate = finalReplyGate(chatKey, pageId, senderId, customerText, messagesToSend, stateBeforeReplySnapshot);
    if (!finalGate.ok) {
      console.log("AI final gate blocked reply", { chatKey, reason: finalGate.reason, messagesToSend });
      recordChatEvent("handoff", { pageId, chatKey, senderId, text: customerText, reason: finalGate.reason, attemptedReply: messagesToSend.join(" | "), decision: decisionTrace, state: stateSnapshot(state) });
      return;
    }
    console.log("AI final gate allowed reply", { chatKey, reason: "allowed by final gate", decision: decisionTrace, messagesToSend });
    for (const outgoingMessage of messagesToSend) {
      await delay(naturalDelay(outgoingMessage));
      if (isHumanTakenOver(chatKey)) {
        console.log("AI send cancelled because human took over during delay", { chatKey });
        recordChatEvent("handoff", { pageId, chatKey, senderId, text: outgoingMessage, reason: "cancelled before send: human takeover", state: stateSnapshot(state) });
        return;
      }
      if (hasHumanOutboundInMemory(chatKey) || lastOutboundRole(chatKey) === "human") {
        console.log("AI send cancelled because memory found human message", { chatKey });
        recordChatEvent("handoff", { pageId, chatKey, senderId, text: outgoingMessage, reason: "cancelled before send: human in memory", state: stateSnapshot(state) });
        return;
      }
      const externalPageReplyBeforeSend = await hasExternalPageReply(pageId, senderId, chatKey);
      if (externalPageReplyBeforeSend) {
        markHumanTakeover(pageId, senderId, "graph history detected human reply during send delay", externalPageReplyBeforeSend.text || "");
        recordChatEvent("handoff", { pageId, chatKey, senderId, text: outgoingMessage, reason: "cancelled before send: graph human reply", state: stateSnapshot(state) });
        return;
      }
      rememberBotEcho(pageId, senderId, outgoingMessage);
      await sendMessage(senderId, outgoingMessage, pageId);
      recordChatEvent("bot", { pageId, chatKey, senderId, text: outgoingMessage, reason: "allowed by final gate", decision: decisionTrace, state: stateSnapshot(state) });
      state.lastBotMessage = outgoingMessage;
      const sentQuestionKey = messageQuestionKey(outgoingMessage);
      if (sentQuestionKey) state.sentQuestionKeys.add(sentQuestionKey);
      if (!state.sentMessageFingerprints) state.sentMessageFingerprints = new Set();
      state.sentMessageFingerprints.add(messageFingerprint(outgoingMessage));
    }
    logLeadSignal(chatKey, state, customerText, messagesToSend.join(" | "));
  } catch (error) {
    console.error("Message handling error:", error);
  } finally {
    await senderAction(senderId, "typing_off", pageId);
  }
}

async function handleWebhookPost(req, res) {
  const body = await readJson(req);
  console.log("WEBHOOK POST RECEIVED", {
    object: body.object || "",
    entries: Array.isArray(body.entry) ? body.entry.length : 0,
    pageIds: (body.entry || []).map((entry) => entry.id || "").filter(Boolean),
    eventCount: (body.entry || []).reduce((sum, entry) => sum + (Array.isArray(entry.messaging) ? entry.messaging.length : 0), 0),
  });
  if (body.object !== "page") {
    console.log("WEBHOOK POST IGNORED unsupported object", { object: body.object || "", keys: Object.keys(body || {}) });
    return json(res, 404, { error: "Unsupported object" });
  }

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      console.log("WEBHOOK EVENT", {
        pageId: event.recipient?.id || entry.id || "",
        senderId: event.sender?.id || "",
        hasMessage: Boolean(event.message),
        isEcho: Boolean(event.message?.is_echo),
        hasText: Boolean(event.message?.text),
        hasPostback: Boolean(event.postback),
      });
      handleMessagingEvent(event);
    }
  }

  return text(res, 200, "EVENT_RECEIVED");
}

function handleWebhookVerify(req, res, url) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN) return text(res, 200, challenge || "");
  return text(res, 403, "Forbidden");
}

function verifyMetaSignature(req, rawBody) {
  const appSecret = process.env.APP_SECRET;
  const signature = req.headers["x-hub-signature-256"];
  if (!appSecret || !signature) return true;

  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/") {
      return json(res, 200, {
        ok: true,
        service: "IVA Chatpage Bot",
        webhook: "/webhook",
        privacy: "/privacy-policy",
        dataDeletion: "/data-deletion",
      });
    }

    if (req.method === "GET" && (url.pathname === "/privacy-policy" || url.pathname === "/data-deletion")) {
      return html(res, 200, privacyPolicyHtml);
    }

    if (req.method === "GET" && url.pathname === "/report") {
      const token = url.searchParams.get("token") || "";
      if (REPORT_TOKEN && token !== REPORT_TOKEN) return text(res, 403, "Forbidden");
      return html(res, 200, reportHtml(readRecentChatRows(7)));
    }

    if (req.method === "GET" && url.pathname === "/report.json") {
      const token = url.searchParams.get("token") || "";
      if (REPORT_TOKEN && token !== REPORT_TOKEN) return text(res, 403, "Forbidden");
      const rows = readRecentChatRows(7);
      return json(res, 200, {
        ok: true,
        days: 7,
        conversations: qualityByConversation(rows),
        rows,
      });
    }

    if (req.method === "GET" && url.pathname === "/debug-config") {
      const token = url.searchParams.get("token") || "";
      if (REPORT_TOKEN && token !== REPORT_TOKEN) return text(res, 403, "Forbidden");
      return json(res, 200, {
        ok: true,
        pageTokenIds: Object.keys(PAGE_TOKENS),
        pageTokenCount: Object.keys(PAGE_TOKENS).length,
        hasFallbackPageAccessToken: Boolean(PAGE_ACCESS_TOKEN),
        graphApiVersion: GRAPH_API_VERSION,
        model: OPENAI_MODEL,
        agenticReviewEnabled: AGENTIC_REVIEW_ENABLED,
        webhook: "/webhook",
      });
    }

    if (req.method === "GET" && url.pathname === "/webhook") return handleWebhookVerify(req, res, url);
    if (req.method === "POST" && url.pathname === "/webhook") return handleWebhookPost(req, res);

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("Server error:", error);
    return json(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`IVA Chatpage Bot running on port ${PORT}`);
  console.log("Webhook path: /webhook");
});
