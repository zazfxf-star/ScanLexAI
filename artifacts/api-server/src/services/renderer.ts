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

function getLuminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * خوارزمية ذكية لقراءة لون خلفية النص مع مطابقة الألوان النقية (الأبيض والأسود الصافي)
 */
async function getCleanBackgroundColor(
  original: Buffer,
  x: number,
  y: number,
  w: number,
  h: number,
  imgW: number,
  imgH: number,
): Promise<{ bgColor: string; isLight: boolean }> {
  try {
    const safeX = Math.max(0, Math.min(x, imgW - 1));
    const safeY = Math.max(0, Math.min(y, imgH - 1));
    const safeW = Math.min(w, imgW - safeX);
    const safeH = Math.min(h, imgH - safeY);

    if (safeW < 4 || safeH < 4) return { bgColor: "#FFFFFF", isLight: true };

    const sampleSize = Math.max(2, Math.min(8, Math.floor(Math.min(safeW, safeH) / 4)));

    const cornerTL = await sharp(original)
      .extract({ left: safeX, top: safeY, width: sampleSize, height: sampleSize })
      .stats();

    const cornerTR = await sharp(original)
      .extract({ left: safeX + safeW - sampleSize, top: safeY, width: sampleSize, height: sampleSize })
      .stats();

    const cornerBL = await sharp(original)
      .extract({ left: safeX, top: safeY + safeH - sampleSize, width: sampleSize, height: sampleSize })
      .stats();

    const cornerBR = await sharp(original)
      .extract({ left: safeX + safeW - sampleSize, top: safeY + safeH - sampleSize, width: sampleSize, height: sampleSize })
      .stats();

    const r = Math.round((cornerTL.channels[0].mean + cornerTR.channels[0].mean + cornerBL.channels[0].mean + cornerBR.channels[0].mean) / 4);
    const g = Math.round((cornerTL.channels[1].mean + cornerTR.channels[1].mean + cornerBL.channels[1].mean + cornerBR.channels[1].mean) / 4);
    const b = Math.round((cornerTL.channels[2].mean + cornerTR.channels[2].mean + cornerBL.channels[2].mean + cornerBR.channels[2].mean) / 4);

    const lum = getLuminance(r, g, b);

    // توحيد درجات الأبيض والأسود النقي لمنع ظهور التدرجات الرمادية المزعجة
    if (lum > 185) {
      return { bgColor: "#FFFFFF", isLight: true };
    }
    if (lum < 45) {
      return { bgColor: "#000000", isLight: false };
    }

    return { bgColor: `rgb(${r},${g},${b})`, isLight: lum >= 128 };
  } catch {
    // في حال أي خطأ، يفترض الكود أن الفقاعة بيضاء ناصعة
    return { bgColor: "#FFFFFF", isLight: true };
  }
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

/**
 * دالة لتوزيع النص وحساب أفضل حجم خط مناسب للسطور والارتفاع المتاح
 */
function fitText(
  text: string,
  w: number,
  h: number,
): { lines: string[]; fontSize: number; lineHeight: number; totalTextHeight: number } {
  const cleanText = text.trim();
  let bestFontSize = 12;
  let bestLines: string[] = [cleanText];

  const maxFontSize = Math.min(Math.floor(h * 0.35), 32);
  const minFontSize = 11;

  for (let size = maxFontSize; size >= minFontSize; size -= 1) {
    const avgCharWidth = size * 0.52;
    const maxChars = Math.max(2, Math.floor((w * 0.92) / avgCharWidth));
    const lines = wrapText(cleanText, maxChars);
    const lineHeight = size * 1.25;
    const totalHeight = lines.length * lineHeight;

    if (totalHeight <= h * 0.92 || size === minFontSize) {
      bestFontSize = size;
      bestLines = lines;
      break;
    }
  }

  const lineHeight = bestFontSize * 1.25;
  const totalTextHeight = bestLines.length * lineHeight;

  return {
    lines: bestLines,
    fontSize: bestFontSize,
    lineHeight,
    totalTextHeight,
  };
}

/**
 * تنسيق النصوص وتلوين العلامات مثل <النظام> باللون الذهبي تلقائياً
 */
function buildFormattedTspan(
  line: string,
  textX: number,
  yPos: number,
  systemColor: string,
): string {
  const escaped = escapeXml(line);

  if (escaped.includes("&lt;") && escaped.includes("&gt;")) {
    const formatted = escaped.replace(
      /(&lt;.*?&gt;)/g,
      `<tspan fill="${systemColor}" font-weight="900">$1</tspan>`
    );
    return `<tspan x="${textX}" y="${yPos}">${formatted}</tspan>`;
  }

  return `<tspan x="${textX}" y="${yPos}">${escaped}</tspan>`;
}

export async function renderTranslatedImage(
  original: Buffer,
  regions: TextRegion[],
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const metadata = await sharp(original).metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;

  const overlays: string[] = [];

  for (const region of regions) {
    if (!region.translatedText.trim()) continue;

    const rawX = Math.round(region.x * width);
    const rawY = Math.round(region.y * height);
    const rawW = Math.round(region.width * width);
    const rawH = Math.round(region.height * height);

    // توسيع هامش التغطية بمقدار بسيط لضمان مسح النص الأصلي بالكامل
    const pad = 2;
    const x = Math.max(0, rawX - pad);
    const y = Math.max(0, rawY - pad);
    const w = Math.min(width - x, Math.max(12, rawW + pad * 2));
    const h = Math.min(height - y, Math.max(12, rawH + pad * 2));

    // 1. تحديد لون الخلفية بدقة ومعرفة إن كانت فاتحة أم مظلمة
    const { bgColor, isLight } = await getCleanBackgroundColor(original, x, y, w, h, width, height);

    // تحديد ألوان النص والحدود لتتناسب مع طبيعة الفقاعة
    const textColor = isLight ? "#0A0A0A" : "#FFFFFF";
    const strokeColor = isLight ? "#FFFFFF" : "#000000";
    const systemTagColor = isLight ? "#D97706" : "#FFE600";

    // 2. حساب حجم الخط والتفاف الأسطر
    const { lines, fontSize, lineHeight, totalTextHeight } = fitText(region.translatedText, w, h);

    const textX = x + w / 2;
    const firstBaseline = y + (h - totalTextHeight) / 2 + fontSize * 0.82;

    const strokeLines = lines
      .map((line, index) => `<tspan x="${textX}" y="${firstBaseline + index * lineHeight}">${escapeXml(line)}</tspan>`)
      .join("");

    const fillLines = lines
      .map((line, index) => buildFormattedTspan(line, textX, firstBaseline + index * lineHeight, systemTagColor))
      .join("");

    const strokeWidth = Math.max(2, Math.round(fontSize * 0.14));
    const borderRadius = Math.min(16, Math.min(w, h) * 0.25);

    overlays.push(`
      <!-- 1. تنظيف وتغطية النص القديم بحواف انسيابية تناسب الفقاعات -->
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${borderRadius}" ry="${borderRadius}" fill="${bgColor}" />

      <!-- 2. حدود الخط الخارجي لضمان عدم تداخل النص مع الحواف -->
      <text x="${textX}" y="${firstBaseline}" text-anchor="middle" font-family="'Cairo', 'Tajawal', 'Almarai', 'Arial', sans-serif" font-size="${fontSize}" font-weight="800" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-linejoin="round" direction="rtl" unicode-bidi="plaintext">${strokeLines}</text>

      <!-- 3. النص العربي (أسود للفقاعات البيضاء / أبيض للفقاعات المظلمة) -->
      <text x="${textX}" y="${firstBaseline}" text-anchor="middle" font-family="'Cairo', 'Tajawal', 'Almarai', 'Arial', sans-serif" font-size="${fontSize}" font-weight="800" fill="${textColor}" direction="rtl" unicode-bidi="plaintext">${fillLines}</text>
    `);
  }

  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${overlays.join("")}</svg>`,
  );

  const buffer = await sharp(original)
    .composite([{ input: svg }])
    .png({ compressionLevel: 9 })
    .toBuffer();

  return { buffer, width, height };
}
