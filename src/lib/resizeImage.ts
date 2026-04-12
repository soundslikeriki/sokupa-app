// @ts-ignore
import decode from "heic-decode";

export function isHeicLike(file: File): boolean {
  const t = file.type.toLowerCase();
  return (
    t === "image/heic" ||
    t === "image/heif" ||
    file.name.toLowerCase().endsWith(".heic") ||
    file.name.toLowerCase().endsWith(".heif")
  );
}

/**
 * HEICをデコードして、指定サイズに縮小したJPEGのDataURLを返す
 */
export async function convertHeicToJpegDataUrl(
  file: File,
  maxDimension: number = 800,
  quality: number = 0.6
): Promise<string> {
  const buffer = await file.arrayBuffer();
  // Decode the HEIC file into raw pixel data
  const { width, height, data } = await decode({ buffer: new Uint8Array(buffer) });

  let newWidth = width;
  let newHeight = height;
  if (width > maxDimension || height > maxDimension) {
    const ratio = Math.min(maxDimension / width, maxDimension / height);
    newWidth = Math.floor(width * ratio);
    newHeight = Math.floor(height * ratio);
  }

  // Draw original data to offscreen canvas
  const offCanvas = document.createElement("canvas");
  offCanvas.width = width;
  offCanvas.height = height;
  const offCtx = offCanvas.getContext("2d");
  if (!offCtx) throw new Error("Canvas 2D context not supported");

  const imageData = new ImageData(new Uint8ClampedArray(data), width, height);
  offCtx.putImageData(imageData, 0, 0);

  // Draw scaled onto destination canvas
  const canvas = document.createElement("canvas");
  canvas.width = newWidth;
  canvas.height = newHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context not supported");

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.filter = "contrast(1.15) brightness(1.05)";
  ctx.drawImage(offCanvas, 0, 0, newWidth, newHeight);

  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * 標準画像をCanvas経由でリサイズし、DataURLとして返す
 */
export async function resizeStandardImage(
  file: File,
  maxDimension: number = 800,
  quality: number = 0.6
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          const ratio = Math.min(maxDimension / width, maxDimension / height);
          width = Math.floor(width * ratio);
          height = Math.floor(height * ratio);
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas 2D コンテキストを取得できませんでした。"));
          return;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.filter = "contrast(1.15) brightness(1.05)";
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("画像の読み込みに失敗しました。"));
      const result = e.target?.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader の結果が不正です。"));
        return;
      }
      img.src = result;
    };
    reader.onerror = () => reject(reader.error ?? new Error("ファイルの読み込みに失敗しました。"));
    reader.readAsDataURL(file);
  });
}

/**
 * ファイルを判別し、適切に軽量な JPEG Base64 (DataURL) に変換して返す。
 */
export async function convertAndResizeForPreview(
  file: File,
  maxDimension: number = 800,
  quality: number = 0.6
): Promise<string> {
  if (isHeicLike(file)) {
    return convertHeicToJpegDataUrl(file, maxDimension, quality);
  }
  return resizeStandardImage(file, maxDimension, quality);
}
