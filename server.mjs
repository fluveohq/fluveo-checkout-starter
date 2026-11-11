// server.mjs: the shop's server. npm start runs it with .env loaded.
import express from "express";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fluveo } from "./fluveo.mjs";
import { handleWebhook } from "./webhook.mjs";

const PAGES = { "/": "checkout.html", "/complete": "complete.html" };
// The pages load fluveo.js from this origin. FLUVEO_JS_ORIGIN names another Fluveo environment, never a copy of the script.
const JS_ORIGIN = "https://js.stagfluveo.com";

// This server writes FLUVEO_PUBLISHABLE_KEY into the pages, so it refuses anything that is not a publishable key there.
if (!process.env.FLUVEO_PUBLISHABLE_KEY?.startsWith("pk_") || !process.env.FLUVEO_SECRET_KEY) {
  console.error("Set FLUVEO_PUBLISHABLE_KEY (pk_test_...) and FLUVEO_SECRET_KEY (sk_test_...) in .env. Copy .env.example to start.");
  process.exit(1);
}

const app = express();

app.post("/create-payment-intent", async (req, res) => {
  const orderId = randomUUID(); // in your shop: the order's own id, so a retry never makes a second payment
  const { status, body: paymentIntent } = await fluveo(
    "POST",
    "/payment_intents",
    { amount: "2000", currency: "usd", "metadata[order_id]": orderId },
    "order-" + orderId + "-pay",
  );
  if (status !== 200) console.error("Fluveo answered", status, paymentIntent.error?.message);
  res.status(status).json({ clientSecret: paymentIntent.client_secret });
});

// The signature is over the exact bytes Fluveo sent, so this route takes the raw body and no JSON parser runs first.
app.post("/webhook", express.raw({ type: "application/json" }), handleWebhook);

for (const [path, file] of Object.entries(PAGES)) {
  app.get(path, async (req, res) => {
    const page = await readFile(new URL(file, import.meta.url), "utf8");
    const html = page
      .replace(JS_ORIGIN, process.env.FLUVEO_JS_ORIGIN || JS_ORIGIN)
      .replace("FLUVEO_PUBLISHABLE_KEY", process.env.FLUVEO_PUBLISHABLE_KEY);
    res.type("html").send(html);
  });
}

app.listen(process.env.PORT || 4242);
