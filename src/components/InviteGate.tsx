"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Props = {
  children: React.ReactNode;
};

export function InviteGate({ children }: Props) {
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
        // --- 無制限ユーザー判定（招待コード/LINEログインをスキップ） ---
        // localStorage に line_user_id が既にある場合も常にチェックする
        let existingLineUserId: string | null = null;
        try {
          const lid = localStorage.getItem("sokupa:line_user_id");
          existingLineUserId = lid && lid.trim() ? lid : null;
        } catch {
          existingLineUserId = null;
        }

        if (existingLineUserId) {
          const res = await fetch(
            `/api/auth/check-unlimited?line_user_id=${encodeURIComponent(existingLineUserId)}`,
            { method: "GET" },
          );
          const json = (await res.json().catch(() => ({}))) as { unlimited?: boolean };
          if (!cancelled && json?.unlimited === true) {
            setInvited(true);
            setLineUserId(existingLineUserId);
            setReady(true);
            return;
          }
        }

      // LINEログイン完了後、クエリで戻ってくる（/api/auth/line/callback -> /?line_user_id=...）
      if (typeof window !== "undefined") {
        const sp = new URLSearchParams(window.location.search);
        const qLineUserId = sp.get("line_user_id");
        const qDisplayName = sp.get("display_name");
        if (qLineUserId) {
          localStorage.setItem("sokupa:line_user_id", qLineUserId);
          if (!cancelled) setLineUserId(qLineUserId);
        }
        if (qDisplayName) {
          localStorage.setItem("sokupa:display_name", qDisplayName);
          if (!cancelled) setDisplayName(qDisplayName);
        }
        if (qLineUserId || qDisplayName) {
          // クエリを消す
          window.history.replaceState({}, "", window.location.pathname);
        }

        // クエリで line_user_id が来た場合も無制限チェック
        if (qLineUserId) {
          const res = await fetch(
            `/api/auth/check-unlimited?line_user_id=${encodeURIComponent(qLineUserId)}`,
            { method: "GET" },
          );
          const json = (await res.json().catch(() => ({}))) as { unlimited?: boolean };
          if (!cancelled && json?.unlimited === true) {
            setInvited(true);
            setLineUserId(qLineUserId);
            setReady(true);
            return;
          }
        }
      }

      const v = localStorage.getItem("sokupa:invited");
      if (!cancelled) setInvited(v === "true");
      const lid = localStorage.getItem("sokupa:line_user_id");
      if (!cancelled) setLineUserId(lid && lid.trim() ? lid : null);
      const dn = localStorage.getItem("sokupa:display_name");
      if (!cancelled) setDisplayName(dn && dn.trim() ? dn : null);
      } catch {
        if (!cancelled) {
          setInvited(false);
          setLineUserId(null);
          setDisplayName(null);
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
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
      try {
        localStorage.setItem("sokupa:invited", "true");
      } catch {
        // ignore
      }
      setInvited(true);
    } finally {
      setSubmitting(false);
    }
  };

  if (!ready) return null;
  if (invited && lineUserId) return <>{children}</>;

  // Step 2: LINE login
  if (invited && !lineUserId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg items-center px-4 py-10">
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="text-xl">ソクパへようこそ</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">LINEでログインして通知を受け取る</p>
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
      </main>
    );
  }

  // Step 1: invite code
  return (
    <main className="mx-auto flex min-h-screen max-w-lg items-center px-4 py-10">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-xl text-center">ようこそ！ソクパへ</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground text-center">招待コードを入力してください</p>
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
    </main>
  );
}

