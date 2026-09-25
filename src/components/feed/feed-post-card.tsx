import Link from "next/link";
import { PenLine } from "lucide-react";
import { FeedPostRemoveButton } from "@/components/feed/feed-post-actions";
import { feedHref } from "@/lib/feed";

type FeedPost = {
  id: string;
  babyId: string | null;
  body: string;
  occurredAt: Date;
  authorName: string;
  canRemove: boolean;
};

// The same rule that takes tags from a caption: a tag starts a word.
const TAG_IN_TEXT = /(^|\s)#([\p{L}\p{N}_]{1,40})/gu;

/**
 * A family post in the feed: who shared it, when, whether it is about the baby or the whole family,
 * and the caption with its #tags as links to every post that shares them.
 */
export function FeedPostCard({
  post,
  babyId,
  babyName,
  timeZone
}: {
  post: FeedPost;
  babyId?: string;
  babyName?: string;
  timeZone: string;
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
      <p className="whitespace-pre-line break-words text-sm leading-6">{linkTags(post.body, babyId)}</p>
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
