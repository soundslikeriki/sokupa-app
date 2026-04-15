import HomePageClient from "@/components/HomePageClient";
import { InviteGate } from "@/components/InviteGate";
export default function Home() {
  return (
    <InviteGate>
      <HomePageClient />
    </InviteGate>
  );
}
