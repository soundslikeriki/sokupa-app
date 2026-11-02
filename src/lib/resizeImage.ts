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

  if (width <= 0 || height <= 0 || width * height > 60_000_000) throw new Error("HEIC画像が大きすぎるか不正です。画像を縮小して選び直してください。");

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
function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => { image.src = ""; reject(new Error("画像の読み込みがタイムアウトしました。画像を選び直してください。")); }, 20_000);
    image.onload = () => { clearTimeout(timer); resolve(image); };
    image.onerror = () => { clearTimeout(timer); reject(new Error("画像を読み込めませんでした。JPEGまたはPNGで保存し直してください。")); };
    image.src = source;
  });
}

function resizedCanvas(image: HTMLImageElement, maxDimension: number): HTMLCanvasElement {
  const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
  if (width <= 0 || height <= 0 || width * height > 60_000_000) throw new Error("画像サイズが大きすぎるか不正です。画像を縮小して選び直してください。");
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("画像処理を開始できませんでした。");
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function resizeStandardImage(file: File, maxDimension = 800, quality = 0.6): Promise<string> {
  const source = URL.createObjectURL(file);
  try {
    const canvas = resizedCanvas(await loadImage(source), maxDimension);
    const result = canvas.toDataURL("image/jpeg", quality);
    if (!result.startsWith("data:image/jpeg;base64,")) throw new Error("画像を変換できませんでした。");
    return result;
  } finally { URL.revokeObjectURL(source); }
}

export async function compressImageForUpload(dataUrl: string, maxDimension = 1500, quality = 0.8): Promise<Blob> {
  const canvas = resizedCanvas(await loadImage(dataUrl), maxDimension);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("画像の圧縮がタイムアウトしました。")), 20_000);
    try {
      canvas.toBlob((blob) => {
        clearTimeout(timer);
        if (!blob || !blob.size) reject(new Error("画像の圧縮に失敗しました。"));
        else resolve(blob);
      }, "image/jpeg", quality);
    } catch (error) { clearTimeout(timer); reject(error); }
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
  if (!file.size || file.size > 25 * 1024 * 1024) throw new Error("画像は25MB以内のファイルを選んでください。");
  if (isHeicLike(file)) {
    // iOS SafariではOS標準デコーダの方が高速かつ省メモリ。未対応環境のみWASMへ切り替える。
    try {
      return await resizeStandardImage(file, maxDimension, quality);
    } catch (nativeError) {
      console.log("[Sokupa] HEICネイティブ変換不可、WASM変換へ切り替え", {
        error: nativeError,
      });
      return convertHeicToJpegDataUrl(file, maxDimension, quality);
    }
  }
  return resizeStandardImage(file, maxDimension, quality);
}
