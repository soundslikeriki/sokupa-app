import HomePageClient from "@/components/HomePageClient";
import { InviteGate } from "@/components/InviteGate";
export default function Home() {
  return (
    <InviteGate>
      <HomePageClient basicView={process.env.NEXT_PUBLIC_SOKUPA_INTERFACE_MODE === "basic"} />
    </InviteGate>
  );
}
