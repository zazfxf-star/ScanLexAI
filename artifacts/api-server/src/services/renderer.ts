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

function colorDistance(
  red: number,
  green: number,
  blue: number,
  otherRed: number,
  otherGreen: number,
  otherBlue: number,
): number {
  return Math.sqrt(
    (red - otherRed) ** 2 +
      (green - otherGreen) ** 2 +
      (blue - otherBlue) ** 2,
  );
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

function makeLetteringMask(
  source: Buffer,
  softened: Buffer,
  width: number,
  height: number,
  regions: TextRegion[],
): Uint8Array {
  const mask = new Uint8Array(width * height);

  for (const region of regions) {
    if (!region.translatedText.trim()) continue;
    const box = regionBounds(region, width, height);
    let averageLuma = 0;
    let samples = 0;
    for (let y = box.top; y < box.top + box.height; y += 1) {
      for (let x = box.left; x < box.left + box.width; x += 1) {
        const offset = (y * width + x) * 4;
        averageLuma += luminance(source[offset], source[offset + 1], source[offset + 2]);
        samples += 1;
      }
    }
    averageLuma /= Math.max(1, samples);

    // Leave a small perimeter intact so bubble borders and panel lines remain untouched.
    const inset = Math.max(1, Math.round(Math.min(box.width, box.height) * 0.035));
    const textIsDark = averageLuma >= 125;
    for (let y = box.top + inset; y < box.top + box.height - inset; y += 1) {
      for (let x = box.left + inset; x < box.left + box.width - inset; x += 1) {
        const offset = (y * width + x) * 4;
        const nearby = offset;
        const currentLuma = luminance(source[offset], source[offset + 1], source[offset + 2]);
        const nearbyLuma = luminance(
          softened[nearby],
          softened[nearby + 1],
          softened[nearby + 2],
        );
        const contrast = currentLuma - nearbyLuma;
        const chromaticContrast = colorDistance(
          source[offset],
          source[offset + 1],
          source[offset + 2],
          softened[nearby],
          softened[nearby + 1],
          softened[nearby + 2],
        );
        const likelyLettering = textIsDark
          ? contrast < -24 || (contrast < -16 && chromaticContrast > 30)
          : contrast > 24 || (contrast > 16 && chromaticContrast > 30);
        if (likelyLettering) mask[y * width + x] = 1;
      }
    }
  }

  // Include antialiased edges, but only around detected lettering pixels.
  const expanded = new Uint8Array(mask);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (
        mask[index - 1] ||
        mask[index + 1] ||
        mask[index - width] ||
        mask[index + width]
      ) {
        expanded[index] = 1;
      }
    }
  }
  return expanded;
}

function inpaintLettering(source: Buffer, width: number, height: number, mask: Uint8Array): Buffer {
  const result = Buffer.from(source);
  const filled = new Uint8Array(width * height);
  for (let index = 0; index < filled.length; index += 1) filled[index] = mask[index] ? 0 : 1;

  // Propagate nearby, unmasked artwork into only the detected letter pixels.
  for (let pass = 0; pass < 18; pass += 1) {
    const next = Buffer.from(result);
    const nextFilled = new Uint8Array(filled);
    let changed = false;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (!mask[index] || filled[index]) continue;
        let red = 0;
        let green = 0;
        let blue = 0;
        let weightTotal = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;
            const neighbor = (y + dy) * width + x + dx;
            if (!filled[neighbor]) continue;
            const weight = 1 / (Math.abs(dx) + Math.abs(dy));
            const offset = neighbor * 4;
            red += result[offset] * weight;
            green += result[offset + 1] * weight;
            blue += result[offset + 2] * weight;
            weightTotal += weight;
          }
        }
        if (weightTotal < 1.5) continue;
        const offset = index * 4;
        next[offset] = Math.round(red / weightTotal);
        next[offset + 1] = Math.round(green / weightTotal);
        next[offset + 2] = Math.round(blue / weightTotal);
        nextFilled[index] = 1;
        changed = true;
      }
    }
    result.set(next);
    filled.set(nextFilled);
    if (!changed) break;
  }
  return result;
}

export async function renderTranslatedImage(
  original: Buffer,
  regions: TextRegion[],
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const metadata = await sharp(original).metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const { data: source } = await sharp(original).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: softened } = await sharp(original)
    .ensureAlpha()
    .blur(2)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = makeLetteringMask(source, softened, width, height, regions);
  const cleaned = inpaintLettering(source, width, height, mask);
  const overlays = await Promise.all(
    regions.filter((region) => region.translatedText.trim()).map(async (region) => {
      const box = regionBounds(region, width, height);
      const average = (() => {
        let total = 0;
        let samples = 0;
        for (let y = box.top; y < box.top + box.height; y += 1) {
          for (let x = box.left; x < box.left + box.width; x += 1) {
            const offset = (y * width + x) * 4;
            total += luminance(source[offset], source[offset + 1], source[offset + 2]);
            samples += 1;
          }
        }
        return total / Math.max(1, samples);
      })();
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
    .composite([{ input: await sharp(cleaned, { raw: { width, height, channels: 4 } }).png().toBuffer() }, { input: svg }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { buffer, width, height };
}