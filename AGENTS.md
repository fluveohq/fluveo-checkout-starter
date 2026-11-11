# Rules for AI agents

This app is a shop's own checkout page with Fluveo's payment form in it. Follow these rules when you change it. Where
they differ from what you remember of other payment APIs, these rules win.

Read first: https://docs.stagfluveo.com/llms/custom-checkout.txt (the whole task in one file).

## Never

- Never build a card input. No field for a card number, an expiration date or a security code, and no code that
  reads or sends one. `elements.create("payment")` is the only card form.
- Never put a secret in the browser. `sk_`, `rk_` and `whsec_` values stay in `.env` and in server code. A page gets
  only the publishable key (`pk_`).
- Never mark an order paid from the return page (`complete.html`) or from anything else the browser sends. Mark it
  paid only in `webhook.mjs`, on a `payment_intent.succeeded` event whose `Fluveo-Signature` passed the check.
- Never copy `fluveo.js` into the app, and never load it from a package or from another host. A script tag loads it
  from `https://js.stagfluveo.com/v1/`.
- Never install a payments SDK, on the server or in the browser. The server calls the API over plain HTTP through
  `fluveo.mjs`.
- Never write a key in a file that git tracks. Keys come from `.env`, and `.env` stays out of git.

## Always

- Create the PaymentIntent on the server, in `POST /create-payment-intent`, and give the page only its
  `client_secret`.
- Take the amount from the order on the server, never from the browser.
- Send an `Idempotency-Key` on every POST to the API, built from your own id, such as the order id. A retry then
  never pays twice.
- Check the webhook signature on the raw body, before any JSON parser runs, and skip an event id you already handled.
- Keep `return_url` on `confirmPayment()`. 3D Secure leaves the page and comes back to that address.
- When `fluveo.js` throws, read the error's `doc_url` and do what that page says.
- After every change, run `npm run verify`. Every line must start with `PASS`. Report the lines, with the ids they
  print.

## Where things are

| To change | Edit |
| --- | --- |
| The look of the checkout, the cart, the Pay button | `checkout.html` |
| What the buyer reads after paying | `complete.html` |
| The amount, the currency, the order behind a payment | `server.mjs`, in `POST /create-payment-intent` |
| What happens when an order is paid | `webhook.mjs`, where it sets `paidOrders` |
| A new call to the Fluveo API | `fluveo.mjs`, through `fluveo(method, path, params, idempotencyKey)` |
