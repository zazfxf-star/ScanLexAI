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

export async function renderTranslatedImage(
  original: Buffer,
  regions: TextRegion[],
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const metadata = await sharp(original).metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const translatedRegions = regions.filter((region) => region.translatedText.trim());
  const coverInputs: { input: Buffer; left: number; top: number }[] = [];
  const overlays = await Promise.all(
    translatedRegions.map(async (region) => {
      const x = Math.round(region.x * width);
      const y = Math.round(region.y * height);
      const w = Math.max(12, Math.round(region.width * width));
      const h = Math.max(12, Math.round(region.height * height));
      const box = {
        left: clamp(x, 0, Math.max(0, width - 1)),
        top: clamp(y, 0, Math.max(0, height - 1)),
        width: Math.max(1, Math.min(w, width - clamp(x, 0, Math.max(0, width - 1)))),
        height: Math.max(1, Math.min(h, height - clamp(y, 0, Math.max(0, height - 1)))),
      };
      const [cover, stats] = await Promise.all([
        sharp(original)
          .extract(box)
          .blur(clamp(Math.min(box.width, box.height) * 0.08, 4, 24))
          .png()
          .toBuffer(),
        sharp(original).extract(box).stats(),
      ]);
      coverInputs.push({ input: cover, left: box.left, top: box.top });

      const average = stats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.mean, 0) / 3;
      const darkBackground = average < 115;
      const fontSize = clamp(
        region.fontSize * height || Math.min(box.height * 0.34, box.width * 0.12),
        12,
        Math.min(box.height * 0.34, box.width * 0.16),
      );
      let fittedFontSize = fontSize;
      let lines = wrapText(
        region.translatedText,
        Math.max(3, Math.floor(box.width / (fittedFontSize * (containsArabic(region.translatedText) ? 0.7 : 0.62)))),
      );
      while (fittedFontSize > 12 && lines.length * fittedFontSize * 1.18 > box.height * 0.86) {
        fittedFontSize -= 1;
        lines = wrapText(
          region.translatedText,
          Math.max(3, Math.floor(box.width / (fittedFontSize * (containsArabic(region.translatedText) ? 0.7 : 0.62)))),
        );
      }
      const lineHeight = fittedFontSize * 1.18;
      const totalTextHeight = lines.length * lineHeight;
      const firstBaseline = box.top + (box.height - totalTextHeight) / 2 + fittedFontSize;
      const rtl = containsArabic(region.translatedText);
      const anchor = region.align === "left" ? "start" : region.align === "right" ? "end" : "middle";
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
    }),
  );

  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${overlays.join("")}</svg>`,
  );

  const buffer = await sharp(original)
    .composite([...coverInputs, { input: svg }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { buffer, width, height };
}