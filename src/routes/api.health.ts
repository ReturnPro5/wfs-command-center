import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const hasClientId = !!process.env.WALMART_CLIENT_ID;
        const hasClientSecret = !!process.env.WALMART_CLIENT_SECRET;
        const hasBaseUrl = !!process.env.WALMART_API_BASE_URL;

        return Response.json({
          ok: hasClientId && hasClientSecret,
          env: {
            WALMART_CLIENT_ID: hasClientId ? "set" : "missing",
            WALMART_CLIENT_SECRET: hasClientSecret ? "set" : "missing",
            WALMART_API_BASE_URL: hasBaseUrl ? process.env.WALMART_API_BASE_URL : "missing (using default)",
          },
        });
      },
    },
  },
});
