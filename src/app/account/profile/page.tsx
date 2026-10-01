import Link from "next/link";

import { BrowserOperationRecovery } from "@/components/browser-operation-recovery";
import { ProfilePhotoControl } from "@/components/members/profile-photo-control";
import { Card } from "@/components/ui/card";
import { requireUserPage } from "@/server/auth/session";
import { getOwnProfilePhoto } from "@/server/services/profile-photo";

/**
 * Your own picture.
 *
 * An account page rather than a household setting, and deliberately not behind member.manage: a
 * caretaker sets their own face without being allowed to administer the household. The picture
 * belongs to this membership, so someone in two households has a separate one in each.
 */
export default async function AccountProfilePage() {
  const user = await requireUserPage();
  const { photoAttachmentId } = await getOwnProfilePhoto();

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-3 py-8 md:px-8">
      <Link href="/app/settings" className="text-sm font-bold text-primary">Back to Cubby</Link>
      <BrowserOperationRecovery />
      <Card className="mt-4">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Personal account</p>
        <h1 className="font-editorial text-2xl font-semibold">Your picture</h1>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">
          This is how {user.name} appears beside the moments you post in this household. Everyone in
          the household can see it; it is never shown outside.
        </p>
        <ProfilePhotoControl name={user.name} photoAttachmentId={photoAttachmentId} />
      </Card>
    </main>
  );
}
