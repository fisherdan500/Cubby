import Link from "next/link";
import { redirect } from "next/navigation";
import { Baby, ChartNoAxesCombined, Lock, Moon, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
    <main className="min-h-screen">
      <section className="mx-auto grid min-h-screen max-w-6xl items-center gap-8 px-4 py-10 md:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6">
          <div className="inline-flex rounded-full border border-border bg-card px-4 py-2 text-sm font-semibold text-muted-foreground">
            Private family baby-care tracking
          </div>
          <div className="space-y-3">
            <h1 className="text-5xl font-black tracking-normal sm:text-6xl">Cubby</h1>
            <p className="text-2xl font-semibold text-primary">Track the little things.</p>
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
        <div className="grid gap-3">
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
