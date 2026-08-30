"use client";

import React from "react";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-11 min-h-11 w-full justify-start rounded-md px-3"
      aria-label="Sign out"
      title="Sign out"
      onClick={() => {
        router.push("/app/settings/sessions");
      }}
    >
      <LogOut className="h-5 w-5" />
      Sign out securely
    </Button>
  );
}
