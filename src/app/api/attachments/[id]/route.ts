import { handleError } from "@/server/http";
import { openAttachment } from "@/server/services/attachments";

export const dynamic = "force-dynamic";

const ATTACHMENT_ID = /^[a-z0-9]{20,40}$/;

// Served through this endpoint only, rechecked on every request, and never cached, sniffed, framed
// as a page or run as script (DEC-PROD-144).
const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer"
};

function withPrivateHeaders(response: Response) {
  for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
  return response;
}

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    if (!ATTACHMENT_ID.test(params.id)) throw new Error("not_found");
    const { bytes, mimeType } = await openAttachment(params.id);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        ...privateHeaders,
        "Content-Type": mimeType,
        "Content-Length": String(bytes.length),
        "Content-Disposition": 'inline; filename="photo.jpg"'
      }
    });
  } catch (error) {
    return withPrivateHeaders(handleError(error));
  }
}
