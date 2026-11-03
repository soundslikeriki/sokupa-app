import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/server-auth";
import { SESSION_COOKIE, verifyToken } from "@/lib/session-token";
import { cookies } from "next/headers";
import { AdminClient } from "./AdminClient";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const claims = verifyToken((await cookies()).get(SESSION_COOKIE)?.value, "session");
  if (!claims || !isAdmin(claims.subject)) redirect("/api/auth/line");
  return <AdminClient />;
}
