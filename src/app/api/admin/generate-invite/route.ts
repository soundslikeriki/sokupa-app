import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_ADMIN_LINE_USER_ID = "U24ce93805aa15b7601a5da448fc2d354";

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 紛らわしい文字（0,O,1,I）を除外
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
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
    const adminLineUserId = (process.env.ADMIN_LINE_USER_ID || DEFAULT_ADMIN_LINE_USER_ID).trim();
    const lineUserId = req.cookies.get("sokupa_line_user_id")?.value || "";
    if (!lineUserId || lineUserId !== adminLineUserId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const admin = createSupabaseAdmin();
    if (!admin) {
      return NextResponse.json({ error: "Supabase admin not configured" }, { status: 500 });
    }

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

