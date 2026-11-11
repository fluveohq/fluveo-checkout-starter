// webhook.mjs: checks Fluveo-Signature on the raw body, then marks the order paid, once per event
import { createHmac, timingSafeEqual } from "node:crypto";

export const paidOrders = new Map(); // order id -> event id; in your shop: your orders table
const seenEvents = new Set(); // in your shop: a table with a unique key on the event id

function verified(rawBody, header, secret, now = Math.floor(Date.now() / 1000)) {
  const parts = String(header || "").split(",").map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1] ?? "";
  if (!secret || !/^\d{1,12}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret).update(timestamp + ".").update(rawBody).digest();
  return parts.some(
    ([key, value]) => key === "v1" && /^[0-9a-f]{64}$/.test(value ?? "") && timingSafeEqual(Buffer.from(value, "hex"), expected),
  );
}

// server.mjs mounts this after express.raw(), so req.body is the bytes Fluveo signed.
export function handleWebhook(req, res) {
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody) || !verified(rawBody, req.get("Fluveo-Signature"), process.env.FLUVEO_WEBHOOK_SECRET)) {
    return res.sendStatus(400);
  }
  const event = JSON.parse(rawBody.toString("utf8"));
  if (!seenEvents.has(event.id)) {
    seenEvents.add(event.id);
    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object;
      paidOrders.set(paymentIntent.metadata.order_id, event.id);
      console.log("order paid", paymentIntent.metadata.order_id, paymentIntent.id, event.id);
    }
  }
  res.sendStatus(200);
}
