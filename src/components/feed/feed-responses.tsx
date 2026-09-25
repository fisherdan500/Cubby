"use client";

import { useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { runFeedOperation } from "@/components/feed/feed-post-actions";
import {
  FEED_COMMENT_MAX_LENGTH,
  feedReactions,
  joinNames,
  type FeedParentKind,
  type FeedReactionKey,
  type FeedReactionSummary
} from "@/domain/feed-interactions";

type FeedComment = {
  id: string;
  body: string;
  authorName: string;
  createdAt: Date;
  edited: boolean;
  canEdit: boolean;
  canRemove: boolean;
};

/**
 * The family's responses under a post or a logged entry (DEC-PROD-421): who reacted, by name - never
 * a count - and the comments, oldest first. Reacting or commenting never changes the entry itself.
 */
export function FeedResponses({
  parentKind,
  parentId,
  reactions,
  comments,
  canRespond,
  timeZone
}: {
  parentKind: FeedParentKind;
  parentId: string;
  reactions: FeedReactionSummary[];
  comments: FeedComment[];
  canRespond: boolean;
  timeZone: string;
}) {
  const router = useRouter();
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<FeedReactionKey | null>(null);
  const commentBox = useRef<HTMLTextAreaElement>(null);
  const parent = { parentKind, parentId };

  // A phone raises its keyboard only when focus lands during the tap itself, so the box is put on the
  // page within the tap, focused, and brought up from under any long run of comments.
  function startComment() {
    flushSync(() => setComposing(true));
    commentBox.current?.focus();
    commentBox.current?.scrollIntoView({ block: "center" });
  }

  async function react(reaction: FeedReactionKey, on: boolean) {
    setError("");
    setPending(reaction);
    const outcome = await runFeedOperation(
      `cubby:feed-reaction:${parentKind}:${parentId}:${reaction}`,
      "/api/feed/reactions",
      "PUT",
      { ...parent, reaction, on },
      parent
    );
    setPending(null);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    router.refresh();
  }

  const mine = new Set(reactions.filter((reaction) => reaction.mine).map((reaction) => reaction.key));

  return (
    <div className="space-y-2 border-t border-border pt-2">
      {reactions.length ? (
        <ul aria-label="Reactions" className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {reactions.map((reaction) => (
            <li key={reaction.key}>
              <span aria-hidden="true">{reaction.emoji}</span>
              <span className="sr-only">{reaction.label}:</span> {joinNames(reaction.names)}
            </li>
          ))}
        </ul>
      ) : null}

      {canRespond ? (
        <div className="flex flex-wrap items-center gap-1">
          <div role="group" aria-label="React" className="flex flex-wrap gap-1">
            {feedReactions.map((reaction) => {
              const chosen = mine.has(reaction.key);
              return (
                <button
                  key={reaction.key}
                  type="button"
                  aria-label={reaction.label}
                  aria-pressed={chosen}
                  disabled={pending !== null}
                  onClick={() => void react(reaction.key, !chosen)}
                  className={`inline-flex h-11 w-11 items-center justify-center rounded-full text-lg transition ${
                    chosen ? "bg-primary/15 ring-1 ring-primary" : "hover:bg-muted"
                  }`}
                >
                  <span aria-hidden="true">{reaction.emoji}</span>
                </button>
              );
            })}
          </div>
          {!composing ? (
            <button
              type="button"
              onClick={startComment}
              className="ml-auto inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <MessageCircle className="h-4 w-4" aria-hidden="true" />
              Comment
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="text-xs font-semibold text-danger">{error}</p> : null}

      {comments.length ? (
        <ul aria-label="Comments" className="space-y-2">
          {comments.map((comment) => <FeedCommentItem key={comment.id} comment={comment} timeZone={timeZone} />)}
        </ul>
      ) : null}

      {canRespond && composing ? (
        <FeedCommentComposer parentKind={parentKind} parentId={parentId} boxRef={commentBox} onDone={() => setComposing(false)} />
      ) : null}
    </div>
  );
}

function FeedCommentComposer({
  parentKind,
  parentId,
  boxRef,
  onDone
}: {
  parentKind: FeedParentKind;
  parentId: string;
  boxRef: RefObject<HTMLTextAreaElement>;
  onDone: () => void;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function send() {
    if (!body.trim()) {
      setError("Write something to share first.");
      return;
    }
    setError("");
    setSubmitting(true);
    const parent = { parentKind, parentId };
    const outcome = await runFeedOperation(`cubby:feed-comment-create:${parentKind}:${parentId}`, "/api/feed/comments", "POST", { ...parent, body }, parent);
    setSubmitting(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setBody("");
    onDone();
    router.refresh();
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label className="grid gap-1 text-sm font-semibold">
        <span className="sr-only">Your comment</span>
        <Textarea ref={boxRef} value={body} maxLength={FEED_COMMENT_MAX_LENGTH} rows={2} onChange={(event) => setBody(event.target.value)} placeholder="Add your two cents…" />
      </label>
      {error ? <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm font-semibold text-danger">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>{submitting ? "Sending..." : "Send"}</Button>
        <Button type="button" variant="ghost" disabled={submitting} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function FeedCommentItem({ comment, timeZone }: { comment: FeedComment; timeZone: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"view" | "edit" | "confirm-remove">("view");
  const [draft, setDraft] = useState(comment.body);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const url = `/api/feed/comments/${encodeURIComponent(comment.id)}`;
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(comment.createdAt);

  async function run(storageName: string, method: "PATCH" | "DELETE", fields: Record<string, unknown>) {
    setError("");
    setSubmitting(true);
    const outcome = await runFeedOperation(`${storageName}:${comment.id}`, url, method, fields);
    setSubmitting(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setMode("view");
    router.refresh();
  }

  return (
    <li className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
      <p className="text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{comment.authorName}</span> · <span className="tabular">{time}</span>
      </p>
      {mode === "edit" ? (
        <form
          className="mt-1 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.trim()) {
              setError("Write something to share first.");
              return;
            }
            void run("cubby:feed-comment-update", "PATCH", { body: draft });
          }}
        >
          <label className="grid gap-1">
            <span className="sr-only">Edit your comment</span>
            <Textarea value={draft} maxLength={FEED_COMMENT_MAX_LENGTH} rows={2} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={submitting}>{submitting ? "Saving..." : "Save"}</Button>
            <Button type="button" variant="ghost" disabled={submitting} onClick={() => { setMode("view"); setDraft(comment.body); setError(""); }}>Cancel</Button>
          </div>
        </form>
      ) : (
        <p className="whitespace-pre-line break-words">
          {comment.body}
          {comment.edited ? <span className="ml-1 text-xs text-muted-foreground">edited</span> : null}
        </p>
      )}
      {mode === "view" && (comment.canEdit || comment.canRemove) ? (
        <div className="flex gap-1 text-xs">
          {comment.canEdit ? (
            <button
              type="button"
              aria-label="Edit comment"
              onClick={() => { setDraft(comment.body); setMode("edit"); }}
              className="inline-flex min-h-11 items-center rounded-lg px-2 font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Edit
            </button>
          ) : null}
          {comment.canRemove ? (
            <button
              type="button"
              aria-label="Remove comment"
              onClick={() => setMode("confirm-remove")}
              className="inline-flex min-h-11 items-center rounded-lg px-2 font-semibold text-muted-foreground hover:bg-muted hover:text-danger"
            >
              Remove
            </button>
          ) : null}
        </div>
      ) : null}
      {mode === "confirm-remove" ? (
        <div role="group" aria-label="Confirm removing this comment" className="mt-1 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-danger">Remove this comment?</span>
          <Button type="button" variant="secondary" disabled={submitting} onClick={() => setMode("view")}>Keep</Button>
          <Button type="button" variant="danger" disabled={submitting} onClick={() => void run("cubby:feed-comment-delete", "DELETE", {})}>
            {submitting ? "Removing..." : "Remove"}
          </Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-1 text-xs font-semibold text-danger">{error}</p> : null}
    </li>
  );
}
