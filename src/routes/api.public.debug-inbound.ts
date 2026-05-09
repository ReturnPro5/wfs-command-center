import { createFileRoute } from "@tanstack/react-router";
import * as walmartApi from "@/services/walmartApi";

export const Route = createFileRoute("/api/public/debug-inbound")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const raw = await walmartApi.getInboundShipments();
          const topKeys = Object.keys(raw ?? {});
          const payload = (raw as any)?.payload ?? raw;
          const payloadKeys = Object.keys(payload ?? {});
          const candidates = ["shipments", "inboundShipments", "elements", "data", "results"];
          const found: Record<string, any> = {};
          for (const k of candidates) {
            const v = payload?.[k] ?? (raw as any)?.[k];
            if (v) {
              found[k] = {
                isArray: Array.isArray(v),
                len: Array.isArray(v) ? v.length : undefined,
                firstKeys: Array.isArray(v) && v[0] ? Object.keys(v[0]) : Object.keys(v),
              };
            }
          }
          const sample =
            payload?.shipments?.[0] ??
            payload?.inboundShipments?.[0] ??
            payload?.elements?.[0] ??
            (raw as any)?.shipments?.[0] ??
            null;
          return Response.json({ topKeys, payloadKeys, found, sample, rawPreview: JSON.stringify(raw).slice(0, 2000) });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      },
    },
  },
});
