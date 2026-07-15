import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function ZeroActiveBabies({ canManageBabies }: { canManageBabies: boolean }) {
  return (
    <Card>
      <h2 className="text-lg font-bold">No active babies</h2>
      {canManageBabies ? (
        <>
          <p className="mb-4 text-sm text-muted-foreground">Reactivate a baby or add a new one before logging activities.</p>
          <Link href="/app/babies">
            <Button>Manage babies</Button>
          </Link>
        </>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            Your household has no active babies. You can still review historical activity.
          </p>
          <Link href="/app/history">
            <Button variant="secondary">View history</Button>
          </Link>
        </>
      )}
    </Card>
  );
}
