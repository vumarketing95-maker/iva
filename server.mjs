import http from "node:http";
import crypto from "node:crypto";
import { IVA_SYSTEM_PROMPT, DEFAULT_HISTORY } from "./iva_rules.mjs";

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "iva_verify_2026";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v25.0";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MIN_REPLY_DELAY_MS = Number(process.env.MIN_REPLY_DELAY_MS || 2500);
const MAX_REPLY_DELAY_MS = Number(process.env.MAX_REPLY_DELAY_MS || 6500);

const conversations = new Map();
const customerStates = new Map();
const processedMessageIds = new Set();

const CLINIC = {
  address:
    "Dạ IVA có 2 cơ sở: 33N Hoàng Quốc Việt, Tân Mỹ và 94 Đường 56, Bình Trưng ạ.",
  addressAsk: "Mình tiện cơ sở nào để em giữ lịch cho mình?",
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
      lastQuestion: "",
      askedFields: new Set(),
      assessmentSent: false,
      priceSent: false,
      addressSent: false,
      bookingAsked: false,
      specificDiseaseAnswered: false,
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

function isPriceQuestion(rawText) {
  const text = chatText(rawText);
  return /(gia|phi|chi phi|bao nhieu|bao tien|mac|dat|ton kem|bang gia|buoi le|phat sinh|ep mua)/.test(text);
}

function isAddressQuestion(rawText) {
  const text = chatText(rawText);
  return /(dia chi|o dau|cho xin dia chi|xin dia chi|kiem tra o dau|ben minh co kiem tra khong|co kiem tra khong)/.test(text);
}

function isBookingIntent(rawText) {
  const text = chatText(rawText);
  return /(hom nay|ngay mai|may gio|co lich khong|dat lich|giu lich|lich nhu the nao|qua duoc|qua kham|binh trung|hoang quoc viet)/.test(text);
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
  return /^(alo|hello|helo|em oi|e oi|co ai khong)$/.test(text);
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

  if (pain) state.pain = pain;
  if (disease) state.disease = disease;
  if (duration) state.duration = duration;
  if (trigger) state.trigger = trigger;
  if (radiation) state.radiation = radiation;
  if (treated) state.treated = treated;

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

  const objection = detectObjection(rawText);
  if (objection) state.objection = objection;

  classifyLead(state);
}

function result(state, message, lastQuestion = "") {
  const clean = alignPronouns(state, message).trim();
  state.lastQuestion = lastQuestion;
  if (lastQuestion) state.askedFields.add(lastQuestion);
  return { action: "REPLY", message: clean };
}

function handoff(reason = "") {
  if (reason) console.log("Silent handoff reason:", reason);
  return { action: "HANDOFF", message: "" };
}

function askProblem(state) {
  state.stage = "asking_problem";
  return result(state, "Dạ mình đang đau phần nào ạ?", "problem");
}

function askDuration(state) {
  if (state.duration || state.askedFields.has("duration")) return askTrigger(state);
  state.stage = "asking_duration";
  const s = subject(state);
  if (state.disease) return result(state, `Dạ ${s} bị lâu chưa ạ?`, "duration");
  return result(state, `Dạ ${s} đau ${state.pain || "phần này"} lâu chưa ạ?`, "duration");
}

function askTrigger(state) {
  if (state.trigger || state.askedFields.has("trigger")) return askRadiation(state);
  state.stage = "asking_trigger";
  const s = subject(state);
  if (state.pain === "lưng") return result(state, `Dạ ${s} đi lại hoặc ngồi lâu có đau hơn không ạ?`, "trigger");
  if (state.pain === "gối") return result(state, `Dạ ${s} đi lại có đau nhiều hơn không ạ?`, "trigger");
  if (state.pain === "háng") return result(state, `Dạ ${s} đau khi đi lại hay lúc đứng lên ngồi xuống ạ?`, "trigger");
  if (state.pain === "vai" || state.pain === "vai gáy") return result(state, `Dạ ${s} đau sau vận động hay ngồi làm việc lâu ạ?`, "trigger");
  return result(state, `Dạ ${s} đau sau vận động hay tự nhiên đau ạ?`, "trigger");
}

function askRadiation(state) {
  if (state.radiation || state.askedFields.has("radiation")) return assessmentReply(state);
  state.stage = "asking_radiation";
  const s = subject(state);
  if (state.pain === "lưng" || /(tọa|thoát vị)/.test(state.disease)) {
    return result(state, `Dạ ${s} có đau lan xuống mông, chân hoặc tê chân không ạ?`, "radiation");
  }
  if (state.pain === "vai" || state.pain === "vai gáy" || /cổ/.test(state.disease)) {
    return result(state, `Dạ ${s} có đau lan xuống tay hoặc tê tay không ạ?`, "radiation");
  }
  if (state.pain === "gối") {
    return result(state, `Dạ ${s} đi lại có đau nhói hoặc cứng khớp không ạ?`, "radiation");
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
  if (!hasEnoughForPrice(state)) return nextClinicalQuestionBeforePrice(state);
  if (!state.assessmentSent) {
    state.assessmentSent = true;
    const likely = diseaseLabel(state);
    const prefix = likely ? `Dạ dấu hiệu này có thể nghiêng về ${likely}. ` : "";
    state.priceSent = true;
    state.stage = "price_presented";
    return result(state, `${prefix}${CLINIC.price} ${CLINIC.priceClose}`);
  }
  if (state.priceSent) return bookingReply(state);
  state.priceSent = true;
  state.stage = "price_presented";
  return result(state, `${CLINIC.price} ${CLINIC.priceClose}`);
}

function hasEnoughForPrice(state) {
  if (state.disease) {
    return Boolean(state.duration && (state.treated || state.radiation));
  }

  if (!state.pain) return false;
  if (state.pain === "lưng" || state.pain === "vai" || state.pain === "vai gáy") {
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

function addressReply(state) {
  state.addressSent = true;
  state.stage = "address_sent";
  if (state.assessmentSent || state.wantsBooking || state.priceSent) {
    return result(state, `${CLINIC.address} ${CLINIC.addressAsk}`);
  }
  return result(state, `${CLINIC.address} Mình đang đau phần nào ạ?`, "problem");
}

function bookingReply(state) {
  if (state.hasPhone) {
    state.stage = "phone_captured";
    return result(state, "Dạ em nhận được SĐT rồi ạ. Mình tiện cơ sở Hoàng Quốc Việt hay Bình Trưng để em giữ lịch?");
  }

  if (!state.bookingAsked) {
    state.bookingAsked = true;
    state.stage = "booking_branch";
    return result(state, "Dạ hôm nay mình qua được ạ. Mình tiện Hoàng Quốc Việt hay Bình Trưng?");
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
  if (!state.radiation) return askRadiation(state);
  if (state.askedPrice) return priceReply(state);
  return assessmentReply(state);
}

function handleDeterministicFlow(senderId, customerText) {
  const state = getCustomerState(senderId);
  state.messageCount += 1;
  updateStateFromText(state, customerText);

  if (hasPhoneNumber(customerText)) return bookingReply(state);
  if (isAddressQuestion(customerText)) return addressReply(state);
  if (isBookingIntent(customerText) && (state.assessmentSent || state.priceSent || state.wantsBooking)) return bookingReply(state);
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
  if (!ai || ai.action !== "REPLY" || !ai.message) return ai;
  const message = ai.message.trim();
  const textValue = normalizeText(message);
  const lastText = normalizeText(state.lastBotMessage || "");
  const questionKey = messageQuestionKey(message);

  if (lastText && textValue === lastText) return handoff("blocked exact duplicate");
  if (questionKey && state.sentQuestionKeys.has(questionKey)) return handoff(`blocked repeated question key: ${questionKey}`);
  if (hasPronounConflict(state, message)) return handoff("blocked pronoun conflict");
  if (/\bban\b|quy khach|tinh trang cu the/.test(textValue)) return handoff("blocked robotic wording");
  if (message.length > 190) return handoff("blocked long message");
  if (state.pain && /vi tri nao|dau o dau/.test(textValue)) return handoff("blocked repeated pain location");
  if (state.duration && /bao lau|lau chua|keo dai/.test(textValue) && state.askedFields.has("duration")) return handoff("blocked repeated duration");
  if (state.trigger && /(van dong hay tu nhien|di lai hay ngoi lau)/.test(textValue) && state.askedFields.has("trigger")) return handoff("blocked repeated trigger");
  if (state.radiation && /(lan dau|te khong|te tay|te chan)/.test(textValue) && state.askedFields.has("radiation")) return handoff("blocked repeated radiation");

  if (state.pain === "lưng" && /(te tay|xuong tay)/.test(textValue)) {
    return handoff("blocked wrong region: back asked hand");
  }

  if ((state.pain === "vai" || state.pain === "vai gáy") && /(te chan|xuong chan|xuong mong)/.test(textValue)) {
    return handoff("blocked wrong region: neck asked leg");
  }

  return { action: "REPLY", message };
}

function messageQuestionKey(message) {
  const textValue = normalizeText(message);
  if (!textValue.includes("khong") && !textValue.includes("chua") && !textValue.includes("bao lau") && !textValue.includes("hay")) {
    return "";
  }

  if (/dau o vung nao|dang dau o vung nao|vi tri nao|dau o dau/.test(textValue)) return "ask_problem_location";
  if (/dang dau phan nao|dau phan nao/.test(textValue)) return "ask_problem_location";
  if (/bao lau|lau chua|keo dai/.test(textValue)) return "ask_duration";
  if (/van dong hay tu nhien|sau van dong hay tu nhien|di lai ngoi lau hay tu nhien|di lai hay ngoi lau/.test(textValue)) return "ask_trigger";
  if (/lan xuong tay|te tay/.test(textValue)) return "ask_arm_radiation";
  if (/lan xuong mong|lan xuong chan|te chan/.test(textValue)) return "ask_leg_radiation";
  if (/dieu tri phuong phap nao|da dieu tri|da di dieu tri/.test(textValue)) return "ask_treatment";
  if (/co so hoang quoc viet hay binh trung|tien co so nao/.test(textValue)) return "ask_branch";
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
    group: state.leadGroup,
    temperature: state.temperature,
    stage: state.stage,
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
  history.push({ role: "user", content: customerText });

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

async function graphApi(path, body) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error("Missing PAGE_ACCESS_TOKEN");
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${path}?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) console.error("Graph API error", response.status, await response.text());
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
  if (!customerText) return;

  try {
    await senderAction(senderId, "typing_on");
    const deterministic = handleDeterministicFlow(senderId, customerText);
    const state = getCustomerState(senderId);
    const rawReply = deterministic || (await openaiReply(senderId, customerText));
    const guarded = responseGuard(state, rawReply);

    if (guarded.action !== "REPLY" || !guarded.message) {
      logLeadSignal(senderId, state, customerText, "");
      await senderAction(senderId, "typing_off");
      return;
    }

    await delay(naturalDelay(guarded.message));
    await sendMessage(senderId, guarded.message);
    state.lastBotMessage = guarded.message;
    const sentQuestionKey = messageQuestionKey(guarded.message);
    if (sentQuestionKey) state.sentQuestionKeys.add(sentQuestionKey);
    logLeadSignal(senderId, state, customerText, guarded.message);
  } catch (error) {
    console.error("Message handling error:", error);
  } finally {
    await senderAction(senderId, "typing_off");
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
