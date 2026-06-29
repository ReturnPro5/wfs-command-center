// TEMPORARY: dump live Walmart OMNI_WFS spec for diffing against our payload.
// Delete after the spec audit is complete.
// Usage: GET /api/public/wfs-spec-dump?productTypes=Cell+Phones,Headphones&feedType=OMNI_WFS&version=5.0...
import { createFileRoute } from "@tanstack/react-router";
import { getFeedSpec, OMNI_SPEC_VERSION } from "@/services/walmartApi";

export const Route = createFileRoute("/api/public/wfs-spec-dump")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const productTypesParam = url.searchParams.get("productTypes") ?? "";
        const productTypes = productTypesParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const feedType = url.searchParams.get("feedType") ?? "OMNI_WFS";
        const version = url.searchParams.get("version") ?? OMNI_SPEC_VERSION;
        try {
          const spec = await getFeedSpec(feedType, productTypes, version);
          return Response.json({ ok: true, feedType, version, productTypes, spec });
        } catch (err) {
          return Response.json(
            {
              ok: false,
              feedType,
              version,
              productTypes,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 502 }
          );
        }
      },
    },
  },
});
