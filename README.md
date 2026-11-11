# Fluveo checkout starter: plain HTML and Express

A checkout page of your own with Fluveo's payment form in it. The page, the Pay button and the server are yours. The
card form is Fluveo's: `fluveo.js` puts it on the page in a frame, so the card number, the expiration date and the
security code never reach your page or your server.

It is the app of the [Custom checkout](https://docs.stagfluveo.com/payments/custom-checkout) guide, with the same
routes and the same names, on Express.

## What is in it

| File | What it does |
| --- | --- |
| `checkout.html` | The checkout page. It loads `fluveo.js`, mounts the payment form and confirms the payment. |
| `complete.html` | The return page. It tells the buyer how the payment ended. It never marks the order paid. |
| `server.mjs` | The Express server: the two pages, `POST /create-payment-intent` and `POST /webhook`. |
| `fluveo.mjs` | One function that calls the Fluveo API over plain HTTP with the secret key. No SDK. |
| `webhook.mjs` | Checks `Fluveo-Signature` on the raw body, then marks the order paid, once per event. |
| `verify.mjs` | `npm run verify`: pays the app in a real browser and checks every result. |
| `AGENTS.md` | The rules an AI agent follows when it changes this app. |

## Run it

You need Node 20.12 or newer and the test keys of your store: Dashboard, **Settings**, **API keys**, in test mode.

```bash
npm install
cp .env.example .env    # then put your pk_test_... and sk_test_... keys in .env
npm start
```

Open `http://localhost:4242` and pay with `4242 4242 4242 4242`, any future expiration date and any security code.
[Testing](https://docs.stagfluveo.com/start/testing#typed-cards) lists the cards that decline and the cards that ask
for 3D Secure.

## Verify it

```bash
npx playwright install chromium    # once
npm run verify
```

`npm run verify` starts the app on a free port, pays it as a buyer does and reads each result back from the API with
your secret key. It prints one line per step and exits 1 when a step fails.

| Step | What it proves |
| --- | --- |
| `serves` | The pages hold the publishable key, no secret and no form field of their own. |
| `pays-4242` | `4242 4242 4242 4242` lands on the return page, and the API reads the PaymentIntent as `succeeded`. |
| `declines` | `4000 0000 0000 0002` keeps the buyer on the page with a message, and the API reads `card_declined`. |
| `pays-same` | On that same page, `4242 4242 4242 4242` then pays the same PaymentIntent. |
| `3d-secure` | `4000 0027 6000 3184` opens the test authentication page, and **Complete** ends in `succeeded`. |
| `webhook` | A signed `payment_intent.succeeded` event gets `200` and marks the order paid once. The same event again gets `200` and changes nothing. A changed body gets `400`. |

## Get real webhooks

Fluveo delivers events only to a public `https` address. When your server has one,
[create an endpoint](https://docs.stagfluveo.com/webhooks#create) for its `/webhook` route with the events
`payment_intent.succeeded` and `payment_intent.payment_failed`. Put the endpoint's `whsec_...` secret in `.env` as
`FLUVEO_WEBHOOK_SECRET` and start the server again.

## Make it yours

Read [AGENTS.md](AGENTS.md) first: it has the rules that keep a checkout safe, for a person and for an AI agent.
[fluveo.js](https://docs.stagfluveo.com/payments/fluveo-js) describes every call of the script, and
[fluveo.js errors](https://docs.stagfluveo.com/payments/fluveo-js-errors) has one entry per error it throws.

## License

MIT. See [LICENSE](LICENSE).
