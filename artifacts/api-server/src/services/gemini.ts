import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import { TRANSLATION_MODEL } from "../config";

const regionSchema = z.object({
  text: z.string().default(""),
  translatedText: z.string().default(""),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
  orientation: z.string().default("horizontal"),
  regionType: z.string().default("dialogue"),
  confidence: z.number().min(0).max(1).default(0.8),
  fontSize: z.number().min(0).max(1).default(0.04),
  align: z.enum(["left", "center", "right"]).default("center"),
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

function publicGeminiError(error: unknown): GeminiServiceError {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("429") || message.includes("quota") || message.includes("rate")) {
    return new GeminiServiceError("rate_limit", "Gemini usage limit reached");
  }
  if (
    message.includes("fetch") ||
    message.includes("timeout") ||
    message.includes("unavailable") ||
    message.includes("503")
  ) {
    return new GeminiServiceError("unavailable", "Gemini service unavailable");
  }
  return new GeminiServiceError("unavailable", "Gemini request failed");
}

function promptFor(targetLanguage: string): string {
  return `You are the vision and translation engine for ScanLex AI, a comic page translator.
Inspect the attached comic/manga/manhwa/manhua page. Detect every readable text region, including
speech bubbles, narration boxes, signs, captions, vertical text, and sound effects when possible.
Translate the text naturally into ${targetLanguage}, preserving character intent, tone, context,
and gender when inferable. Do not translate artwork. Coordinates must be normalized from 0 to 1
relative to the full image, with x/y at the top-left of each region. Return ONLY a JSON array.
Each item must have: text, translatedText, x, y, width, height, orientation, regionType,
confidence, fontSize (normalized fraction of image height), and align ("left", "center", or "right").
If no text is readable, return an empty array. Keep each translatedText concise enough to fit its region.`;
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
      align: { type: Type.STRING, enum: ["left", "center", "right"] },
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

function parseRegions(text: string): TextRegion[] {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(normalized);
  return z.array(regionSchema).parse(parsed).map((region) => ({
    ...region,
    x: Math.max(0, Math.min(1, region.x)),
    y: Math.max(0, Math.min(1, region.y)),
    width: Math.max(0.01, Math.min(1, region.width)),
    height: Math.max(0.01, Math.min(1, region.height)),
  }));
}

export async function analyzeImage(
  image: Buffer,
  mimeType: string,
  targetLanguage: string,
): Promise<TextRegion[]> {
  if (!process.env.GEMINI_API_KEY) {
    throw new GeminiServiceError("missing_key", "Gemini API key is not configured");
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await ai.models.generateContent({
        model: TRANSLATION_MODEL,
        contents: [
          {
            inlineData: {
              mimeType,
              data: image.toString("base64"),
            },
          },
          { text: promptFor(targetLanguage) },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema,
          temperature: 0.15,
        },
      });
      return parseRegions(response.text ?? "[]");
    } catch (error) {
      lastError = error;
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        continue;
      }
      throw publicGeminiError(error);
    }
  }

  throw new GeminiServiceError(
    "malformed",
    lastError instanceof Error ? lastError.message : "Gemini returned invalid structured data",
  );
}