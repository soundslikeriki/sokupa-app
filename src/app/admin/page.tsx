import { cookies } from "next/headers";
import { AdminClient } from "./AdminClient";

export const dynamic = "force-dynamic";

const DEFAULT_ADMIN_LINE_USER_ID = "U24ce93805aa15b7601a5da448fc2d354";

export default function AdminPage() {
  const adminLineUserId = (process.env.ADMIN_LINE_USER_ID || DEFAULT_ADMIN_LINE_USER_ID).trim();
  const lineUserId = cookies().get("sokupa_line_user_id")?.value || "";

  console.log("[admin] auth-check", {
    hasAdminEnv: Boolean(process.env.ADMIN_LINE_USER_ID),
    adminLineUserIdLen: adminLineUserId.length,
    hasLineUserIdCookie: Boolean(lineUserId),
    lineUserIdLen: lineUserId.length,
    authorized: Boolean(lineUserId && lineUserId === adminLineUserId),
  });

  if (!lineUserId || lineUserId !== adminLineUserId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg items-center px-4 py-10">
        <div className="w-full rounded-lg border p-6">
          <h1 className="text-xl font-bold">403 Forbidden</h1>
          <p className="mt-2 text-sm text-muted-foreground">このページにアクセスする権限がありません。</p>
        </div>
      </main>
    );
  }

  return <AdminClient />;
}

