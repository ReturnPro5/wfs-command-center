import { createFileRoute } from "@tanstack/react-router";
import { getWalmartAccessToken } from "@/services/walmartAuth";
import * as walmartApi from "@/services/walmartApi";

export const Route = createFileRoute("/api/debug-orders")({
  server: {
    handlers: {
      GET: async () => {
        try {
          await getWalmartAccessToken();
          const startDate = new Date(new Date().getFullYear(), 0, 1).toISOString();
          const raw = await walmartApi.getOrders({ createdStartDate: startDate });
          const page = (raw as any)?.payload ?? raw;
          const orderList = page?.list?.elements?.order ?? page?.orders ?? page?.elements ?? [];

          const samples = orderList.slice(0, 5).map((o: any, i: number) => ({
            index: i,
            orderDate: o.orderDate,
            orderDateType: typeof o.orderDate,
            createdDate: o.createdDate,
            orderDateTime: o.orderDateTime,
            keys: Object.keys(o),
            lineCount: (o.orderLines?.orderLine ?? o.lines ?? []).length,
            // Sample first line's charges
            firstLineCharges: (o.orderLines?.orderLine ?? o.lines ?? [])[0]?.charges,
            firstLineFulfillment: (o.orderLines?.orderLine ?? o.lines ?? [])[0]?.fulfillment,
          }));

          return Response.json({
            totalOrdersOnPage: orderList.length,
            nextCursor: page?.list?.meta?.nextCursor ?? page?.nextCursor,
            samples,
          });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      },
    },
  },
});
