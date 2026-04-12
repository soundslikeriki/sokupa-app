"use client";

import { useCallback, useId, useState } from "react";
import { Loader2, Upload, X } from "lucide-react";

import { OrderList } from "@/components/OrderList";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DEFAULT_LOSS_RATE_PERCENT } from "@/lib/calc-logic";
import { APP_FORMAL_NAME, APP_HEADER_CREDIT, APP_PRODUCT_NAME } from "@/lib/appMetadata";
import { convertAndResizeForPreview } from "@/lib/resizeImage";

type ProcessedImage = {
  id: string;
  originalName: string;
  previewUrl: string;
  base64Data?: string;
  status: "converting" | "ready" | "error";
};
import { cn } from "@/lib/utils";
import type { ParsedMemoPayload } from "@/types";

export default function HomePageClient() {
  const uploadInputId = useId();
  const siteNameId = useId();
  const [siteName, setSiteName] = useState("");
  const [images, setImages] = useState<ProcessedImage[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [parsed, setParsed] = useState<ParsedMemoPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;

    const imageFiles = files.filter(
      (f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name),
    );
    if (imageFiles.length === 0) return;

    const newImages: ProcessedImage[] = imageFiles.map((file) => ({
      id: Math.random().toString(36).slice(2) + Date.now().toString(36),
      originalName: file.name,
      previewUrl: "",
      status: "converting" as const,
    }));

    setImages((prev) => [...prev, ...newImages]);
    setError(null);

    Promise.all(
      newImages.map(async (imgObj, idx) => {
        const file = imageFiles[idx];
        try {
          // Send 2400px image so Gemini can read handwritten details clearly with 0.9 quality
          const dataUrl = await convertAndResizeForPreview(file, 2400, 0.9);
          setImages((prev) =>
            prev.map((img) =>
              img.id === imgObj.id
                ? {
                    ...img,
                    previewUrl: dataUrl,
                    base64Data: dataUrl.replace(/^data:image\/jpeg;base64,/, ""),
                    status: "ready",
                  }
                : img
            )
          );
        } catch (err) {
          console.error("画像処理エラー", err);
          setImages((prev) =>
            prev.map((img) =>
              img.id === imgObj.id ? { ...img, status: "error" } : img
            )
          );
        }
      })
    );
  }, []);

  const removeFile = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const handleAnalyze = async () => {
    const readyImages = images.filter((img) => img.status === "ready" && img.base64Data);
    if (readyImages.length === 0) return;
    setIsAnalyzing(true);
    setError(null);
    setParsed(null);

    try {
      const resizedBase64s = readyImages.map((img) => img.base64Data as string);

      const res = await fetch("/api/parse-memo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64Images: resizedBase64s,
          mimeType: "image/jpeg",
        }),
      });

      type ApiJson = { success?: boolean; data?: ParsedMemoPayload; error?: string };
      let data: ApiJson;
      try {
        data = (await res.json()) as ApiJson;
      } catch {
        throw new Error(`サーバーからの応答がJSONではありません（HTTP ${res.status}）。`);
      }

      if (!res.ok || data.error) {
        throw new Error(data.error || "解析に失敗しました");
      }
      if (!data.success || !data.data || !Array.isArray(data.data.items)) {
        throw new Error("応答形式が不正です（success / data.items を確認してください）。");
      }

      setParsed({
        items: data.data.items,
        notes: data.data.notes,
        needs_review_any: data.data.needs_review_any,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "解析中にエラーが発生しました");
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-2 py-8 sm:gap-8 sm:px-4 sm:py-10 md:px-6 lg:px-8">
      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 sm:gap-x-3">
          <p className="text-sm font-medium text-muted-foreground shrink-0">{APP_FORMAL_NAME}</p>
          <span className="text-xs text-muted-foreground/90 opacity-70 min-w-0 max-w-full leading-snug">
            {APP_HEADER_CREDIT}
          </span>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">{APP_PRODUCT_NAME}</h1>
        <p className="max-w-2xl text-muted-foreground">
          計測メモ画像をアップロードすると、品番・計算式・実測合計を読み取り、メーカー別に整理します。発注数量は実測に
          {DEFAULT_LOSS_RATE_PERCENT}%のロスを加えて切り上げています。
          <span className="text-xs text-muted-foreground">（※ロス率変更可能）</span>
        </p>
      </header>

      <div className="space-y-8">
        <div>
          <span className="mb-2 block text-sm font-medium">メモ画像（複数選択可）</span>
          <div
            className={cn(
              "rounded-xl border-2 border-dashed border-border p-8 text-center transition-colors",
              "hover:bg-muted/30",
            )}
          >
            <Upload className="mx-auto mb-4 h-12 w-12 text-muted-foreground" aria-hidden />
            <p className="text-lg">クリックで画像を追加</p>
            <p className="mt-1 text-sm text-muted-foreground">
              PNG / JPEG / WebP / HEIC ・ 複数枚OK（最大16枚）
            </p>
            <input
              id={uploadInputId}
              type="file"
              multiple
              accept="image/*"
              onChange={(e) => void handleFileSelect(e)}
              className="sr-only"
            />
            <Button type="button" variant="default" className="mt-4" asChild>
              <label htmlFor={uploadInputId} className="cursor-pointer">
                画像を選択
              </label>
            </Button>
          </div>
        </div>

        {images.length > 0 ? (
          <div>
            <h3 className="mb-3 font-medium">選択中の画像（{images.length}枚）</h3>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
              {images.map((img, index) => (
                <div key={img.id} className="group relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border bg-muted/50">
                  {img.status === "converting" && (
                    <div className="flex flex-col items-center gap-2 text-muted-foreground p-4 text-center">
                      <Loader2 className="h-6 w-6 animate-spin" />
                      <span className="text-sm font-medium">変換中...</span>
                    </div>
                  )}
                  {img.status === "error" && (
                    <div className="flex flex-col items-center gap-2 text-destructive p-4 text-center">
                      <span className="text-sm font-medium">エラー</span>
                    </div>
                  )}
                  {img.status === "ready" && img.previewUrl && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={img.previewUrl}
                      alt={`プレビュー ${index + 1}`}
                      className="h-full w-full object-cover"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => removeFile(img.id)}
                    className="absolute right-2 top-2 rounded-full bg-destructive p-1.5 text-destructive-foreground opacity-0 shadow transition-opacity group-hover:opacity-100"
                    aria-label={`画像 ${index + 1} を削除`}
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <Button
          type="button"
          onClick={() => void handleAnalyze()}
          disabled={images.length === 0 || images.some(i => i.status !== "ready") || isAnalyzing}
          className="w-full py-6 text-lg"
        >
          {isAnalyzing ? (
            <>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              解析中…
            </>
          ) : (
            `${images.length}枚の画像を解析する`
          )}
        </Button>
      </div>

      {error ? (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-base text-destructive">エラー</CardTitle>
            <CardDescription className="text-destructive/90">{error}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {(parsed?.items.length ?? 0) > 0 ? (
        <div className="mb-6">
          <label htmlFor={siteNameId} className="mb-1 block text-sm font-medium">
            現場名
          </label>
          <Input
            id={siteNameId}
            type="text"
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            placeholder="例: 渋谷区〇〇マンション リビング"
            className="rounded-lg px-4 py-2 focus-visible:ring-black"
          />
        </div>
      ) : null}

      <OrderList
        items={parsed?.items ?? []}
        notes={parsed?.notes}
        siteName={siteName}
        needs_review_any={parsed?.needs_review_any}
      />
    </main>
  );
}
