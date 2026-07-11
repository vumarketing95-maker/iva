import http from "node:http";
import crypto from "node:crypto";
import { IVA_SYSTEM_PROMPT, DEFAULT_HISTORY } from "./iva_rules.mjs";

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "iva_verify_2026";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";
const PAGE_TOKENS_RAW = process.env.PAGE_TOKENS || "";
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v25.0";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MIN_REPLY_DELAY_MS = Number(process.env.MIN_REPLY_DELAY_MS || 2500);
const MAX_REPLY_DELAY_MS = Number(process.env.MAX_REPLY_DELAY_MS || 6500);

const conversations = new Map();
const customerStates = new Map();
const processedMessageIds = new Set();
const humanTakenOverConversations = new Set();

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

function markHumanTakeover(pageId, customerId, reason = "page echo") {
  if (!pageId || !customerId) return;
  const chatKey = conversationKey(pageId, customerId);
  humanTakenOverConversations.add(chatKey);
  const state = getCustomerState(chatKey);
  state.humanTakeover = true;
  state.stage = "human_takeover";
  console.log("Human takeover locked", { chatKey, reason });
}

function isHumanTakenOver(chatKey) {
  if (humanTakenOverConversations.has(chatKey)) return true;
  const state = customerStates.get(chatKey);
  return Boolean(state?.humanTakeover);
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
  if (/(co vai gay|vai gay|dau vai gay|co gay|te tay)/.test(text)) return "vai gáy";
  if (/(dau vai|vai\b)/.test(text)) return "vai";
  if (/(that lung|dau lung|song lung|lung|te chan|than kinh toa)/.test(text)) return "lưng";
  if (/(dau goi|goi\b)/.test(text)) return "gối";
  if (/(hang|khop hang)/.test(text)) return "háng";
  if (/(ngon tay cai|ngon cai|dau ngon tay|dau ngon cai)/.test(text)) return "ngón tay cái";
  if (/(co tay|dau co tay)/.test(text)) return "cổ tay";
  if (/(khuyu tay|elbow|tennis elbow|dau tay|\btay\b)/.test(text)) return "tay";
  return "";
}

function detectDisease(rawText) {
  const text = chatText(rawText);
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
  if (/(hom qua|moi day|gan day|vua bi|moi|tuan|thang|nam|ngay)/.test(text)) return rawText.trim();
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

function resetClinicalIfNewTopic(state, pain, disease) {
  const changedPain = pain && state.pain && pain !== state.pain;
  const changedDisease = disease && state.disease && disease !== state.disease;
  if (!changedPain && !changedDisease) return;

  state.pain = "";
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

  if (state.hasPhone || state.wantsBooking) state.temperature = "hot";
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

  const pain = detectPain(rawText);
  const disease = detectDisease(rawText);
  resetClinicalIfNewTopic(state, pain, disease);

  const yesNo = detectYesNo(rawText);
  const duration = detectDuration(rawText);
  const trigger = detectTrigger(rawText);
  const radiation = detectRadiation(rawText);
  const treated = detectTreatment(rawText);
  const phoneNumber = extractPhoneNumber(rawText);
  const customerName = detectCustomerName(rawText);
  const appointmentTime = detectAppointmentTime(rawText);

  if (pain) state.pain = pain;
  if (disease) state.disease = disease;
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

  if (state.disease) return state.disease;
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
  const currentPain = detectPain(customerText);
  const currentDisease = detectDisease(customerText);
  const currentArea = detectAreaHint(customerText);

  if (isOutOfScopeQuestion(customerText)) return handoff("out of scope needs human");
  if (isScheduleChangeOrDelay(customerText)) return handoff("schedule change/delay needs human");
  if (hasPhoneNumber(customerText)) return bookingReply(state, customerText);
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

function responseGuardSingle(state, rawMessage) {
  const message = rawMessage.trim();
  const textValue = normalizeText(message);
  const lastText = normalizeText(state.lastBotMessage || "");
  const questionKey = messageQuestionKey(message);

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
  if (/bao dung phan uu dai|bao dung uu dai/.test(textValue)) return "ask_price_problem";
  if (/bao lau|lau chua|keo dai/.test(textValue)) return "ask_duration";
  if (/bi lau chua|dau .* lau chua/.test(textValue)) return "ask_duration";
  if (/van dong hay tu nhien|sau van dong hay tu nhien|di lai ngoi lau hay tu nhien|di lai hay ngoi lau/.test(textValue)) return "ask_trigger";
  if (/ngoi lau|dung dien thoai|di lai co thay dau hon|nhanh moi hon/.test(textValue)) return "ask_trigger";
  if (/cam nam|gap duoi|xoay co tay|xoay tay/.test(textValue)) return "ask_hand_function";
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
    priceSent: state.priceSent,
    addressSent: state.addressSent,
    bookingAsked: state.bookingAsked,
    assessmentSent: state.assessmentSent,
  });
}

async function openaiReply(senderId, customerText) {
  if (!OPENAI_API_KEY) return handoff("missing OPENAI_API_KEY");

  const history = getHistory(senderId);
  const state = getCustomerState(senderId);
  const brainContext = {
    customerText,
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
      phoneNumber: state.phoneNumber,
      appointmentTime: state.appointmentTime,
    },
    nextGoal: state.nextGoal,
    nextBestAction: state.nextBestAction,
    hardRules: [
      "Trả lời đúng ý khách vừa hỏi trước, không quay lại sườn cũ.",
      "Nếu hỏi địa chỉ/số mấy thì gửi địa chỉ.",
      "Nếu đủ tên/SĐT/giờ/cơ sở thì xác nhận lịch.",
      "Nếu khách hỏi giá sau khi đủ dấu hiệu thì báo ưu đãi 499k/5 buổi.",
      "Không hỏi lặp lại.",
      "Không sai vùng: lưng hỏi chân, cổ/vai gáy hỏi tay, gối hỏi gối.",
      "Nếu không chắc thì HANDOFF.",
    ],
  };
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

  if (parsed.action === "REPLY" && parsed.message) {
    history.push({ role: "assistant", content: parsed.message });
  } else {
    history.push({ role: "assistant", content: "[HANDOFF_SILENT]" });
  }

  if (history.length > 24) history.splice(0, history.length - 24);
  return parsed;
}

async function smartReply(chatKey, customerText, deterministicReply = null) {
  const state = getCustomerState(chatKey);
  if (deterministicReply) {
    const guarded = responseGuard(state, deterministicReply);
    if (guarded.action === "REPLY" && guarded.message) return guarded;
    console.log("Deterministic reply blocked, trying AI brain", { chatKey, reason: guarded.message || "guarded" });
  }

  const aiReply = await openaiReply(chatKey, customerText);
  return responseGuard(state, aiReply);
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
  if (message.is_echo) {
    const echoPageId = event.sender?.id || "";
    const echoCustomerId = event.recipient?.id || "";
    if (!message.app_id) {
      markHumanTakeover(echoPageId, echoCustomerId, "human/page echo");
    } else {
      console.log("Ignored app echo", { pageId: echoPageId, customerId: echoCustomerId, appId: message.app_id });
    }
    return;
  }
  if (isDuplicate(message.mid)) return;

  const customerText = message.text?.trim();
  if (!customerText) return;

  try {
    const chatKey = conversationKey(pageId, senderId);
    if (isHumanTakenOver(chatKey)) {
      console.log("AI skipped because human already took over", { chatKey, customerText });
      return;
    }
    await senderAction(senderId, "typing_on", pageId);
    const deterministic = handleDeterministicFlow(chatKey, customerText);
    const state = getCustomerState(chatKey);
    const guarded = await smartReply(chatKey, customerText, deterministic);

    if (guarded.action !== "REPLY" || !guarded.message) {
      logLeadSignal(chatKey, state, customerText, "");
      await senderAction(senderId, "typing_off", pageId);
      return;
    }

    const messagesToSend = Array.isArray(guarded.messages) ? guarded.messages : [guarded.message];
    for (const outgoingMessage of messagesToSend) {
      await delay(naturalDelay(outgoingMessage));
      await sendMessage(senderId, outgoingMessage, pageId);
      state.lastBotMessage = outgoingMessage;
      const sentQuestionKey = messageQuestionKey(outgoingMessage);
      if (sentQuestionKey) state.sentQuestionKeys.add(sentQuestionKey);
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
  if (body.object !== "page") return json(res, 404, { error: "Unsupported object" });

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
