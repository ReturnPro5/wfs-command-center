// TEMPORARY: dump live Walmart OMNI_WFS spec for diffing against our payload.
// Delete after the spec audit is complete.
import { createFileRoute } from "@tanstack/react-router";
import { getFeedSpec } from "@/services/walmartApi";

export const Route = createFileRoute("/api/public/wfs-spec-dump")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const productType = url.searchParams.get("productType") ?? undefined;
        try {
          const spec = await getFeedSpec("OMNI_WFS", productType);
          return Response.json({ ok: true, productType: productType ?? null, spec });
        } catch (err) {
          return Response.json(
            { ok: false, productType: productType ?? null, error: err instanceof Error ? err.message : String(err) },
            { status: 502 }
          );
        }
      },
    },
  },
});
