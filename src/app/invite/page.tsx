import { BrandLockup } from "@/components/brand";
import { InvitationBootstrap } from "@/components/invitations/invitation-bootstrap";
import { InvitationWorkflow } from "@/components/invitations/invitation-workflow";
import { Card } from "@/components/ui/card";

export default function InvitePage() {
  return <main className="flex min-h-screen items-center justify-center px-4 py-8"><Card className="w-full max-w-2xl space-y-5"><BrandLockup orientation="vertical" size="lg" className="mx-auto" priority /><InvitationBootstrap /><InvitationWorkflow /></Card></main>;
}
