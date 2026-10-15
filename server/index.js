import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";
import jwt from "jsonwebtoken";
import multer from "multer";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const app = express();
const port = Number(process.env.PORT || 3001);
const appSecret = process.env.APP_SECRET;
const redisUrl = process.env.REDIS_URL;
const cookieName = "filber_session";
const freeMessageLimit = 5;
const verifiedDailyLimit = 30;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, "../dist");

if (!appSecret || appSecret.length < 32) {
  throw new Error("APP_SECRET must be configured with at least 32 characters.");
}
if (!redisUrl) {
  throw new Error("REDIS_URL must point to the existing Redis service.");
}

const redisClient = createClient({ url: redisUrl });
redisClient.on("error", (error) => console.error("Redis connection error:", error.message));
await redisClient.connect();

function createRateLimiter(prefix, options) {
  return rateLimit({
    ...options,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      prefix: `filber:${prefix}:`,
      sendCommand: (...args) => redisClient.sendCommand(args)
    })
  });
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());
app.use(express.static(staticDir));

const authLimiter = createRateLimiter("auth", { windowMs: 15 * 60 * 1000, limit: 10 });
const apiLimiter = createRateLimiter("api", { windowMs: 60 * 1000, limit: 30 });
const otpLimiter = createRateLimiter("otp", { windowMs: 15 * 60 * 1000, limit: 3 });

function setSessionCookie(res, userId) {
  const token = jwt.sign({ sub: userId }, appSecret, { expiresIn: "30d" });
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/"
  });
}

async function requireUser(req, res, next) {
  try {
    const token = req.cookies[cookieName];
    if (!token) throw new HttpError(401, "Inicia sesión para continuar.", "UNAUTHENTICATED");
    const payload = jwt.verify(token, appSecret);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new HttpError(401, "La sesión ya no está disponible. Vuelve a ingresar.", "UNAUTHENTICATED");
    req.user = user;
    next();
  } catch (error) {
    next(error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError
      ? new HttpError(401, "La sesión expiró. Vuelve a ingresar.", "UNAUTHENTICATED")
      : error);
  }
}

function getContactNumber() {
  return (process.env.CONTACT_WHATSAPP || "").replace(/\D/g, "");
}

app.get("/api/config", (req, res) => {
  res.json({ contactWhatsapp: getContactNumber() });
});

app.post("/api/login", authLimiter, async (req, res, next) => {
  try {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    if (username.length < 2 || username.length > 24 || !/^[\p{L}\p{N} _.-]+$/u.test(username)) {
      throw new HttpError(400, "Usa un nombre de 2 a 24 letras, números o espacios.", "INVALID_USERNAME");
    }
    if (req.body?.termsAccepted !== true || req.body?.cookiesAccepted !== true) {
      throw new HttpError(400, "Debes aceptar los términos y el uso de cookies necesarias.", "CONSENT_REQUIRED");
    }
    const now = new Date();
    const user = await prisma.user.create({
      data: { username, termsAcceptedAt: now, cookiesAcceptedAt: now }
    });
    setSessionCookie(res, user.id);
    res.status(201).json({ user: { id: user.id, username: user.username, phoneVerified: false, freeMessages: 0 } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(cookieName, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  res.status(204).end();
});

app.get("/api/me", requireUser, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      phoneVerified: req.user.phoneVerified,
      freeMessages: req.user.freeMessages,
      freeMessageLimit
    }
  });
});

app.get("/api/messages", requireUser, async (req, res, next) => {
  try {
    const messages = await prisma.message.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "asc" },
      take: 100
    });
    res.json({ messages });
  } catch (error) {
    next(error);
  }
});

async function reserveMessage(user) {
  if (!user.phoneVerified) {
    const update = await prisma.user.updateMany({
      where: { id: user.id, phoneVerified: false, freeMessages: { lt: freeMessageLimit } },
      data: { freeMessages: { increment: 1 } }
    });
    if (!update.count) throw new HttpError(402, "Se acabaron tus 5 mensajes gratis. Verifica tu WhatsApp para seguir.", "PHONE_VERIFICATION_REQUIRED");
    return;
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const sameDay = current.usageDate && current.usageDate >= today;
  if (!sameDay) {
    await prisma.user.update({ where: { id: user.id }, data: { usageDate: today, dailyMessages: 1 } });
    return;
  }
  const update = await prisma.user.updateMany({
    where: { id: user.id, dailyMessages: { lt: verifiedDailyLimit } },
    data: { dailyMessages: { increment: 1 } }
  });
  if (!update.count) throw new HttpError(429, "Llegaste al límite diario de 30 mensajes. Vuelve mañana.", "DAILY_LIMIT_REACHED");
}

async function searchWeb(query) {
  if (process.env.TAVILY_API_KEY) {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: 5, search_depth: "basic" })
    });
    if (!response.ok) throw new HttpError(502, "El buscador web no respondió correctamente. Inténtalo de nuevo.", "SEARCH_FAILED");
    const result = await response.json();
    return (result.results || []).slice(0, 5).map((item) => ({
      title: String(item.title || "Fuente web").slice(0, 200),
      url: item.url,
      snippet: String(item.content || "").slice(0, 700)
    })).filter((source) => /^https?:\/\//.test(source.url || ""));
  }

  try {
    const url = new URL("https://api.duckduckgo.com/");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");
    url.searchParams.set("skip_disambig", "1");
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return [];
    const result = await response.json();
    const items = [];
    if (result.AbstractText && result.AbstractURL) {
      items.push({ title: result.Heading || "DuckDuckGo", url: result.AbstractURL, snippet: result.AbstractText });
    }
    for (const topic of result.RelatedTopics || []) {
      if (topic.FirstURL && topic.Text) items.push({ title: topic.Text.slice(0, 100), url: topic.FirstURL, snippet: topic.Text });
      if (topic.Topics) {
        for (const child of topic.Topics) {
          if (child.FirstURL && child.Text) items.push({ title: child.Text.slice(0, 100), url: child.FirstURL, snippet: child.Text });
        }
      }
    }
    return items.slice(0, 5);
  } catch (error) {
    console.warn("Web search unavailable:", error.message);
    return [];
  }
}

async function generateAnswer(question, history) {
  if (!process.env.GROQ_API_KEY) {
    throw new HttpError(503, "La IA aún no está configurada. Añade GROQ_API_KEY al archivo .env y reinicia el contenedor.", "AI_NOT_CONFIGURED");
  }
  const sources = await searchWeb(question);
  const sourceText = sources.length
    ? sources.map((source, index) => `[${index + 1}] ${source.title}: ${source.snippet} (${source.url})`).join("\n")
    : "No se encontraron fuentes web útiles para esta consulta.";
  const messages = [
    {
      role: "system",
      content: `Eres Filber, un bot en español con humor pícaro, irónico y troll, pero con crueldad. Responde primero lo útil y luego añade una broma breve. Nunca uses insultos discriminatorios, amenazas, acoso, ni te burles de tragedias o vulnerabilidades personales. Si no sabes algo, dilo con claridad. No inventes datos ni afirmes que una búsqueda encontró algo que no aparece en las fuentes. Contexto de búsqueda reciente:\n${sourceText}`
    },
    ...history.map(({ role, content }) => ({ role, content })),
    { role: "user", content: question }
  ];
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile", messages, temperature: 0.85, max_tokens: 900 })
  });
  if (!response.ok) {
    const reason = response.status === 429 ? "La IA está ocupada por ahora. Espera un momento y vuelve a intentarlo." : "No se pudo obtener una respuesta de la IA. Inténtalo de nuevo.";
    throw new HttpError(response.status === 429 ? 429 : 502, reason, "AI_REQUEST_FAILED");
  }
  const result = await response.json();
  const answer = result.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new HttpError(502, "La IA devolvió una respuesta vacía. Inténtalo de nuevo.", "EMPTY_AI_RESPONSE");
  return { answer, sources };
}

async function handleChat(user, question) {
  const text = typeof question === "string" ? question.trim() : "";
  if (!text || text.length > 5000) throw new HttpError(400, "El mensaje debe tener entre 1 y 5,000 caracteres.", "INVALID_MESSAGE");
  await reserveMessage(user);
  await prisma.message.create({ data: { userId: user.id, role: "user", content: text } });
  const history = await prisma.message.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { role: true, content: true }
  });
  const { answer, sources } = await generateAnswer(text, history.reverse().slice(0, -1));
  const saved = await prisma.message.create({
    data: { userId: user.id, role: "assistant", content: answer, sources }
  });
  return { userMessage: text, assistantMessage: saved, freeMessages: user.phoneVerified ? null : user.freeMessages + 1 };
}

app.post("/api/chat", apiLimiter, requireUser, async (req, res, next) => {
  try {
    res.json(await handleChat(req.user, req.body?.message));
  } catch (error) {
    next(error);
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!file.mimetype.startsWith("audio/")) return callback(new HttpError(400, "El archivo debe ser audio.", "INVALID_AUDIO"));
    callback(null, true);
  }
});

app.post("/api/audio", apiLimiter, requireUser, upload.single("audio"), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, "No se recibió ningún audio.", "AUDIO_REQUIRED");
    if (!process.env.GROQ_API_KEY) throw new HttpError(503, "La transcripción de audio requiere configurar GROQ_API_KEY.", "AI_NOT_CONFIGURED");
    const form = new FormData();
    form.append("file", new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || "voice.webm");
    form.append("model", "whisper-large-v3-turbo");
    form.append("language", "es");
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new HttpError(502, "No se pudo transcribir el audio. Inténtalo de nuevo.", "TRANSCRIPTION_FAILED");
    const transcription = (await response.json()).text?.trim();
    if (!transcription) throw new HttpError(400, "No se entendió voz en ese audio.", "EMPTY_TRANSCRIPTION");
    res.json(await handleChat(req.user, transcription));
  } catch (error) {
    next(error);
  }
});

function whatsappConfigured() {
  return Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_OTP_TEMPLATE);
}

app.post("/api/otp/send", otpLimiter, requireUser, async (req, res, next) => {
  try {
    if (req.user.phoneVerified) throw new HttpError(409, "Este perfil ya verificó un número.", "ALREADY_VERIFIED");
    if (!whatsappConfigured()) throw new HttpError(503, "El envío de códigos aún no está configurado. Contacta al administrador.", "WHATSAPP_NOT_CONFIGURED");
    const phone = typeof req.body?.phone === "string" ? req.body.phone.replace(/[ ()-]/g, "") : "";
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      throw new HttpError(400, "Escribe el número en formato internacional, por ejemplo +51987654321.", "INVALID_PHONE");
    }
    const code = crypto.randomInt(100000, 1000000).toString();
    const id = crypto.randomUUID();
    const codeHash = crypto.createHmac("sha256", appSecret).update(`${req.user.id}:${phone}:${code}`).digest("hex");
    await prisma.verificationCode.create({
      data: { id, userId: req.user.id, phone, codeHash, expiresAt: new Date(Date.now() + 5 * 60 * 1000) }
    });
    try {
      const response = await fetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone.slice(1),
          type: "template",
          template: {
            name: process.env.WHATSAPP_OTP_TEMPLATE,
            language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "es" },
            components: [{ type: "body", parameters: [{ type: "text", text: code }] }]
          }
        })
      });
      if (!response.ok) throw new Error(`Meta WhatsApp API returned HTTP ${response.status}.`);
    } catch (error) {
      await prisma.verificationCode.delete({ where: { id } });
      throw new HttpError(502, `No se pudo enviar el código de WhatsApp. Revisa el número y la plantilla aprobada. ${error.message}`, "WHATSAPP_SEND_FAILED");
    }
    res.json({ message: "Código enviado. Caduca en 5 minutos." });
  } catch (error) {
    next(error);
  }
});

app.post("/api/otp/verify", otpLimiter, requireUser, async (req, res, next) => {
  try {
    const phone = typeof req.body?.phone === "string" ? req.body.phone.replace(/[ ()-]/g, "") : "";
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    if (!/^\+[1-9]\d{7,14}$/.test(phone) || !/^\d{6}$/.test(code)) {
      throw new HttpError(400, "Revisa el número y el código de 6 dígitos.", "INVALID_CODE");
    }
    const verification = await prisma.verificationCode.findFirst({
      where: { userId: req.user.id, phone, expiresAt: { gt: new Date() }, attempts: { lt: 5 } },
      orderBy: { createdAt: "desc" }
    });
    if (!verification) throw new HttpError(400, "El código expiró o no existe. Solicita otro.", "CODE_EXPIRED");
    const candidate = crypto.createHmac("sha256", appSecret).update(`${req.user.id}:${phone}:${code}`).digest("hex");
    const matches = crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(verification.codeHash, "hex"));
    if (!matches) {
      await prisma.verificationCode.update({ where: { id: verification.id }, data: { attempts: { increment: 1 } } });
      throw new HttpError(400, "El código no coincide.", "INVALID_CODE");
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: req.user.id }, data: { phone, phoneVerified: true } }),
      prisma.verificationCode.deleteMany({ where: { userId: req.user.id } })
    ]);
    res.json({ message: "WhatsApp verificado. ¡Ya puedes seguir usando Filber!", phoneVerified: true });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/me", requireUser, async (req, res, next) => {
  try {
    await prisma.user.delete({ where: { id: req.user.id } });
    res.clearCookie(cookieName, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next(new HttpError(404, "No se encontró esa ruta.", "NOT_FOUND"));
  res.sendFile(path.join(staticDir, "index.html"));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "El audio supera el máximo de 20 MB.", code: "AUDIO_TOO_LARGE" });
  }
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({
    error: status === 500 ? "Ocurrió un error interno. Inténtalo de nuevo." : error.message,
    code: error.code || "INTERNAL_ERROR"
  });
});

const server = app.listen(port, "0.0.0.0", () => console.log(`Filber escuchando en el puerto ${port}`));

async function shutdown() {
  server.close();
  await redisClient.quit();
  await prisma.$disconnect();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
