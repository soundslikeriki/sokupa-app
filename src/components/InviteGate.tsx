"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Props = {
  children: React.ReactNode;
};

export function InviteGate({ children }: Props) {
  const [qa, setQa] = useState(false);
  const [ready, setReady] = useState(false);
  const [invited, setInvited] = useState(false);
  const [lineUserId, setLineUserId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        // Legacy IDs remain display hints only. The server verifies a signed HttpOnly session.
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        const session = await response.json();
        if (cancelled) return;
        setQa(Boolean(session.qa?.synthetic));
        if (!response.ok) throw new Error("ログイン状態を確認できません。通信を確認して再読み込みしてください。");
        setInvited(Boolean(session.authenticated || session.invited));
        setLineUserId(session.authenticated ? session.line_user_id : null);
        setDisplayName(session.authenticated ? session.display_name : null);
        const params = new URLSearchParams(window.location.search);
        if (params.get("auth_error")) setError("招待コードを確認してからLINEでログインしてください。");
        if (params.has("line_user_id") || params.has("display_name") || params.has("logout")) {
          window.history.replaceState({}, "", window.location.pathname);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "通信に失敗しました");
      } finally {
        if (!cancelled) setReady(true);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, []);

  const normalized = useMemo(() => code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8), [code]);
  const canSubmit = normalized.length === 8 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/invite/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: normalized }),
      });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean };
      if (!res.ok || !json.success) {
        setError("コードが無効です");
        return;
      }
      setInvited(true);
    } catch {
      setError("通信に失敗しました。再度お試しください。");
    } finally {
      setSubmitting(false);
    }
  };

  const banner = qa ? <div role="status" className="border-b border-amber-300 bg-amber-50 p-3 text-center text-sm text-amber-950">ソクパQA：本人専用の検証環境。画像解析とLINE通知は合成です。実際の発注には使わないでください。</div> : null;
  if (!ready) return null;
  if (invited && lineUserId) return <>{banner}{children}</>;

  // Step 2: LINE login
  if (invited && !lineUserId) {
    return (
      <>{banner}<main className="mx-auto flex min-h-screen max-w-lg items-center px-4 py-10">
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="text-xl">ソクパへようこそ</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{qa ? "LINEで本人確認（通知は合成試験）" : "LINEでログインして通知を受け取る"}</p>
            {displayName ? (
              <p className="text-sm text-muted-foreground">
                ログイン中: <span className="font-semibold">{displayName}</span>
              </p>
            ) : null}
            <Button type="button" className="w-full h-12 text-base bg-[#06C755] hover:bg-[#05b34c]" asChild>
              <a href="/api/auth/line">LINEでログイン</a>
            </Button>
          </CardContent>
        </Card>
      </main></>
    );
  }

  // Step 1: invite code
  return (
    <>{banner}<main className="mx-auto flex min-h-screen max-w-lg items-center px-4 py-10">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-xl text-center">ようこそ！ソクパへ</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground text-center">初めての方は招待コードを入力してください</p>
          <Button type="button" variant="outline" className="w-full" asChild>
            <a href="/api/auth/line">登録済みの方・管理者はLINEでログイン</a>
          </Button>
          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              id="terms"
              checked={agreedToTerms}
              onChange={(e) => setAgreedToTerms(e.target.checked)}
              className="mt-1 h-4 w-4 cursor-pointer"
            />
            <label htmlFor="terms" className="text-xs text-muted-foreground leading-relaxed cursor-pointer">
              <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline font-medium">
                利用規約
              </a>
              を読み、内容に同意します
            </label>
          </div>
          <Input
            value={normalized}
            onChange={(e) => setCode(e.target.value)}
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="8文字（英数字）"
            className="h-12 text-center text-lg font-bold tracking-widest"
            maxLength={8}
          />
          <Button
            type="button"
            className="w-full h-12 text-base"
            onClick={() => void submit()}
            disabled={!canSubmit || !agreedToTerms}
          >
            {submitting ? "確認中..." : "認証する"}
          </Button>
          {error ? <p className="text-sm font-semibold text-destructive">{error}</p> : null}
        </CardContent>
      </Card>
    </main></>
  );
}

