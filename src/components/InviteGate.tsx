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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      // LINEログイン完了後、クエリで戻ってくる（/api/auth/line/callback -> /?line_user_id=...）
      if (typeof window !== "undefined") {
        const sp = new URLSearchParams(window.location.search);
        const qLineUserId = sp.get("line_user_id");
        const qDisplayName = sp.get("display_name");
        if (qLineUserId) {
          localStorage.setItem("sokupa:line_user_id", qLineUserId);
          setLineUserId(qLineUserId);
        }
        if (qDisplayName) {
          localStorage.setItem("sokupa:display_name", qDisplayName);
          setDisplayName(qDisplayName);
        }
        if (qLineUserId || qDisplayName) {
          // クエリを消す
          window.history.replaceState({}, "", window.location.pathname);
        }
      }

      const v = localStorage.getItem("sokupa:invited");
      setInvited(v === "true");
      const lid = localStorage.getItem("sokupa:line_user_id");
      setLineUserId(lid && lid.trim() ? lid : null);
      const dn = localStorage.getItem("sokupa:display_name");
      setDisplayName(dn && dn.trim() ? dn : null);
    } catch {
      setInvited(false);
      setLineUserId(null);
      setDisplayName(null);
    } finally {
      setReady(true);
    }
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
              <a href="/api/auth/line">LINEでログインして通知を受け取る</a>
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
          <CardTitle className="text-xl">ソクパへようこそ</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">招待コードを入力してください</p>
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
          <Button type="button" className="w-full h-12 text-base" onClick={() => void submit()} disabled={!canSubmit}>
            {submitting ? "確認中..." : "認証する"}
          </Button>
          {error ? <p className="text-sm font-semibold text-destructive">{error}</p> : null}
        </CardContent>
      </Card>
    </main>
  );
}

