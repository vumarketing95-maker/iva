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
    const ai = await openaiReply(senderId, customerText);

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
