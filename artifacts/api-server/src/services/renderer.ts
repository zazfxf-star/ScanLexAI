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

export async function renderTranslatedImage(
  original: Buffer,
  regions: TextRegion[],
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const metadata = await sharp(original).metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const overlays = regions
    .filter((region) => region.translatedText.trim())
    .map((region) => {
      const x = Math.round(region.x * width);
      const y = Math.round(region.y * height);
      const w = Math.max(12, Math.round(region.width * width));
      const h = Math.max(12, Math.round(region.height * height));
      const fontSize = Math.max(
        12,
        Math.min(h * 0.32, w / Math.max(3, Math.min(22, region.translatedText.length * 0.62))),
      );
      const lines = wrapText(region.translatedText, Math.max(3, Math.floor(w / (fontSize * 0.62))));
      const lineHeight = fontSize * 1.18;
      const totalTextHeight = lines.length * lineHeight;
      const firstBaseline = y + (h - totalTextHeight) / 2 + fontSize;
      const anchor = region.align === "left" ? "start" : region.align === "right" ? "end" : "middle";
      const textX = region.align === "left" ? x + fontSize * 0.7 : region.align === "right" ? x + w - fontSize * 0.7 : x + w / 2;
      const textLines = lines
        .map(
          (line, index) =>
            `<tspan x="${textX}" y="${firstBaseline + index * lineHeight}">${escapeXml(line)}</tspan>`,
        )
        .join("");
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(24, h * 0.18)}" fill="#fffdf9" fill-opacity="0.96"/>
        <text x="${textX}" y="${firstBaseline}" text-anchor="${anchor}" font-family="Arial, Noto Sans Arabic, sans-serif" font-size="${fontSize}" font-weight="600" fill="#10161c" direction="${region.align === "right" ? "rtl" : "ltr"}" unicode-bidi="plaintext">${textLines}</text>`;
    });

  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${overlays.join("")}</svg>`,
  );

  const buffer = await sharp(original)
    .composite([{ input: svg }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { buffer, width, height };
}