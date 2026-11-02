import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server-auth";
import { randomInt } from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 60;

export const dynamic = "force-dynamic";


function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 紛らわしい文字（0,O,1,I）を除外
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[randomInt(chars.length)];
  }
  return code;
}

function buildInviteMessage(code: string): string {
  return `ソクパのログイン手順です！

① こちらからアクセス👇
https://sokupa-app.vercel.app

② 画面に「ようこそ！ソクパへ」と出たら
「利用規約を読み、内容に同意します」の左の□をタップ✅

③ 入力欄に下の招待コードを入力

【招待コード】
${code}

↑ このコードをそのまま入力してください

④「認証する」ボタンを押す

⑤ 緑色の「LINEでログイン」ボタンを押す

⑥ LINEの画面が出たら「許可する」を押す

⑦ ソクパの画面が開いたら完了です！🎉

次回からはブックマークをタップするだけで直接開きます。

⑧ ホーム画面に追加するとアプリとして使えます！
　 iPhone：画面下の「共有ボタン」→「ホーム画面に追加」
　 Android：画面右上の「︙」→「ホーム画面に追加」`;
}

export async function POST(req: NextRequest) {
  try {
    const auth = await authorize(req);
    if (auth.error) return auth.error;
    if (!auth.owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const { admin } = auth;

    // Generate & insert (retry a few times in case of rare collision)
    let lastError: string | null = null;
    for (let i = 0; i < 5; i++) {
      const code = generateCode();
      const { error } = await admin.from("invite_codes").insert({ code, is_used: false });
      if (!error) {
        return NextResponse.json({ code, inviteMessage: buildInviteMessage(code) });
      }
      lastError = error.message;
    }

    return NextResponse.json({ error: lastError || "Failed to generate invite" }, { status: 500 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal Server Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
