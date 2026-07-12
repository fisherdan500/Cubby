import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { Baby, ChartNoAxesCombined, Lock, Moon, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BrandMark } from "@/components/brand";
import { getSession } from "@/server/auth/session";

const featureCards: Array<[string, React.ElementType, string]> = [
  ["Fast logging", Baby, "Large mobile controls for common care events."],
  ["Trusted sessions", Lock, "Stay signed in on your own phone without repeat full logins."],
  ["Night use", Moon, "Dark mode and nursery mode for low-light care."],
  ["Shared care", Users, "Invite parents, caretakers, and read-only helpers."],
  ["Exportable data", ChartNoAxesCombined, "CSV export is built into v1."]
];

export default async function HomePage() {
  const session = await getSession();
  if (session?.user) redirect("/app");

  return (
    <main className="min-h-screen overflow-hidden">
      <section className="relative flex min-h-[78svh] items-center overflow-hidden border-b border-border px-4 py-14">
        <Image
          src="/activity-art/sleep.webp"
          alt=""
          width={250}
          height={250}
          className="pointer-events-none absolute -right-12 top-16 h-44 w-44 rotate-6 object-contain opacity-45 sm:right-8 sm:h-56 sm:w-56 sm:opacity-80"
        />
        <Image
          src="/activity-art/feeding.webp"
          alt=""
          width={210}
          height={210}
          className="pointer-events-none absolute -bottom-8 right-20 hidden h-44 w-44 -rotate-6 object-contain opacity-65 sm:block"
        />
        <Image
          src="/activity-art/milestone.webp"
          alt=""
          width={180}
          height={180}
          className="pointer-events-none absolute bottom-6 left-[52%] hidden h-36 w-36 object-contain opacity-55 lg:block"
        />
        <div className="relative z-10 mx-auto w-full max-w-6xl">
          <div className="max-w-2xl space-y-6">
          <BrandMark size="xl" priority />
          <div className="inline-flex rounded-full border border-border bg-card px-4 py-2 text-sm font-semibold text-muted-foreground">
            Private family baby-care tracking
          </div>
          <div className="space-y-3">
            <h1 className="font-editorial text-5xl font-bold sm:text-6xl">Cubby</h1>
            <p className="font-editorial text-2xl font-semibold text-primary">Track the little things.</p>
            <p className="max-w-xl text-lg leading-8 text-muted-foreground">
              Fast feeding, diaper, sleep, medicine, milestone, and note tracking for families who want reliable self-hosted data and calmer nights.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/register">
              <Button>Create owner account</Button>
            </Link>
            <Link href="/login">
              <Button variant="secondary">Sign in</Button>
            </Link>
          </div>
        </div>
        </div>
      </section>
      <section className="bg-surface/55 px-4 py-8">
        <div className="mx-auto grid max-w-6xl gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {featureCards.map(([title, Icon, text]) => (
            <Card key={String(title)} className="flex items-start gap-3">
              <div className="rounded-lg bg-primary/10 p-2 text-primary">
                <Icon className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-bold">{title}</h2>
                <p className="text-sm text-muted-foreground">{text}</p>
              </div>
            </Card>
          ))}
        </div>
      </section>
    </main>
  );
}
