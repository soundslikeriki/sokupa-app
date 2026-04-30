"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Result = {
  code: string;
  inviteMessage: string;
};

export function AdminClient() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);

  const canCopy = useMemo(() => Boolean(result?.inviteMessage), [result]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const generate = async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/admin/generate-invite", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as Partial<Result> & { error?: string };
      if (!res.ok) {
        setError(json?.error || "生成に失敗しました");
        return;
      }
      if (!json.code || !json.inviteMessage) {
        setError("レスポンスが不正です");
        return;
      }
      setResult({ code: json.code, inviteMessage: json.inviteMessage });
    } catch {
      setError("通信に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!result?.inviteMessage) return;
    try {
      await navigator.clipboard.writeText(result.inviteMessage);
      setCopied(true);
    } catch {
      setError("コピーに失敗しました");
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-start px-4 py-10">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-xl">ソクパ管理画面</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button type="button" className="w-full h-12 text-base" onClick={() => void generate()} disabled={loading}>
            {loading ? "生成中..." : "招待コードを生成する"}
          </Button>

          {error ? <p className="text-sm font-semibold text-destructive">{error}</p> : null}

          {result ? (
            <div className="space-y-3">
              <div className="rounded-md border p-3">
                <p className="text-sm text-muted-foreground">招待コード</p>
                <p className="text-2xl font-bold tracking-widest">{result.code}</p>
              </div>

              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">招待メッセージ</p>
                <textarea
                  className="w-full min-h-[320px] rounded-md border bg-background p-3 text-sm leading-relaxed"
                  value={result.inviteMessage}
                  readOnly
                />
              </div>

              <Button type="button" className="w-full h-12 text-base" onClick={() => void copy()} disabled={!canCopy}>
                {copied ? "✅ コピーしました！" : "招待メッセージをコピー"}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}

