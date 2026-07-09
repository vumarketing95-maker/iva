import http from "node:http";
import crypto from "node:crypto";
import { IVA_SYSTEM_PROMPT, DEFAULT_HISTORY } from "./iva_rules.mjs";

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "iva_verify_2026";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v23.0";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MIN_REPLY_DELAY_MS = Number(process.env.MIN_REPLY_DELAY_MS || 2500);
const MAX_REPLY_DELAY_MS = Number(process.env.MAX_REPLY_DELAY_MS || 6500);

const conversations = new Map();
const customerStates = new Map();
const processedMessageIds = new Set();

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function naturalDelay(message = "") {
  const base = MIN_REPLY_DELAY_MS + Math.min(message.length * 35, 1600);
  const jitter = Math.floor(Math.random() * Math.max(500, MAX_REPLY_DELAY_MS - MIN_REPLY_DELAY_MS));
  return Math.min(MAX_REPLY_DELAY_MS, base + jitter);
}

function getHistory(senderId) {
  if (!conversations.has(senderId)) {
    conversations.set(senderId, [...DEFAULT_HISTORY]);
  }
  return conversations.get(senderId);
}

function getCustomerState(senderId) {
  if (!customerStates.has(senderId)) {
    customerStates.set(senderId, {
      persona: "mình",
      pain: "",
      disease: "",
      duration: "",
      trigger: "",
      radiation: "",
      treated: "",
      askedPrice: false,
      lastQuestion: "",
      assessed: false,
    });
  }
  return customerStates.get(senderId);
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectPersona(rawText, state) {
  const text = normalizeText(rawText);
  if (/\banh\b/.test(text)) state.persona = "anh";
  if (/\bchi\b/.test(text)) state.persona = "chị";
  if (/\bco\b/.test(text)) state.persona = "cô";
  if (/\bchu\b/.test(text)) state.persona = "chú";
}

function subject(state) {
  return state.persona || "mình";
}

function detectPain(rawText) {
  const text = normalizeText(rawText);
  if (/(co vai gay|vai gay|dau vai gay|te tay)/.test(text)) return "vai gáy";
  if (/(dau vai|vai\b)/.test(text)) return "vai";
  if (/(dau lung|lung|that lung|te chan|than kinh toa)/.test(text)) return "lưng";
  if (/(dau goi|goi\b)/.test(text)) return "gối";
  if (/(hang|khop hang)/.test(text)) return "háng";
  if (/(tay|khuyu tay|elbow|tennis elbow)/.test(text)) return "tay";
  return "";
}

function detectDisease(rawText) {
  const text = normalizeText(rawText);
  if (/thoat vi/.test(text)) return "thoát vị đĩa đệm";
  if (/than kinh toa/.test(text)) return "đau thần kinh tọa";
  if (/thoai hoa/.test(text)) return "thoái hóa";
  if (/viem khop hang/.test(text)) return "viêm khớp háng";
  if (/viem khop/.test(text)) return "viêm khớp";
  if (/elbow|tennis elbow/.test(text)) return "elbow";
  return "";
}

function detectDuration(rawText) {
  const text = normalizeText(rawText);
  if (/(hom qua|moi|gan day|vua bi|2 tuan|tuan|thang|nam|ngay)/.test(text)) return rawText.trim();
  if (/^\d+\s*(ngay|tuan|thang|nam)/.test(text)) return rawText.trim();
  return "";
}

function detectTrigger(rawText) {
  const text = normalizeText(rawText);
  if (/(di moi dau|di lai|di dung)/.test(text)) return "đi lại đau";
  if (/(ngoi lau|ngoi)/.test(text)) return "ngồi lâu đau";
  if (/(van dong|choi the thao|be nang|tap|the thao)/.test(text)) return "vận động";
  if (/(tu nhien|tu dung)/.test(text)) return "tự nhiên";
  return "";
}

function detectRadiation(rawText) {
  const text = normalizeText(rawText);
  if (/(te tay|lan xuong tay|moi tay|dau dau)/.test(text)) return "tay";
  if (/(te chan|lan xuong chan|lan xuong mong|moi chan)/.test(text)) return "chân";
  if (/^(co|có|uh|ừ|u|vâng|vang|co em|có em)$/i.test(rawText.trim())) return "có";
  if (/^(khong|không|k|ko|khong em|không em)$/i.test(rawText.trim())) return "không";
  return "";
}

function detectTreatment(rawText) {
  const text = normalizeText(rawText);
  if (/(chua|chưa)/.test(rawText) || /\bchua\b/.test(text)) return "chưa";
  if (/(co cham cuu|cham cuu|vat ly tri lieu|vltl|uong thuoc|da dieu tri|co di)/.test(text)) return rawText.trim();
  return "";
}

function isPriceQuestion(rawText) {
  const text = normalizeText(rawText);
  return /(gia|phi|chi phi|bao nhieu|bn|bao tien|mac|dat)/.test(text);
}

function isTreatmentAbilityQuestion(rawText) {
  const text = normalizeText(rawText);
  return /(co dieu tri|dieu tri duoc|tri duoc|ho tro dieu tri|co chua duoc)/.test(text);
}

function isAddressQuestion(rawText) {
  const text = normalizeText(rawText);
  return /^(dia chi|o dau|ben minh o dau|phong kham o dau)$/.test(text);
}

function isPing(rawText) {
  const text = normalizeText(rawText);
  return /^(alo|hello|helo|em oi|e oi|co ai khong)$/.test(text);
}

function updateStateFromText(state, rawText) {
  detectPersona(rawText, state);
  const pain = detectPain(rawText);
  const disease = detectDisease(rawText);
  const duration = detectDuration(rawText);
  const trigger = detectTrigger(rawText);
  const radiation = detectRadiation(rawText);
  const treated = detectTreatment(rawText);

  if (pain) state.pain = pain;
  if (disease) state.disease = disease;
  if (duration) state.duration = duration;
  if (trigger) state.trigger = trigger;
  if (radiation) state.radiation = radiation;
  if (treated) state.treated = treated;
  if (isPriceQuestion(rawText)) state.askedPrice = true;

  if (!state.duration && state.lastQuestion === "duration" && duration) state.duration = duration;
  if (!state.trigger && state.lastQuestion === "trigger" && trigger) state.trigger = trigger;
  if (!state.radiation && state.lastQuestion === "radiation" && radiation) state.radiation = radiation;
  if (!state.treated && state.lastQuestion === "treated" && treated) state.treated = treated;
}

function reply(state, message, lastQuestion = "") {
  state.lastQuestion = lastQuestion;
  return { action: "REPLY", message };
}

function priceReply(state) {
  state.assessed = true;
  return reply(
    state,
    "Sau khi khám bác sĩ sẽ trao đổi kỹ lộ trình và chi phí cho mình ạ. Đặt lịch online bên em đang có ưu đãi 499k/5 buổi trị liệu bấm huyệt, mình tiện qua hôm nay hay ngày mai ạ?",
  );
}

function askDuration(state) {
  const s = subject(state);
  if (state.disease) return reply(state, `Dạ ${s} bị tình trạng này bao lâu rồi ạ?`, "duration");
  return reply(state, `Dạ tình trạng đau ${state.pain || "này"} của ${s} kéo dài bao lâu rồi ạ?`, "duration");
}

function askTrigger(state) {
  const s = subject(state);
  if (state.pain === "lưng") return reply(state, `Dạ ${s} đau tăng khi đi lại hay ngồi lâu ạ?`, "trigger");
  if (state.pain === "vai" || state.pain === "vai gáy") {
    return reply(state, `Dạ ${s} đau sau vận động hay tự nhiên đau ạ?`, "trigger");
  }
  if (state.pain === "gối") return reply(state, `Dạ ${s} đi lại đau nhiều hay nghỉ cũng đau ạ?`, "trigger");
  return reply(state, `Dạ ${s} đau sau vận động hay tự nhiên đau ạ?`, "trigger");
}

function askRadiation(state) {
  const s = subject(state);
  if (state.pain === "lưng" || /thắt lưng|tọa|thoát vị/.test(state.disease)) {
    return reply(state, `Dạ ${s} có đau lan xuống mông, chân hoặc tê chân không ạ?`, "radiation");
  }
  if (state.pain === "vai" || state.pain === "vai gáy") {
    return reply(state, `Dạ ${s} có đau lan xuống tay hoặc tê tay không ạ?`, "radiation");
  }
  if (state.pain === "gối") return reply(state, `Dạ ${s} đi lại có bị đau nhói hoặc cứng khớp không ạ?`, "radiation");
  return reply(state, `Dạ ${s} có bị lan đau hoặc tê không ạ?`, "radiation");
}

function assessmentReply(state) {
  const s = subject(state);
  state.assessed = true;

  if (state.disease) {
    return reply(
      state,
      `Dạ tình trạng này mình nên để bác sĩ kiểm tra kỹ mức độ ảnh hưởng rồi lên hướng trị liệu phù hợp cho ${s} ạ. ${s} tiện qua hôm nay hay ngày mai?`,
    );
  }

  if (state.pain === "lưng") {
    const likely = state.radiation && state.radiation !== "không"
      ? "thoát vị đĩa đệm thắt lưng hoặc đau thần kinh tọa"
      : "vấn đề cột sống thắt lưng";
    return reply(state, `Dạ dấu hiệu này có thể nghiêng về ${likely}. ${s} nên qua để bác sĩ kiểm tra kỹ hơn ạ.`);
  }

  if (state.pain === "vai" || state.pain === "vai gáy") {
    const likely = state.radiation && state.radiation !== "không"
      ? "thoái hóa đốt sống cổ hoặc chèn ép rễ thần kinh"
      : "căng cơ vùng vai gáy";
    return reply(state, `Dạ dấu hiệu này có thể nghiêng về ${likely}. ${s} nên qua để bác sĩ kiểm tra kỹ hơn ạ.`);
  }

  return reply(state, `Dạ tình trạng này mình nên qua để bác sĩ kiểm tra kỹ hơn ạ.`);
}

function handleDeterministicFlow(senderId, customerText) {
  const state = getCustomerState(senderId);
  updateStateFromText(state, customerText);
  const s = subject(state);

  if (isAddressQuestion(customerText)) {
    return reply(
      state,
      "Dạ IVA có 2 cơ sở: 33N Hoàng Quốc Việt, Tân Mỹ và 94 Đường 56, Bình Trưng ạ. Mình đang cần hỗ trợ tình trạng gì ạ?",
    );
  }

  if (isPing(customerText) && state.lastQuestion) {
    if (state.lastQuestion === "duration") return askDuration(state);
    if (state.lastQuestion === "trigger") return askTrigger(state);
    if (state.lastQuestion === "radiation") return askRadiation(state);
    if (state.lastQuestion === "treated") return reply(state, `Dạ em đây ạ, tình trạng này ${s} đã điều trị phương pháp nào chưa?`, "treated");
  }

  if (state.disease) {
    if (isTreatmentAbilityQuestion(customerText)) {
      if (!state.duration) {
        return reply(state, `Dạ bên em có hỗ trợ điều trị ${state.disease} bằng vật lý trị liệu ạ. ${s} bị tình trạng này bao lâu rồi?`, "duration");
      }
      if (!state.radiation) return askRadiation(state);
      return assessmentReply(state);
    }

    if (!state.treated) {
      return reply(state, `Dạ tình trạng này ${s} đã điều trị phương pháp nào chưa ạ?`, "treated");
    }
    if (!state.duration) return askDuration(state);
    if (!state.radiation) return askRadiation(state);
    if (state.askedPrice) return priceReply(state);
    return assessmentReply(state);
  }

  if (state.pain) {
    if (!state.duration) return askDuration(state);
    if (!state.trigger) return askTrigger(state);
    if (!state.radiation) return askRadiation(state);
    if (state.askedPrice) return priceReply(state);
    return assessmentReply(state);
  }

  if (state.askedPrice) {
    return reply(state, "Dạ mình đang đau ở vị trí nào để em tư vấn phù hợp hơn ạ?");
  }

  return null;
}

async function openaiReply(senderId, customerText) {
  if (!OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY");
    return { action: "HANDOFF", message: "" };
  }

  const history = getHistory(senderId);
  history.push({ role: "user", content: customerText });
  console.log("Incoming message:", { senderId, customerText });

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
      temperature: 0.35,
      max_output_tokens: 220,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("OpenAI error", response.status, errorText);
    return { action: "HANDOFF", message: "" };
  }

  const data = await response.json();
  const outputText =
    data.output_text ||
    data.output?.flatMap((item) => item.content || [])?.map((c) => c.text || "")?.join("") ||
    "";

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    console.error("AI returned non-JSON:", outputText);
    parsed = { action: "HANDOFF", message: "" };
  }

  if (parsed.action === "REPLY" && parsed.message) {
    history.push({ role: "assistant", content: parsed.message });
    console.log("AI reply:", { senderId, message: parsed.message });
  } else {
    history.push({ role: "assistant", content: "[HANDOFF_SILENT]" });
    console.log("AI silent handoff:", { senderId, customerText, parsed });
  }

  if (history.length > 24) history.splice(0, history.length - 24);
  return parsed;
}

async function graphApi(path, body) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error("Missing PAGE_ACCESS_TOKEN");
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${path}?access_token=${encodeURIComponent(
    PAGE_ACCESS_TOKEN,
  )}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error("Graph API error", response.status, await response.text());
  }
}

async function senderAction(recipientId, action) {
  await graphApi("me/messages", {
    recipient: { id: recipientId },
    sender_action: action,
  });
}

async function sendMessage(recipientId, message) {
  await graphApi("me/messages", {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: { text: message },
  });
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
  const message = event.message;

  if (!senderId || !message) return;
  if (message.is_echo) return;
  if (isDuplicate(message.mid)) return;

  const customerText = message.text?.trim();
  if (!customerText) {
    console.log("Non-text message, silent handoff:", senderId);
    return;
  }

  console.log("Webhook received text:", { senderId, customerText });

  try {
    await senderAction(senderId, "typing_on");
    const deterministic = handleDeterministicFlow(senderId, customerText);
    const ai = deterministic || (await openaiReply(senderId, customerText));

    if (ai.action !== "REPLY" || !ai.message) {
      console.log("Silent handoff:", { senderId, customerText });
      await senderAction(senderId, "typing_off");
      return;
    }

    await delay(naturalDelay(ai.message));
    await sendMessage(senderId, ai.message);
  } catch (error) {
    console.error("Message handling error:", error);
  } finally {
    await senderAction(senderId, "typing_off");
  }
}

async function handleWebhookPost(req, res) {
  const body = await readJson(req);
  if (body.object !== "page") {
    return json(res, 404, { error: "Unsupported object" });
  }

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      handleMessagingEvent(event);
    }
  }

  return text(res, 200, "EVENT_RECEIVED");
}

function handleWebhookVerify(req, res, url) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return text(res, 200, challenge || "");
  }

  return text(res, 403, "Forbidden");
}

function verifyMetaSignature(req, rawBody) {
  const appSecret = process.env.APP_SECRET;
  const signature = req.headers["x-hub-signature-256"];
  if (!appSecret || !signature) return true;

  const expected =
    "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
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
      });
    }

    if (req.method === "GET" && url.pathname === "/webhook") {
      return handleWebhookVerify(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      return handleWebhookPost(req, res);
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("Server error:", error);
    return json(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`IVA Chatpage Bot running on port ${PORT}`);
  console.log(`Webhook path: /webhook`);
});
