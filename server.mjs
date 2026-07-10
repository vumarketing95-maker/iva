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

const approvedTemplates = {
  address:
    "Dạ IVA có 2 cơ sở: 33N Hoàng Quốc Việt, Tân Mỹ và 94 Đường 56, Bình Trưng ạ. Mình đang cần hỗ trợ tình trạng gì ạ?",
  askProblemForPrice: "Dạ mình đang đau ở vị trí nào để em tư vấn phù hợp hơn ạ?",
  price:
    "Sau khi khám bác sĩ sẽ trao đổi kỹ lộ trình và chi phí cho mình ạ. Đặt lịch online bên em đang có ưu đãi 499k/5 buổi trị liệu bấm huyệt, mình tiện qua hôm nay hay ngày mai ạ?",
  busy: "Dạ không sao ạ, khi nào mình sắp xếp được em giữ ưu đãi phù hợp cho mình nhé.",
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
    h1 { font-size: 30px; }
    h2 { margin-top: 28px; font-size: 20px; }
    ul { padding-left: 22px; }
  </style>
</head>
<body>
  <h1>Chính sách quyền riêng tư và xóa dữ liệu người dùng</h1>
  <p><strong>Phòng khám Phục hồi chức năng IVA</strong></p>

  <p>Phòng khám Phục hồi chức năng IVA tôn trọng quyền riêng tư của khách hàng khi tương tác với Fanpage và các kênh tư vấn trực tuyến của phòng khám.</p>

  <h2>1. Thông tin chúng tôi thu thập</h2>
  <p>Khi khách hàng nhắn tin qua Fanpage, chúng tôi có thể tiếp nhận các thông tin do khách hàng chủ động cung cấp, bao gồm:</p>
  <ul>
    <li>Họ tên</li>
    <li>Số điện thoại</li>
    <li>Nội dung tin nhắn tư vấn</li>
    <li>Tình trạng cơ xương khớp khách hàng chia sẻ</li>
    <li>Nhu cầu đặt lịch khám hoặc tư vấn</li>
    <li>Thời gian và cơ sở khách hàng muốn đến</li>
  </ul>
  <p>Chúng tôi không yêu cầu khách hàng cung cấp thông tin nhạy cảm không cần thiết qua tin nhắn.</p>

  <h2>2. Mục đích sử dụng thông tin</h2>
  <p>Thông tin khách hàng được sử dụng để:</p>
  <ul>
    <li>Tư vấn tình trạng ban đầu</li>
    <li>Hỗ trợ đặt lịch khám</li>
    <li>Chăm sóc khách hàng</li>
    <li>Xác nhận lịch hẹn</li>
    <li>Cải thiện chất lượng tư vấn và dịch vụ</li>
  </ul>

  <h2>3. Chia sẻ dữ liệu</h2>
  <p>IVA không bán, trao đổi hoặc chia sẻ thông tin cá nhân của khách hàng cho bên thứ ba vì mục đích thương mại.</p>
  <p>Thông tin chỉ được sử dụng nội bộ trong phạm vi phòng khám hoặc các hệ thống hỗ trợ vận hành tư vấn, đặt lịch và chăm sóc khách hàng.</p>

  <h2>4. Lưu trữ và bảo mật</h2>
  <p>Chúng tôi áp dụng các biện pháp phù hợp để bảo vệ thông tin khách hàng khỏi truy cập trái phép, mất mát hoặc sử dụng sai mục đích.</p>

  <h2>5. Yêu cầu xóa dữ liệu người dùng</h2>
  <p>Khách hàng có thể yêu cầu xóa dữ liệu đã cung cấp bằng một trong các cách sau:</p>
  <ul>
    <li>Nhắn tin trực tiếp vào Fanpage Phòng khám Phục hồi chức năng IVA với nội dung: “Yêu cầu xóa dữ liệu”</li>
    <li>Gọi hoặc nhắn tin cho phòng khám để yêu cầu hỗ trợ</li>
  </ul>
  <p>Sau khi tiếp nhận yêu cầu, IVA sẽ kiểm tra và thực hiện xóa hoặc ẩn thông tin liên quan trong phạm vi hệ thống quản lý của phòng khám.</p>

  <h2>6. Thông tin liên hệ</h2>
  <p><strong>Phòng khám Phục hồi chức năng IVA</strong></p>
  <ul>
    <li>CN1: 33N Hoàng Quốc Việt, Tân Mỹ, TP.HCM</li>
    <li>CN2: 94 Đường 56, Bình Trưng, TP.HCM</li>
  </ul>
  <p>Nếu cần hỗ trợ về quyền riêng tư hoặc xóa dữ liệu, khách hàng vui lòng liên hệ Fanpage chính thức của phòng khám.</p>
</body>
</html>`;

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
      askedAddress: false,
      wantsBooking: false,
      hasPhone: false,
      objection: "",
      leadGroup: "unknown",
      temperature: "cold",
      stage: "new",
      lastQuestion: "",
      askedFields: new Set(),
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

function expandChatShortcuts(text) {
  return ` ${text} `
    .replace(/\bbn\b/g, " bao nhieu ")
    .replace(/\bbnhieu\b/g, " bao nhieu ")
    .replace(/\bdc\b/g, " duoc ")
    .replace(/\bdc k\b/g, " duoc khong ")
    .replace(/\bdc ko\b/g, " duoc khong ")
    .replace(/\bđc\b/g, " duoc ")
    .replace(/\bk\b/g, " khong ")
    .replace(/\bko\b/g, " khong ")
    .replace(/\bkh\b/g, " khong ")
    .replace(/\bc\b/g, " co ")
    .replace(/\bđc ko\b/g, " duoc khong ")
    .replace(/\s+/g, " ")
    .trim();
}

function chatText(rawText) {
  return expandChatShortcuts(normalizeText(rawText));
}

function detectPersona(rawText, state) {
  const text = chatText(rawText);
  if (/\banh\b/.test(text)) state.persona = "anh";
  if (/\bchi\b/.test(text)) state.persona = "chị";
  if (/\bco\b/.test(text)) state.persona = "cô";
  if (/\bchu\b/.test(text)) state.persona = "chú";
}

function subject(state) {
  return state.persona || "mình";
}

function detectPain(rawText) {
  const text = chatText(rawText);
  if (/(co vai gay|vai gay|dau vai gay|te tay)/.test(text)) return "vai gáy";
  if (/(dau vai|vai\b)/.test(text)) return "vai";
  if (/(dau lung|lung|that lung|te chan|than kinh toa)/.test(text)) return "lưng";
  if (/(dau goi|goi\b)/.test(text)) return "gối";
  if (/(hang|khop hang)/.test(text)) return "háng";
  if (/(tay|khuyu tay|elbow|tennis elbow)/.test(text)) return "tay";
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
  if (/(hom qua|moi|gan day|vua bi|2 tuan|tuan|thang|nam|ngay)/.test(text)) return rawText.trim();
  if (/^\d+\s*(ngay|tuan|thang|nam)/.test(text)) return rawText.trim();
  return "";
}

function detectTrigger(rawText) {
  const text = chatText(rawText);
  if (/(di moi dau|di lai|di dung|di la dau|di thay dau|di lai thay dau|di lai.*dau)/.test(text)) return "đi lại đau";
  if (/(ngoi lau|ngoi)/.test(text)) return "ngồi lâu đau";
  if (/(van dong|choi the thao|be nang|tap|the thao)/.test(text)) return "vận động";
  if (/(tu nhien|tu dung)/.test(text)) return "tự nhiên";
  return "";
}

function detectRadiation(rawText) {
  const text = chatText(rawText);
  if (/(te tay|lan xuong tay|moi tay|dau dau)/.test(text)) return "tay";
  if (/(te chan|lan xuong chan|lan xuong mong|moi chan)/.test(text)) return "chân";
  if (/^(co|uh|u|vang|da co|co em|vang em|da)$/i.test(text)) return "có";
  if (/^(khong|k|ko|khong em|k em|ko em|khong a|k a|ko a|khong dau|khong co)$/i.test(text)) return "không";
  return "";
}

function detectTreatment(rawText) {
  const text = chatText(rawText);
  if (/(chua|chưa)/.test(rawText) || /\bchua\b/.test(text)) return "chưa";
  if (/(co cham cuu|cham cuu|vat ly tri lieu|vltl|uong thuoc|da dieu tri|co di)/.test(text)) return rawText.trim();
  return "";
}

function detectYesNo(rawText) {
  const text = chatText(rawText);
  if (/^(co|uh|u|vang|da|co em|vang em|da co|co a|co anh|co chi)$/i.test(text)) return "có";
  if (/^(khong|khong em|khong a|khong anh|khong chi|khong dau|khong co|chua|chua em)$/i.test(text)) return "không";
  return "";
}

function isPriceQuestion(rawText) {
  const text = chatText(rawText);
  return /(gia|phi|chi phi|bao nhieu|bn|bao tien|mac|dat)/.test(text);
}

function isTreatmentAbilityQuestion(rawText) {
  const text = chatText(rawText);
  return /(co dieu tri|dieu tri duoc|tri duoc|ho tro dieu tri|co chua duoc)/.test(text);
}

function isAddressQuestion(rawText) {
  const text = chatText(rawText);
  return /^(dia chi|dc|duoc chi|o dau|ben minh o dau|phong kham o dau)$/.test(text) || /(dia chi|o dau)/.test(text);
}

function isPing(rawText) {
  const text = chatText(rawText);
  return /^(alo|hello|helo|em oi|e oi|co ai khong)$/.test(text);
}

function hasPhoneNumber(rawText) {
  return /(?:\+?84|0)(?:\d[\s.-]?){8,10}\d/.test(rawText);
}

function isBookingIntent(rawText) {
  const text = chatText(rawText);
  return /(hom nay|ngay mai|qua duoc|qua kham|dat lich|giu lich|may gio|dia chi dau|o dau)/.test(text);
}

function detectObjection(rawText) {
  const text = chatText(rawText);
  if (/(so dat|mac|dat qua|bao tien|so phat sinh|ep mua|co ep)/.test(text)) return "cost_concern";
  if (/(ban|chua sap xep|de suy nghi|chua co thoi gian)/.test(text)) return "busy";
  return "";
}

function classifyLead(state) {
  const hasClinicalSignal = Boolean(state.pain || state.disease || state.duration || state.trigger || state.radiation);
  const pathologySignal =
    Boolean(state.disease) ||
    (state.duration && /(thang|nam)/i.test(normalizeText(state.duration))) ||
    (state.radiation && state.radiation !== "không") ||
    Boolean(state.treated && state.treated !== "chưa");

  if (state.hasPhone || state.wantsBooking) {
    state.temperature = "hot";
  } else if (state.askedPrice || state.askedAddress || pathologySignal) {
    state.temperature = "warm";
  } else {
    state.temperature = hasClinicalSignal ? "warm" : "cold";
  }

  if (state.hasPhone) state.leadGroup = "left_phone";
  else if (state.wantsBooking) state.leadGroup = "booking_intent";
  else if (state.objection) state.leadGroup = state.objection;
  else if (state.askedPrice) state.leadGroup = "price_question";
  else if (state.askedAddress) state.leadGroup = "address_question";
  else if (state.disease) state.leadGroup = "known_disease";
  else if (state.pain) state.leadGroup = pathologySignal ? "likely_pathology" : "symptom_unknown";
  else state.leadGroup = "unknown";

  return state;
}

function updateStateFromText(state, rawText) {
  detectPersona(rawText, state);
  const yesNo = detectYesNo(rawText);
  const pain = detectPain(rawText);
  const disease = detectDisease(rawText);
  const duration = detectDuration(rawText);
  const trigger = detectTrigger(rawText);
  const radiation = detectRadiation(rawText);
  const treated = detectTreatment(rawText);

  if (yesNo && state.lastQuestion === "radiation") state.radiation = yesNo;
  if (yesNo && state.lastQuestion === "treated") state.treated = yesNo === "không" ? "chưa" : "có";
  if (!trigger && state.lastQuestion === "trigger" && /dau/.test(chatText(rawText))) {
    if (/di/.test(chatText(rawText))) state.trigger = "đi lại đau";
    if (/ngoi/.test(chatText(rawText))) state.trigger = "ngồi lâu đau";
    if (/tu nhien/.test(chatText(rawText))) state.trigger = "tự nhiên";
  }

  if (pain && state.pain && pain !== state.pain) {
    state.duration = "";
    state.trigger = "";
    state.radiation = "";
    state.treated = "";
    state.askedPrice = false;
    state.lastQuestion = "";
    state.assessed = false;
  }

  if (disease && state.disease && disease !== state.disease) {
    state.duration = "";
    state.trigger = "";
    state.radiation = "";
    state.treated = "";
    state.askedPrice = false;
    state.lastQuestion = "";
    state.assessed = false;
  }

  if (pain) state.pain = pain;
  if (disease) state.disease = disease;
  if (duration) state.duration = duration;
  if (trigger) state.trigger = trigger;
  if (radiation) state.radiation = radiation;
  if (treated) state.treated = treated;
  if (isPriceQuestion(rawText)) state.askedPrice = true;
  if (isAddressQuestion(rawText)) state.askedAddress = true;
  if (isBookingIntent(rawText)) state.wantsBooking = true;
  if (hasPhoneNumber(rawText)) state.hasPhone = true;
  const objection = detectObjection(rawText);
  if (objection) state.objection = objection;

  if (!state.duration && state.lastQuestion === "duration" && duration) state.duration = duration;
  if (!state.trigger && state.lastQuestion === "trigger" && trigger) state.trigger = trigger;
  if (!state.radiation && state.lastQuestion === "radiation" && radiation) state.radiation = radiation;
  if (!state.treated && state.lastQuestion === "treated" && treated) state.treated = treated;

  classifyLead(state);
}

function reply(state, message, lastQuestion = "") {
  state.lastQuestion = lastQuestion;
  if (lastQuestion) state.askedFields.add(lastQuestion);
  return { action: "REPLY", message };
}

function priceReply(state) {
  state.assessed = true;
  state.stage = "price_presented";
  return reply(
    state,
    approvedTemplates.price,
  );
}

function askDuration(state) {
  if (state.lastQuestion === "duration") return { action: "HANDOFF", message: "" };
  if (state.askedFields.has("duration")) return askTrigger(state);
  state.stage = "asking_duration";
  const s = subject(state);
  if (state.disease) return reply(state, `Dạ ${s} bị tình trạng này bao lâu rồi ạ?`, "duration");
  return reply(state, `Dạ tình trạng đau ${state.pain || "này"} của ${s} kéo dài bao lâu rồi ạ?`, "duration");
}

function askTrigger(state) {
  if (state.lastQuestion === "trigger") return askRadiation(state);
  if (state.askedFields.has("trigger")) return askRadiation(state);
  state.stage = "asking_trigger";
  const s = subject(state);
  if (state.pain === "lưng") return reply(state, `Dạ ${s} đau tăng khi đi lại, ngồi lâu hay tự nhiên đau ạ?`, "trigger");
  if (state.pain === "vai" || state.pain === "vai gáy") {
    return reply(state, `Dạ ${s} đau sau vận động hay tự nhiên đau ạ?`, "trigger");
  }
  if (state.pain === "gối") return reply(state, `Dạ ${s} đi lại đau nhiều hay nghỉ cũng đau ạ?`, "trigger");
  return reply(state, `Dạ ${s} đau sau vận động hay tự nhiên đau ạ?`, "trigger");
}

function askRadiation(state) {
  if (state.lastQuestion === "radiation") return assessmentReply(state);
  if (state.askedFields.has("radiation")) return assessmentReply(state);
  state.stage = "asking_radiation";
  const s = subject(state);
  if (state.pain === "lưng" || /thắt lưng|tọa|thoát vị đĩa đệm/.test(state.disease)) {
    return reply(state, `Dạ ${s} có đau lan xuống mông, chân hoặc tê chân không ạ?`, "radiation");
  }
  if (state.pain === "vai" || state.pain === "vai gáy" || /cổ/.test(state.disease)) {
    return reply(state, `Dạ ${s} có đau lan xuống tay hoặc tê tay không ạ?`, "radiation");
  }
  if (state.pain === "gối") return reply(state, `Dạ ${s} đi lại có bị đau nhói hoặc cứng khớp không ạ?`, "radiation");
  return reply(state, `Dạ ${s} có bị lan đau hoặc tê không ạ?`, "radiation");
}

function assessmentReply(state) {
  const s = subject(state);
  state.assessed = true;
  state.stage = "assessed";

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
      approvedTemplates.address,
    );
  }

  if (state.hasPhone) {
    state.stage = "phone_captured";
    return reply(state, "Dạ em nhận được số của mình rồi ạ. Mình muốn qua cơ sở Hoàng Quốc Việt hay Bình Trưng để em giữ lịch phù hợp?");
  }

  if (state.objection === "busy") {
    state.stage = "soft_close_busy";
    return reply(state, approvedTemplates.busy);
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
    return reply(state, approvedTemplates.askProblemForPrice);
  }

  return null;
}

function responseGuard(state, ai) {
  if (!ai || ai.action !== "REPLY" || !ai.message) return ai;
  const message = ai.message.trim();
  const text = normalizeText(message);

  if (/\bban\b|quy khach|tinh trang cu the/.test(text)) {
    console.log("Guard blocked robotic wording:", { message });
    return { action: "HANDOFF", message: "" };
  }

  if (state.pain && /vi tri nao|dau o dau/.test(text)) {
    console.log("Guard blocked repeated pain location:", { pain: state.pain, message });
    return { action: "HANDOFF", message: "" };
  }

  if (state.duration && /bao lau|lau chua|keo dai/.test(text) && state.askedFields.has("duration")) {
    console.log("Guard blocked repeated duration:", { duration: state.duration, message });
    return { action: "HANDOFF", message: "" };
  }

  if (state.pain === "lưng" && /(te tay|xuong tay)/.test(text)) {
    return { action: "REPLY", message: `Dạ ${subject(state)} có đau lan xuống mông, chân hoặc tê chân không ạ?` };
  }

  if ((state.pain === "vai" || state.pain === "vai gáy") && /(te chan|xuong chan|xuong mong)/.test(text)) {
    return { action: "REPLY", message: `Dạ ${subject(state)} có đau lan xuống tay hoặc tê tay không ạ?` };
  }

  if (message.length > 180) {
    console.log("Guard blocked long message:", { length: message.length, message });
    return { action: "HANDOFF", message: "" };
  }

  return ai;
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
    objection: state.objection,
  });
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
    const rawAi = deterministic || (await openaiReply(senderId, customerText));
    const state = getCustomerState(senderId);
    const ai = responseGuard(state, rawAi);

    if (ai.action !== "REPLY" || !ai.message) {
      console.log("Silent handoff:", { senderId, customerText });
      logLeadSignal(senderId, state, customerText, "");
      await senderAction(senderId, "typing_off");
      return;
    }

    await delay(naturalDelay(ai.message));
    await sendMessage(senderId, ai.message);
    logLeadSignal(senderId, state, customerText, ai.message);
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
        privacy: "/privacy-policy",
        dataDeletion: "/data-deletion",
      });
    }

    if (req.method === "GET" && (url.pathname === "/privacy-policy" || url.pathname === "/data-deletion")) {
      return html(res, 200, privacyPolicyHtml);
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
