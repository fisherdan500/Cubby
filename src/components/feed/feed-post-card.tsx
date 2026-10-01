import { MemberAvatar } from "@/components/members/member-avatar";
import Link from "next/link";
import { FeedPhotoGallery } from "@/components/feed/feed-photo-gallery";
import { FeedPostBody, FeedPostRemoveButton } from "@/components/feed/feed-post-actions";
import { feedHref } from "@/lib/feed";

type FeedPost = {
  id: string;
  babyId: string | null;
  body: string;
  occurredAt: Date;
  updatedAt: Date;
  authorName: string;
  authorPhotoAttachmentId?: string | null;
  canRemove: boolean;
  canEdit?: boolean;
  edited?: boolean;
  hasRetainedPhotos?: boolean;
  photos?: Array<{ id: string; width: number; height: number }>;
};

// The same rule that takes tags from a caption: a tag starts a word.
const TAG_IN_TEXT = /(^|\s)#([\p{L}\p{N}_]{1,40})/gu;

/**
 * A family post in the feed: who shared it, when, whether it is about the baby or the whole family,
 * and the caption with its #tags as links to every post that shares them. The family's reactions and
 * comments go in the footer.
 */
export function FeedPostCard({
  post,
  babyId,
  babyName,
  timeZone,
  footer
}: {
  post: FeedPost;
  babyId?: string;
  babyName?: string;
  timeZone: string;
  footer?: React.ReactNode;
}) {
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(post.occurredAt);
  const scope = post.babyId === null ? "The whole family" : babyName ? `About ${babyName}` : "";

  return (
    <article aria-label="Post" className="space-y-2 rounded-xl border border-border bg-card p-3.5">
      <header className="flex items-center gap-3">
        {/* The person who wrote it, not a generic pen: a household feed is people. */}
        <MemberAvatar name={post.authorName} photoAttachmentId={post.authorPhotoAttachmentId ?? null} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{post.authorName}</p>
          <p className="text-xs text-muted-foreground">
            <span className="tabular">{time}</span>
            {scope ? ` · ${scope}` : ""}
          </p>
        </div>
        {post.canRemove ? <FeedPostRemoveButton postId={post.id} /> : null}
      </header>
      <FeedPhotoGallery photos={post.photos ?? []} />
      <FeedPostBody key={post.id} postId={post.id} body={post.body} updatedAt={post.updatedAt} hasPhotos={post.hasRetainedPhotos ?? (post.photos?.length ?? 0) > 0} edited={post.edited ?? false} canEdit={post.canEdit ?? false}>
        {linkTags(post.body, babyId)}
      </FeedPostBody>
      {footer}
    </article>
  );
}

function linkTags(body: string, babyId?: string) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of body.matchAll(TAG_IN_TEXT)) {
    const start = (match.index ?? 0) + match[1].length;
    parts.push(body.slice(last, start));
    const tag = match[2];
    parts.push(
      <Link key={`${start}-${tag}`} href={feedHref({ babyId, filter: "posts", tag: tag.toLowerCase() })} className="font-semibold text-primary hover:underline">
        #{tag}
      </Link>
    );
    last = start + tag.length + 1;
  }
  parts.push(body.slice(last));
  return parts;
}
