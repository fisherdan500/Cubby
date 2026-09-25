import Link from "next/link";
import { PenLine } from "lucide-react";
import { FeedPostBody, FeedPostRemoveButton } from "@/components/feed/feed-post-actions";
import { feedHref } from "@/lib/feed";

type FeedPost = {
  id: string;
  babyId: string | null;
  body: string;
  occurredAt: Date;
  authorName: string;
  canRemove: boolean;
  canEdit?: boolean;
  edited?: boolean;
  photos?: Array<{ id: string; width: number; height: number }>;
};

/**
 * A post's photos, served only through Cubby's private photo address. One photo shows at its own
 * shape; several share a grid of squares. Each opens full size.
 */
function FeedPhotoGrid({ photos }: { photos: Array<{ id: string; width: number; height: number }> }) {
  if (photos.length === 0) return null;
  const single = photos.length === 1;
  const columns = single ? "" : photos.length === 2 || photos.length === 4 ? "grid-cols-2" : "grid-cols-3";
  return (
    <ul aria-label="Photos" className={single ? "" : `grid gap-1 ${columns}`}>
      {photos.map((photo, index) => (
        <li key={photo.id}>
          <a href={`/api/attachments/${photo.id}`} target="_blank" rel="noopener" className="block overflow-hidden rounded-lg bg-muted">
            {/* Served by Cubby's own checked endpoint; the image optimizer could not carry the viewer's session. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/attachments/${photo.id}`}
              width={photo.width}
              height={photo.height}
              loading="lazy"
              alt={`Photo ${index + 1} of ${photos.length}`}
              className={single ? "h-auto max-h-[32rem] w-full object-contain" : "aspect-square h-full w-full object-cover"}
            />
          </a>
        </li>
      ))}
    </ul>
  );
}

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
        <span aria-hidden="true" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <PenLine className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{post.authorName}</p>
          <p className="text-xs text-muted-foreground">
            <span className="tabular">{time}</span>
            {scope ? ` · ${scope}` : ""}
          </p>
        </div>
        {post.canRemove ? <FeedPostRemoveButton postId={post.id} /> : null}
      </header>
      <FeedPhotoGrid photos={post.photos ?? []} />
      <FeedPostBody postId={post.id} body={post.body} edited={post.edited ?? false} canEdit={post.canEdit ?? false}>
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
