import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import { TRANSLATION_MODEL } from "../config";

export const regionSchema = z.object({
  text: z.string().default(""),
  translatedText: z.string().default(""),
  x: z.number().default(0),
  y: z.number().default(0),
  width: z.number().default(0.1),
  height: z.number().default(0.1),
  orientation: z.string().default("horizontal"),
  regionType: z.string().default("dialogue"),
  confidence: z.number().default(0.8),
  fontSize: z.number().default(0.04),
  align: z.preprocess((val) => {
    if (typeof val === "string") {
      const lower = val.toLowerCase().trim();
      if (["left", "center", "right"].includes(lower)) return lower;
    }
    return "center";
  }, z.enum(["left", "center", "right"])).default("center"),
});

export type TextRegion = z.infer<typeof regionSchema>;

export class GeminiServiceError extends Error {
  code: "missing_key" | "rate_limit" | "unavailable" | "malformed";

  constructor(
    code: GeminiServiceError["code"],
    message: string,
  ) {
    super(message);
    this.name = "GeminiServiceError";
    this.code = code;
  }
}

function getApiKeys(): string[] {
  const keys: string[] = [];
  for (const envName of Object.keys(process.env)) {
    if (envName.startsWith("GEMINI_API_KEY") && process.env[envName]) {
      const value = process.env[envName]?.trim();
      if (value) {
        keys.push(value);
      }
    }
  }
  return Array.from(new Set(keys));
}

function promptFor(targetLanguage: string): string {
  return `You are the core vision, OCR, and translation engine for ScanLex AI, a professional comic, manga, manhwa, and webtoon translation studio.

Analyze the attached page image (Manga, Manhwa, Webtoon, or Western Comic).

DETECTION & BOUNDING BOX RULES:
1. Detect ALL readable text areas: speech bubbles, thought bubbles, narration boxes, captions, signs, system alerts, vertical text, and sound effects.
2. IMPORTANT: The bounding box (x, y, width, height) MUST encompass the ENTIRE speech bubble/container area, not just the tight text contour, so the renderer can clean the background cleanly.
3. For long vertical webtoon/manhwa images, ensure precise vertical Y-coordinates.

TRANSLATION RULES:
1. Translate all recognized text naturally into fluent ${targetLanguage}.
2. Preserve emotion, tone, character gender, and context accurately.
3. If text contains system alerts like <System>, keep the brackets intact so the system can format them.
4. Keep translatedText concise enough to fit naturally inside their speech bubbles.

COORDINATE FORMAT:
Coordinates MUST be normalized decimals between 0.0 and 1.0 relative to total image width and height.
- x: top-left X position (0.0 to 1.0)
- y: top-left Y position (0.0 to 1.0)
- width: region width (0.0 to 1.0)
- height: region height (0.0 to 1.0)

Return ONLY a JSON array matching the required schema. If no readable text exists, return [].`;
}

const responseSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      text: { type: Type.STRING },
      translatedText: { type: Type.STRING },
      x: { type: Type.NUMBER },
      y: { type: Type.NUMBER },
      width: { type: Type.NUMBER },
      height: { type: Type.NUMBER },
      orientation: { type: Type.STRING },
      regionType: { type: Type.STRING },
      confidence: { type: Type.NUMBER },
      fontSize: { type: Type.NUMBER },
      align: {
        type: Type.STRING,
        enum: ["left", "center", "right"],
      },
    },
    required: [
      "text",
      "translatedText",
      "x",
      "y",
      "width",
      "height",
      "orientation",
      "regionType",
      "confidence",
      "fontSize",
      "align",
    ],
  },
};

function parseRegions(rawText: string): TextRegion[] {
  try {
    const normalized = rawText
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");

    const parsed: unknown = JSON.parse(normalized);
    if (!Array.isArray(parsed)) return [];

    const rawArray = z.array(regionSchema).parse(parsed);

    return rawArray.map((region) => {
      let x = region.x;
      let y = region.y;
      let width = region.width;
      let height = region.height;

      if (x > 1) x /= 1000;
      if (y > 1) y /= 1000;
      if (width > 1) width /= 1000;
      if (height > 1) height /= 1000;

      return {
        ...region,
        x: Math.max(0, Math.min(0.99, x)),
        y: Math.max(0, Math.min(0.99, y)),
        width: Math.max(0.01, Math.min(1.0 - Math.max(0, x), width)),
        height: Math.max(0.01, Math.min(1.0 - Math.max(0, y), height)),
      };
    });
  } catch (err) {
    console.error("[Gemini Parsing Error]:", err);
    return [];
  }
}

function getErrorDetails(err: any): {
  type: "rate_limit" | "unavailable" | "malformed";
  message: string;
} {
  const message = err?.message || err?.error?.message || String(err);
  const status = err?.status ?? err?.code ?? err?.error?.code ?? 0;
  const lowerMessage = message.toLowerCase();

  if (
    status === 429 ||
    lowerMessage.includes("429") ||
    lowerMessage.includes("quota") ||
    lowerMessage.includes("resource exhausted") ||
    lowerMessage.includes("too many requests") ||
    lowerMessage.includes("rate limit")
  ) {
    return { type: "rate_limit", message };
  }

  if (
    status === 503 ||
    lowerMessage.includes("503") ||
    lowerMessage.includes("service unavailable") ||
    lowerMessage.includes("overloaded")
  ) {
    return { type: "unavailable", message };
  }

  return { type: "malformed", message };
}

// متغير عالمي عشان يحفظ الدور ويوزع الحمل بين المفاتيح بالترتيب
let currentKeyIndex = 0;

export async function analyzeImage(
  image: Buffer,
  mimeType: string,
  targetLanguage: string,
): Promise<TextRegion[]> {
  const keys = getApiKeys();

  if (keys.length === 0) {
    throw new GeminiServiceError(
      "missing_key",
      "No Gemini API key found in configuration.",
    );
  }

  const imageBase64 = image.toString("base64");
  let lastErrorMessage = "";
  const startIndex = currentKeyIndex;

  // مفتاح واحد فقط لكل صفحة (دوران بالترتيب) — عشان ما نضرب كل المفاتيح
  // بالتوازي على نفس الصفحة ونصطدم مع توازي الصفحات نفسها (BATCH_SIZE) بترانزليشن.
  // لو المفتاح الحالي فشل، نجرب اللي بعده بالتتابع، مو كلهم دفعة وحدة.
  for (let i = 0; i < keys.length; i++) {
    const keyToTry = (startIndex + i) % keys.length;
    const apiKey = keys[keyToTry];
    const ai = new GoogleGenAI({ apiKey });

    console.log(`[Gemini] Page requesting via Key #${keyToTry + 1} with model ${TRANSLATION_MODEL}...`);

    try {
      const response = await ai.models.generateContent({
        model: TRANSLATION_MODEL,
        contents: [
          {
            inlineData: {
              mimeType: mimeType || "image/png",
              data: imageBase64,
            },
          },
          {
            text: promptFor(targetLanguage),
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema,
          temperature: 0.1,
        },
      });

      if (response?.text) {
        console.log(`[Gemini] Success with Key #${keyToTry + 1}`);
        currentKeyIndex = (keyToTry + 1) % keys.length;
        return parseRegions(response.text);
      }
    } catch (err: any) {
      const details = getErrorDetails(err);
      lastErrorMessage = details.message;
      console.warn(`[Gemini] Key #${keyToTry + 1} failed (${details.type}). Trying next key in line...`);

      if (details.type === "rate_limit" || details.type === "unavailable") {
        await new Promise((res) => setTimeout(res, 400));
      }
    }
  }

  throw new GeminiServiceError(
    "rate_limit",
    `All API keys failed for this page. Last error: ${lastErrorMessage}`,
  );
}
