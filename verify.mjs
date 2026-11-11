// verify.mjs: npm run verify. It starts this app, pays it as a buyer does in a real browser, and reads every result
// back from the Fluveo API with the secret key. A step that cannot prove its result fails, and the run exits 1.
// It reads .env, and the environment wins over it: FLUVEO_PUBLISHABLE_KEY and FLUVEO_SECRET_KEY (test keys), and
// optionally FLUVEO_WEBHOOK_SECRET, FLUVEO_API_BASE, FLUVEO_JS_ORIGIN and VERIFY_CHROME (a Chrome to use, by its path).
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

try {
  process.loadEnvFile(new URL(".env", import.meta.url));
} catch {}
const env = process.env;
const JS_ORIGIN = env.FLUVEO_JS_ORIGIN || "https://js.stagfluveo.com";
const WEBHOOK_SECRET = env.FLUVEO_WEBHOOK_SECRET || "whsec_" + randomBytes(24).toString("hex");

const CARDS = { pays: "4242 4242 4242 4242", declines: "4000 0000 0000 0002", authenticates: "4000 0027 6000 3184" };
const FORM = 'iframe[title="Fluveo payment form"]';
const SLOTS = ["#card-number", "#card-expiry", "#card-cvc"];
const COMPLETE = 'button:has-text("Complete"), input[type=submit][value*="omplete"]';
const CHECKING = "Checking your payment…";
const SECRETS = /\b(sk|rk)_(test|live)_|whsec_/;
const OWN_FIELD = /<(input|select|textarea)\b/i;
const PAY_CAP_MS = 90_000;
const AUTHENTICATE_CAP_MS = 150_000;

function stop(why) {
  console.error("verify: " + why);
  process.exit(2);
}
if (!env.FLUVEO_PUBLISHABLE_KEY?.startsWith("pk_test_") || !env.FLUVEO_SECRET_KEY?.startsWith("sk_test_")) {
  stop("set FLUVEO_PUBLISHABLE_KEY (pk_test_...) and FLUVEO_SECRET_KEY (sk_test_...) in .env or in the environment. It runs with test keys only.");
}
const { fluveo } = await import("./fluveo.mjs");
const { chromium } = await import("playwright").catch(() =>
  stop("Playwright is not installed. Run: npm install && npx playwright install chromium"),
);

const fail = (why) => {
  throw new Error(why);
};
// until(): the first truthy answer of check, asked every everyMs; it fails naming what it waited for.
async function until(capMs, what, check, everyMs = 250) {
  const end = Date.now() + capMs;
  for (;;) {
    const got = await check();
    if (got) return got;
    if (Date.now() > end) fail("waited " + capMs / 1000 + " s for " + (typeof what === "function" ? what() : what));
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const SHOP = "http://127.0.0.1:" + (await freePort());
const serverLog = [];
let serverErrors = "";
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: { ...env, PORT: new URL(SHOP).port, FLUVEO_WEBHOOK_SECRET: WEBHOOK_SECRET },
  stdio: ["ignore", "pipe", "pipe"],
});
let pending = "";
server.stdout.on("data", (chunk) => {
  const lines = (pending + chunk).split("\n");
  pending = lines.pop();
  serverLog.push(...lines);
});
server.stderr.on("data", (chunk) => {
  serverErrors = (serverErrors + chunk).slice(-600);
});
const serverClosed = new Promise((resolve) => server.once("close", resolve));
process.on("exit", () => server.kill());
const lastServerError = () => (serverErrors.trim() ? "; the server says: " + serverErrors.trim().split("\n").pop() : "");

// read(): the PaymentIntent as the secret key reads it.
async function read(pi) {
  const { status, body } = await fluveo("GET", "/payment_intents/" + pi);
  if (status !== 200) fail("GET /payment_intents/" + pi + " answered " + status + " " + (body.error?.code ?? ""));
  return body;
}

let browser = null;
let page = null;
const created = []; // the PaymentIntents the open checkout page asked its server for
let leftShop = false; // the open checkout went to another site, as an authentication does
async function open() {
  browser = await chromium.launch({ executablePath: env.VERIFY_CHROME || undefined });
  page = await browser.newPage();
  page.on("response", async (response) => {
    if (response.request().method() !== "POST" || response.url() !== SHOP + "/create-payment-intent") return;
    const body = await response.json().catch(() => ({}));
    created.push(String(body.clientSecret ?? "").split("_secret_")[0]);
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && /^https?:/.test(frame.url()) && !frame.url().startsWith(SHOP + "/")) leftShop = true;
  });
}

// cardInputs(): the number, expiry and security code inputs of the payment form, once the form shows them. Each is
// a frame of its own inside the form's frame; a form that draws plain inputs is read the same way.
async function cardInputs() {
  const form = page.frameLocator(FORM);
  const inputs = [];
  for (const slot of SLOTS) {
    const field = form.locator(slot + " iframe, " + slot + " input").first();
    await field.waitFor({ state: "attached", timeout: 45_000 }).catch(async () => {
      const said = await form.locator("#unavailable:visible").innerText({ timeout: 1000 }).catch(() => "");
      fail("the payment form shows no card field in " + slot + (said.trim() ? '; it says "' + said.trim() + '"' : ""));
    });
    const framed = (await field.evaluate((node) => node.tagName)) === "IFRAME";
    inputs.push(framed ? form.frameLocator(slot + " iframe").locator("input").first() : field);
  }
  return inputs;
}

// checkout(): the checkout page, open anew, with Fluveo's form on it; resolves the PaymentIntent the page made.
async function checkout() {
  if (!page) await open();
  created.length = 0;
  await page.goto(SHOP + "/");
  leftShop = false;
  await cardInputs();
  const from = new URL((await page.locator(FORM).getAttribute("src")) ?? "", SHOP).origin;
  if (from !== JS_ORIGIN) fail("the payment form is a frame of " + from + ", wanted " + JS_ORIGIN);
  const pi = await until(10_000, "the page's POST /create-payment-intent to answer", async () => created[0]);
  if (!/^pi_[A-Za-z0-9]+$/.test(pi)) fail("POST /create-payment-intent gave the page no client secret of a PaymentIntent");
  return pi;
}

async function pay(number) {
  const values = [number, "12 / 34", "123"];
  for (const [index, input] of (await cardInputs()).entries()) {
    await input.click();
    await input.press("ControlOrMeta+a");
    await input.press("Backspace");
    await input.pressSequentially(values[index], { delay: 20 });
  }
  await page.locator("#error-message").evaluate((line) => {
    line.textContent = "";
  });
  await page.getByRole("button", { name: "Pay" }).click();
}

// outcome(): how a press of Pay ended: { landed: the return page's query } or { stayed: the page's error line }.
function outcome(capMs, what, meanwhile = async () => {}) {
  return until(capMs, what, async () => {
    const url = page.url();
    if (url.startsWith(SHOP + "/complete?")) return { landed: new URL(url).searchParams };
    if (url === SHOP + "/") {
      const said = (await page.locator("#error-message").innerText({ timeout: 1000 }).catch(() => "")).trim();
      if (said) return { stayed: said };
    }
    await meanwhile();
    return null;
  });
}

// paid(): the buyer is on the return page of this PaymentIntent, the page says succeeded, and so does the API.
async function paid(end, pi) {
  if (end.stayed) fail('the page stayed and says "' + end.stayed + '"');
  const query = end.landed;
  if (query.get("payment_intent") !== pi || !query.get("payment_intent_client_secret")?.startsWith(pi + "_secret_")) {
    fail("the return page is of " + (query.get("payment_intent") || "no PaymentIntent") + ", the checkout page made " + pi);
  }
  if (query.get("redirect_status") !== "succeeded") fail("redirect_status is " + query.get("redirect_status") + ", wanted succeeded");
  const shown = await until(45_000, "the return page to say how the payment ended", async () => {
    const text = (await page.locator("#status").innerText({ timeout: 1000 }).catch(() => "")).trim();
    return text && text !== CHECKING ? text : null;
  });
  if (shown !== "succeeded") fail('the return page says "' + shown + '", wanted succeeded');
  const intent = await read(pi);
  if (intent.status !== "succeeded" || intent.amount !== 2000 || intent.currency !== "usd") {
    fail("the API reads " + pi + " as " + intent.status + " " + intent.amount + " " + intent.currency + ", wanted succeeded 2000 usd");
  }
  return pi + " succeeded 2000 usd; the return page says succeeded";
}

// pressComplete(): the Complete button of the test authentication page, in whichever frame shows it, pressed once
// and only while the API reads the PaymentIntent as waiting for the buyer.
function pressComplete(pi) {
  const seen = { pressed: false };
  seen.press = async () => {
    if (seen.pressed) return;
    for (const frame of page.frames()) {
      const button = frame.locator(COMPLETE).first();
      if (!(await button.isVisible().catch(() => false)) || !(await button.isEnabled().catch(() => false))) continue;
      const intent = await read(pi);
      if (intent.status !== "requires_action" || intent.next_action?.type !== "redirect_to_url") {
        fail("a Complete button is on the page but the API reads " + pi + " as " + intent.status + ", wanted requires_action with redirect_to_url");
      }
      seen.pressed = await button.click({ timeout: 5000 }).then(() => true, () => false);
      return;
    }
  };
  return seen;
}

const proved = {};
const STEPS = [
  {
    name: "serves",
    async run() {
      for (const path of ["/", "/complete"]) {
        const answer = await until(20_000, () => "this app's server on " + SHOP + lastServerError(), () => {
          if (server.exitCode !== null) fail("this app's server stopped" + lastServerError());
          return fetch(SHOP + path).catch(() => null);
        });
        const html = await answer.text();
        if (answer.status !== 200) fail("GET " + path + " answered " + answer.status);
        if (!html.includes('<script src="' + JS_ORIGIN + '/v1/"></script>')) fail("GET " + path + " does not load " + JS_ORIGIN + "/v1/ with a script tag");
        if (!html.includes('Fluveo("' + env.FLUVEO_PUBLISHABLE_KEY + '")')) fail("GET " + path + " does not hold the publishable key");
        if (SECRETS.test(html)) fail("GET " + path + " holds a secret key or a webhook secret");
        if (OWN_FIELD.test(html)) fail("GET " + path + " has a form field of its own; the only fields are Fluveo's");
      }
      const made = await fetch(SHOP + "/create-payment-intent", { method: "POST" });
      const body = await made.json();
      if (made.status !== 200 || Object.keys(body).join() !== "clientSecret" || !/^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/.test(body.clientSecret)) {
        fail("POST /create-payment-intent answered " + made.status + " with the keys " + Object.keys(body).join() + ", wanted 200 { clientSecret }" + lastServerError());
      }
      return "the two pages hold the publishable key, no secret and no field of their own; POST /create-payment-intent answers { clientSecret }";
    },
  },
  {
    name: "pays-4242",
    needs: ["serves"],
    async run() {
      const pi = await checkout();
      await pay(CARDS.pays);
      const evidence = await paid(await outcome(PAY_CAP_MS, "the return page after Pay with " + CARDS.pays), pi);
      if (leftShop) fail(CARDS.pays + " took the buyer to another site, wanted no authentication");
      proved.paid = pi;
      return evidence;
    },
  },
  {
    name: "declines",
    needs: ["serves"],
    async run() {
      const pi = await checkout();
      await pay(CARDS.declines);
      const end = await outcome(PAY_CAP_MS, "the page to show the decline of " + CARDS.declines);
      if (end.landed) fail("the declined card left the checkout for the return page");
      const intent = await read(pi);
      const error = intent.last_payment_error;
      if (intent.status !== "requires_payment_method" || error?.code !== "card_declined") {
        fail(
          'the page says "' + end.stayed + '", but the API reads ' + pi + " as " + intent.status + " with last_payment_error " +
            (error?.code ?? "none") + ", wanted requires_payment_method with card_declined. A message of the form itself is no decline",
        );
      }
      proved.declined = pi;
      return pi + " card_declined " + error.decline_code + '; the page stayed and says "' + end.stayed + '"';
    },
  },
  {
    name: "pays-same",
    needs: ["declines"],
    async run() {
      if (page.url() !== SHOP + "/") fail("the checkout page of the decline is gone");
      await pay(CARDS.pays);
      const evidence = await paid(await outcome(PAY_CAP_MS, "the return page after the retry with " + CARDS.pays), proved.declined);
      if (created.length !== 1) fail("the page asked its server for " + created.length + " PaymentIntents, wanted the one it retried");
      return evidence + "; the same PaymentIntent the decline was on, from one POST /create-payment-intent";
    },
  },
  {
    name: "3d-secure",
    needs: ["serves"],
    async run() {
      const pi = await checkout();
      await pay(CARDS.authenticates);
      const complete = pressComplete(pi);
      const end = await outcome(AUTHENTICATE_CAP_MS, "Complete on the test authentication page, then the return page", complete.press);
      const evidence = await paid(end, pi);
      if (!complete.pressed) fail(pi + " ended succeeded with no authentication: no page with a Complete button came up");
      return evidence + "; after Complete on the test authentication page, while the API read requires_action";
    },
  },
  {
    name: "webhook",
    needs: ["pays-4242"],
    async run() {
      const pi = proved.paid;
      if (serverLog.some((line) => line.startsWith("order paid"))) fail("the server marked an order paid before a webhook reached it");
      const event = await until(
        60_000,
        "a payment_intent.succeeded event of " + pi + " in GET /events",
        async () => {
          const { status, body } = await fluveo("GET", "/events", { type: "payment_intent.succeeded", limit: "100" });
          if (status !== 200) fail("GET /events answered " + status + " " + (body.error?.code ?? ""));
          return body.data.find((one) => one.data.object.id === pi);
        },
        2000,
      );
      const order = event.data.object.metadata?.order_id;
      if (!order) fail("the PaymentIntent of " + event.id + " has no metadata.order_id");
      const body = JSON.stringify(event);
      const deliver = async (sent) => {
        const t = Math.floor(Date.now() / 1000);
        const v1 = createHmac("sha256", WEBHOOK_SECRET).update(t + "." + body).digest("hex");
        const answer = await fetch(SHOP + "/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Fluveo-Signature": "t=" + t + ",v1=" + v1 },
          body: sent,
        });
        return answer.status;
      };
      const statuses = [await deliver(body), await deliver(body), await deliver(body.replace("succeeded", "changed"))];
      if (statuses.join() !== "200,200,400") {
        fail("POST /webhook answered " + statuses.join() + " to the signed event, the same event again and a changed body, wanted 200,200,400");
      }
      server.kill();
      await serverClosed;
      const line = "order paid " + order + " " + pi + " " + event.id;
      const marks = serverLog.filter((one) => one.startsWith("order paid"));
      if (marks.join("\n") !== line) {
        fail('the server printed "order paid" ' + marks.length + " times after two deliveries of " + event.id + ", wanted once: " + line);
      }
      return event.id + " signed 200, again 200, changed body 400; the server printed once: " + line;
    },
  },
];

const passed = new Set();
for (const step of STEPS) {
  const missing = (step.needs ?? []).filter((name) => !passed.has(name));
  let evidence = "";
  let why = missing.length ? "not run: it needs " + missing.join(", ") : "";
  if (!why) {
    try {
      evidence = await step.run();
      if (!evidence) why = "the step proved nothing";
    } catch (error) {
      why = String(error.message).split("\n")[0];
      if (page && step.name !== "webhook") {
        const shot = join(tmpdir(), "verify-failed-" + step.name + ".png");
        if (await page.screenshot({ path: shot, fullPage: true }).then(() => true, () => false)) why += " (screenshot: " + shot + ")";
      }
    }
  }
  if (!why) passed.add(step.name);
  console.log((why ? "FAIL " : "PASS ") + step.name.padEnd(14) + (why || evidence));
}
if (browser) await browser.close();
console.log("verify: " + passed.size + " of " + STEPS.length + " passed");
process.exit(passed.size === STEPS.length ? 0 : 1);
