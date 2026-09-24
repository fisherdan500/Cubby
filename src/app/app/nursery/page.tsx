import { redirect } from "next/navigation";

/**
 * Nursery is retired: once dark became the default it duplicated Log Entry, with the same quick
 * actions and timers the shell's timer bar already carries. An old link or home-screen shortcut still
 * lands on Log Entry, for the same baby.
 */
export default function NurseryPage({ searchParams }: { searchParams: { babyId?: string } }) {
  redirect(searchParams.babyId ? `/app?${new URLSearchParams({ babyId: searchParams.babyId }).toString()}` : "/app");
}
