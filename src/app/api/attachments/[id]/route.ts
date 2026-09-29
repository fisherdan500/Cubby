import { handleError } from "@/server/http";
import { openAttachment } from "@/server/services/attachments";

export const dynamic = "force-dynamic";

const ATTACHMENT_ID = /^[a-z0-9]{20,40}$/;

// Served through this endpoint only, rechecked on every request, and never sniffed, framed as a page or
// run as script (DEC-PROD-144).
//
// `no-cache` does not mean "do not cache" - it means "do not reuse without asking". The browser may keep a
// copy, but every view still arrives here and is authorized afresh, which is what DEC-PROD-144 requires.
// What it avoids is re-sending, re-reading and re-hashing bytes the caller already holds unchanged.
const privateHeaders = {
  "Cache-Control": "private, no-cache",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer"
};

// A refusal carries no validator, so there is nothing to revalidate against and it must never be kept.
const refusalHeaders = { ...privateHeaders, "Cache-Control": "private, no-store" };

function withRefusalHeaders(response: Response) {
  for (const [name, value] of Object.entries(refusalHeaders)) response.headers.set(name, value);
  return response;
}

/**
 * The versions the caller says it already holds.
 *
 * A browser may quote them, mark them weak, or send several; any one of them matching means it can reuse
 * what it has. `*` is deliberately ignored: it means "if any version exists", and for a private photo
 * identified by its own content that would answer 304 for bytes this caller may never have seen.
 */
function knownDigests(header: string | null) {
  if (!header) return [];
  return header
    .split(",")
    .map((value) => value.trim().replace(/^W\//, "").replace(/^"|"$/g, ""))
    .filter((value) => value.length > 0 && value !== "*");
}

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    if (!ATTACHMENT_ID.test(params.id)) throw new Error("not_found");
    // ?size=thumbnail asks for the small copy grids use; anything else is the photo itself.
    const thumbnail = new URL(request.url).searchParams.get("size") === "thumbnail";
    const known = knownDigests(request.headers.get("if-none-match"));
    const { bytes, mimeType, digest, notModified } = thumbnail
      ? await openAttachment(params.id, { size: "thumbnail", knownDigests: known })
      : await openAttachment(params.id, { knownDigests: known });

    // Nothing to send, but the validator and the caching rule must travel so the browser keeps asking.
    if (notModified || !bytes) {
      return new Response(null, { status: 304, headers: { ...privateHeaders, ETag: `"${digest}"` } });
    }

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        ...privateHeaders,
        ETag: `"${digest}"`,
        "Content-Type": mimeType,
        "Content-Length": String(bytes.length),
        "Content-Disposition": 'inline; filename="photo.jpg"'
      }
    });
  } catch (error) {
    return withRefusalHeaders(handleError(error));
  }
}
