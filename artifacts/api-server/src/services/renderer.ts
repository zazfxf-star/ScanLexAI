import { GoogleGenAI, Modality } from "@google/genai";
import sharp from "sharp";
import type { TextRegion } from "./gemini";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function containsArabic(text: string): boolean {
  return /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(text);
}

function luminance(red: number, green: number, blue: number): number {
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function regionBounds(region: TextRegion, width: number, height: number) {
  const left = clamp(Math.round(region.x * width), 0, Math.max(0, width - 1));
  const top = clamp(Math.round(region.y * height), 0, Math.max(0, height - 1));
  return {
    left,
    top,
    width: Math.max(1, Math.min(Math.round(region.width * width), width - left)),
    height: Math.max(1, Math.min(Math.round(region.height * height), height - top)),
  };
}

async function editTextRegion(
  original: Buffer,
  box: { left: number; top: number; width: number; height: number },
): Promise<Buffer> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Gemini image editor is not configured");
  }

  const crop = await sharp(original).extract(box).png().toBuffer();
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "image/png",
              data: crop.toString("base64"),
            },
          },
          {
            text: [
              "Edit only this provided image crop.",
              "Remove only the original lettering or text.",
              "Reconstruct the exact background or artwork that was behind the removed lettering.",
              "Do not add, translate, or generate any text.",
              "Do not redraw or alter characters, faces, clothing, objects, borders, gradients, speech-bubble shapes, panels, or anything outside the original lettering.",
              "Return only the cleaned crop at the same dimensions.",
            ].join(" "),
          },
        ],
      },
    ],
    config: { responseModalities: [Modality.IMAGE] },
  });
  const imagePart = response.candidates?.[0]?.content?.parts?.find(
    (part) => part.inlineData?.data,
  );
  if (!imagePart?.inlineData?.data) {
    throw new Error("Gemini image editor returned no cleaned region");
  }

  return sharp(Buffer.from(imagePart.inlineData.data, "base64"))
    .resize(box.width, box.height, { fit: "fill" })
    .png()
    .toBuffer();
}

export async function renderTranslatedImage(
  original: Buffer,
  regions: TextRegion[],
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const metadata = await sharp(original).metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const translatedRegions = regions.filter((region) => region.translatedText.trim());

  const cleanedRegions: { input: Buffer; left: number; top: number }[] = [];
  for (const region of translatedRegions) {
    const box = regionBounds(region, width, height);
    cleanedRegions.push({
      input: await editTextRegion(original, box),
      left: box.left,
      top: box.top,
    });
  }

  const { data: source } = await sharp(original)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const overlays = translatedRegions.map((region) => {
    const box = regionBounds(region, width, height);
    let averageLuminance = 0;
    let samples = 0;
    for (let y = box.top; y < box.top + box.height; y += 1) {
      for (let x = box.left; x < box.left + box.width; x += 1) {
        const offset = (y * width + x) * 4;
        averageLuminance += luminance(
          source[offset],
          source[offset + 1],
          source[offset + 2],
        );
        samples += 1;
      }
    }
    const darkBackground = averageLuminance / Math.max(1, samples) < 115;
    const fontSize = clamp(
      region.fontSize * height || Math.min(box.height * 0.34, box.width * 0.12),
      12,
      Math.min(box.height * 0.34, box.width * 0.16),
    );
    let fittedFontSize = fontSize;
    let lines = wrapText(
      region.translatedText,
      Math.max(
        3,
        Math.floor(
          box.width /
            (fittedFontSize * (containsArabic(region.translatedText) ? 0.7 : 0.62)),
        ),
      ),
    );
    while (
      fittedFontSize > 12 &&
      lines.length * fittedFontSize * 1.18 > box.height * 0.86
    ) {
      fittedFontSize -= 1;
      lines = wrapText(
        region.translatedText,
        Math.max(
          3,
          Math.floor(
            box.width /
              (fittedFontSize *
                (containsArabic(region.translatedText) ? 0.7 : 0.62)),
          ),
        ),
      );
    }
    const lineHeight = fittedFontSize * 1.18;
    const totalTextHeight = lines.length * lineHeight;
    const firstBaseline =
      box.top + (box.height - totalTextHeight) / 2 + fittedFontSize;
    const rtl = containsArabic(region.translatedText);
    const anchor =
      region.align === "left"
        ? "start"
        : region.align === "right"
          ? "end"
          : "middle";
    const textX =
      region.align === "left"
        ? box.left + fittedFontSize * 0.7
        : region.align === "right"
          ? box.left + box.width - fittedFontSize * 0.7
          : box.left + box.width / 2;
    const textLines = lines
      .map(
        (line, index) =>
          `<tspan x="${textX}" y="${firstBaseline + index * lineHeight}">${escapeXml(line)}</tspan>`,
      )
      .join("");
    const textColor = darkBackground ? "#fffdf5" : "#10161c";
    const outlineColor = darkBackground ? "#10161c" : "#fffdf5";
    const outlineWidth = clamp(fittedFontSize * 0.055, 1.2, 3.2);
    return `<text x="${textX}" y="${firstBaseline}" text-anchor="${anchor}" font-family="Noto Sans Arabic, Amiri, Cairo, DejaVu Sans, sans-serif" font-size="${fittedFontSize}" font-weight="700" fill="${textColor}" stroke="${outlineColor}" stroke-width="${outlineWidth}" stroke-opacity="0.88" paint-order="stroke fill" direction="${rtl ? "rtl" : "ltr"}" unicode-bidi="plaintext">${textLines}</text>`;
  });

  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${overlays.join("")}</svg>`,
  );
  const buffer = await sharp(original)
    .composite([...cleanedRegions, { input: svg }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { buffer, width, height };
}