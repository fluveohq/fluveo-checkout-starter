// fluveo.mjs: one call to the Fluveo API over plain HTTP, with the secret key. Server only: never import it in a page.
const API = (process.env.FLUVEO_API_BASE || "https://api.stagfluveo.com") + "/v1";

// fluveo("POST", "/payment_intents", { amount: "2000", currency: "usd" }, "order-1042-pay") resolves { status, body }.
// Build the Idempotency-Key of a POST from your own id: a retry then returns the same object and never makes a second.
export async function fluveo(method, path, params = {}, idempotencyKey) {
  if (method === "POST" && !idempotencyKey) throw new Error("fluveo(): a POST needs an Idempotency-Key");
  const form = new URLSearchParams(params);
  const response = await fetch(API + path + (method === "GET" && form.size ? "?" + form : ""), {
    method,
    headers: {
      Authorization: "Bearer " + process.env.FLUVEO_SECRET_KEY,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: method === "POST" ? form : undefined,
  });
  return { status: response.status, body: await response.json() };
}
