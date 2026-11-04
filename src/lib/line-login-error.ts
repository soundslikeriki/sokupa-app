import { NextResponse } from "next/server";

export type LineLoginError = "state" | "cancelled" | "provider" | "configuration" | "invite";

/** A top-level browser navigation needs a UTF-8 recovery page, never a raw provider error. */
export function lineLoginErrorResponse(reason: LineLoginError, status = 400): NextResponse {
  const message = {
    state: "ログインを始めた画面と、戻ってきた画面の確認情報が一致しませんでした。Safari・LINE内ブラウザ・ホーム画面のアプリは、保存先が別になる場合があります。",
    cancelled: "LINEでのログインがキャンセルされました。準備ができたら、もう一度お試しください。",
    provider: "ログインを完了できませんでした。通信状況を確認し、時間をおいてもう一度お試しください。",
    configuration: "ログインの準備を確認できませんでした。時間をおいてもう一度お試しください。",
    invite: "招待コードを確認できませんでした。ソクパに戻ってコードを入力してから、もう一度ログインしてください。",
  }[reason];
  // All interpolated strings are selected locally; query values/codes/tokens are never echoed.
  return new NextResponse(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ソクパ — ログインの確認</title><style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#172033;margin:0;padding:32px 20px}main{max-width:480px;margin:8vh auto;background:white;padding:28px;border-radius:16px}h1{font-size:22px}p{line-height:1.8}a{display:block;margin-top:20px;color:#075b31}a.primary{background:#087b43;color:white;padding:14px;text-align:center;border-radius:8px;text-decoration:none}</style></head><body><main><h1>ログインを確認してください</h1><p>${message}</p><p>このブラウザでログインをやり直せます。LINEアプリへ自動で切り替えずに進みます。もとのソクパを開いていたブラウザからの再試行もできます。</p><a class="primary" href="/api/auth/line?browser=1">このブラウザでログインし直す</a><a href="/">ソクパに戻る</a></main></body></html>`, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}
