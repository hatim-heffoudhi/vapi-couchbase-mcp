import { randomInt, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { CATALOG } from "./catalog.js";
import { demoInbox, maskEmail, sendMail } from "./mail.js";
import { supportCallConfig } from "./vapi-web.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv({ path: path.join(root, ".env") });

const CB_HOST = process.env.CB_HOST || "127.0.0.1";
const CB_USERNAME = process.env.CB_USERNAME || "Administrator";
const CB_PASSWORD = process.env.CB_PASSWORD || "";
const PORT = Number(process.env.PORT || "4000");
const UI_DIR = path.join(root, "ui");
const BUCKET = process.env.CB_BUCKET || "order-demo";
const SCOPE = process.env.CB_SCOPE || "_default";
const CHANGES = `\`${BUCKET}\`.\`${SCOPE}\`.\`delivery_changes\``;
const ORDERS = `\`${BUCKET}\`.\`${SCOPE}\`.\`orders\``;
const OTPS = `\`${BUCKET}\`.\`${SCOPE}\`.\`order_otps\``;
const PRODUCTS = `\`${BUCKET}\`.\`${SCOPE}\`.\`products\``;

type Order = {
  doc_id: string;
  order_id: string;
  status: string;
  estimated_delivery: string;
  customer?: string;
  customer_email?: string;
  items?: unknown;
  total?: number;
  created_at?: string;
};

type ChangeRequest = {
  request_id: string;
  order_id: string;
  order_doc_id: string;
  kind?: "delivery" | "cancel";
  current_delivery: string;
  requested_delivery: string;
  customer?: string;
  customer_email?: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  reviewed_at?: string;
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, body: string) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function n1ql(statement: string, namedArgs?: Record<string, unknown>) {
  const res = await fetch(`http://${CB_HOST}:8093/query/service`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${CB_USERNAME}:${CB_PASSWORD}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      statement,
      timeout: "10s",
      ...Object.fromEntries(
        Object.entries(namedArgs ?? {}).map(([key, value]) => [`$${key}`, value]),
      ),
    }),
  });
  const data = (await res.json()) as {
    status?: string;
    results?: Array<Record<string, unknown>>;
    errors?: Array<{ msg?: string }>;
  };
  if (!res.ok || (data.status && data.status !== "success")) {
    throw new Error(data.errors?.map((e) => e.msg).join("; ") || `Query failed (${res.status})`);
  }
  return data.results ?? [];
}

async function ensureCollection() {
  const mgmt = `http://${CB_HOST}:8091`;
  const auth = `Basic ${Buffer.from(`${CB_USERNAME}:${CB_PASSWORD}`).toString("base64")}`;
  await fetch(`${mgmt}/pools/default/buckets`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: `name=${encodeURIComponent(BUCKET)}&bucketType=couchbase&ramQuotaMB=256&flushEnabled=1`,
  });
  for (const name of ["orders", "delivery_changes", "order_otps", "products"]) {
    await fetch(`${mgmt}/pools/default/buckets/${encodeURIComponent(BUCKET)}/scopes/${encodeURIComponent(SCOPE)}/collections`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: `name=${name}`,
    });
  }
  for (let i = 0; i < 20; i++) {
    try {
      await n1ql(`CREATE PRIMARY INDEX IF NOT EXISTS ON ${CHANGES}`);
      await n1ql(`CREATE PRIMARY INDEX IF NOT EXISTS ON ${OTPS}`);
      await n1ql(`CREATE PRIMARY INDEX IF NOT EXISTS ON ${PRODUCTS}`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  for (const product of CATALOG) {
    await n1ql(`UPSERT INTO ${PRODUCTS} (KEY, VALUE) VALUES ($key, $doc)`, {
      key: `product-${product.product_id}`,
      doc: product,
    });
  }
}

async function findOrder(orderRef: string): Promise<Order | null> {
  const ref = orderRef.trim();
  const docGuess = ref.toLowerCase().startsWith("order-")
    ? ref
    : `order-${ref.replace(/^ord-?/i, "")}`;
  const orderId = ref.toUpperCase().startsWith("ORD-")
    ? ref.toUpperCase()
    : `ORD-${ref.replace(/^order-/i, "")}`;
  const rows = await n1ql(
    `SELECT META(o).id AS doc_id, o.order_id, o.status, o.estimated_delivery, o.customer, o.customer_email, o.items, o.total, o.created_at
     FROM ${ORDERS} o
     WHERE META(o).id = $doc OR o.order_id = $oid OR o.order_id = $oid2
     LIMIT 1`,
    { doc: docGuess, oid: orderId, oid2: ref },
  );
  if (!rows[0]) return null;
  return rows[0] as Order;
}

function codesEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const OTP_CALL_KEY = "otp-call";

async function otpVerified(_orderId: string): Promise<boolean> {
  return callAlreadyVerified();
}

async function callAlreadyVerified(): Promise<boolean> {
  const rows = await n1ql(
    `SELECT RAW o.verified_until FROM ${OTPS} o WHERE o.verified_until IS NOT MISSING`,
  );
  const now = Date.now();
  return rows.some((until) => until && Date.parse(String(until)) > now);
}

async function clearCallVerification() {
  try {
    await n1ql(`UPDATE ${OTPS} o SET o.verified_until = MISSING`);
    await n1ql(`DELETE FROM ${OTPS} o USE KEYS $key`, { key: OTP_CALL_KEY });
  } catch {
    // Empty collection is fine; a new call simply is not verified yet.
  }
}

async function waitForRequest(requestId: string, ms = 8000) {
  const deadline = Date.now() + ms;
  let row = await loadRequest(requestId);
  while (row?.status === "pending" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    row = await loadRequest(requestId);
  }
  return row;
}

async function pendingCancel(orderId: string) {
  const rows = await n1ql(
    `SELECT c.request_id FROM ${CHANGES} c
     WHERE c.order_id = $oid AND c.kind = "cancel" AND c.status = "pending"
     LIMIT 1`,
    { oid: orderId },
  );
  return rows[0] as { request_id?: string } | undefined;
}

function orderEmail(order: Order): string {
  return (order.customer_email || "").trim() || demoInbox();
}

function addDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

const CANCEL_WINDOW_MS = 6 * 60 * 60 * 1000;

type OrderPolicy = {
  hours_since_order: number | null;
  within_window: boolean;
  cancel_immediate: boolean;
  cancel_needs_supervisor: boolean;
  can_change_date: boolean;
  cancel_policy: "immediate" | "supervisor" | "not_allowed";
  date_policy: "supervisor" | "not_allowed";
  cancel_summary: string;
  date_summary: string;
  cancel_reason: string;
};

function orderPolicy(order: Pick<Order, "status" | "created_at">): OrderPolicy {
  const created = Date.parse(String(order.created_at || ""));
  const ageMs = Number.isFinite(created) ? Math.max(0, Date.now() - created) : Number.POSITIVE_INFINITY;
  const hoursSinceOrder =
    Number.isFinite(ageMs) && ageMs !== Number.POSITIVE_INFINITY ? Math.round((ageMs / 36e5) * 10) / 10 : null;
  const status = (order.status || "").toLowerCase();
  const cancelled = status.includes("cancel");
  const delivered = status.includes("delivered");
  const shipped = status.includes("shipped");
  const withinWindow = ageMs <= CANCEL_WINDOW_MS;
  const canChangeDate = !cancelled && !delivered;

  if (cancelled) {
    return {
      hours_since_order: hoursSinceOrder,
      within_window: withinWindow,
      cancel_immediate: false,
      cancel_needs_supervisor: false,
      can_change_date: false,
      cancel_policy: "not_allowed",
      date_policy: "not_allowed",
      cancel_summary: "Already cancelled",
      date_summary: "Date cannot be changed",
      cancel_reason: "This order is already cancelled.",
    };
  }
  if (delivered) {
    return {
      hours_since_order: hoursSinceOrder,
      within_window: withinWindow,
      cancel_immediate: false,
      cancel_needs_supervisor: false,
      can_change_date: false,
      cancel_policy: "not_allowed",
      date_policy: "not_allowed",
      cancel_summary: "Cannot cancel — delivered",
      date_summary: "Date cannot be changed",
      cancel_reason: "Delivered orders cannot be cancelled.",
    };
  }
  if (shipped) {
    return {
      hours_since_order: hoursSinceOrder,
      within_window: withinWindow,
      cancel_immediate: false,
      cancel_needs_supervisor: false,
      can_change_date: true,
      cancel_policy: "not_allowed",
      date_policy: "supervisor",
      cancel_summary: "Cannot cancel — shipped",
      date_summary: "Date can be updated (supervisor)",
      cancel_reason: "Shipped orders cannot be cancelled. A supervisor can still update the delivery date.",
    };
  }
  if (withinWindow) {
    return {
      hours_since_order: hoursSinceOrder,
      within_window: true,
      cancel_immediate: true,
      cancel_needs_supervisor: false,
      can_change_date: true,
      cancel_policy: "immediate",
      date_policy: "supervisor",
      cancel_summary: "Can cancel immediately",
      date_summary: "Date can be updated (supervisor)",
      cancel_reason: "",
    };
  }
  return {
    hours_since_order: hoursSinceOrder,
    within_window: false,
    cancel_immediate: false,
    cancel_needs_supervisor: true,
    can_change_date: true,
    cancel_policy: "supervisor",
    date_policy: "supervisor",
    cancel_summary: "Cancel needs supervisor",
    date_summary: "Date can be updated (supervisor)",
    cancel_reason: "This order is older than six hours, so a supervisor must approve the cancellation.",
  };
}

function cancelWindow(order: Order) {
  const policy = orderPolicy(order);
  return {
    hours_since_order: policy.hours_since_order,
    within_window: policy.within_window,
    eligible: policy.cancel_immediate,
    needs_approval: policy.cancel_needs_supervisor,
    reason: policy.cancel_reason,
  };
}

function withPolicy<T extends Pick<Order, "status" | "created_at">>(order: T) {
  return { ...order, ...orderPolicy(order) };
}

async function nextOrderId(): Promise<{ orderId: string; docId: string }> {
  const rows = await n1ql(`SELECT RAW o.order_id FROM ${ORDERS} o`);
  let max = 1000;
  for (const id of rows) {
    const n = Number(String(id).replace(/\D/g, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  const orderId = `ORD-${max + 1}`;
  return { orderId, docId: `order-${max + 1}` };
}

async function loadRequest(requestId: string) {
  const rows = await n1ql(
    `SELECT c.request_id, c.order_id, c.kind, c.current_delivery, c.requested_delivery, c.status, c.reviewed_at
     FROM ${CHANGES} c WHERE c.request_id = $id LIMIT 1`,
    { id: requestId },
  );
  return rows[0] as
    | {
        request_id: string;
        order_id: string;
        kind?: string;
        current_delivery?: string;
        requested_delivery?: string;
        status: string;
        reviewed_at?: string;
      }
    | undefined;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname.replace(/\/$/, "") || "/";

  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }

  try {
    if (req.method === "GET" && (pathname === "/health" || pathname === "/healthz")) {
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && (pathname === "/" || pathname === "/shop" || pathname === "/customer")) {
      html(res, readFileSync(path.join(UI_DIR, "customer.html"), "utf8"));
      return;
    }

    if (req.method === "GET" && pathname === "/howto") {
      html(res, readFileSync(path.join(UI_DIR, "howto.html"), "utf8"));
      return;
    }

    if (req.method === "GET" && pathname === "/ui/call") {
      html(res, readFileSync(path.join(UI_DIR, "call.html"), "utf8"));
      return;
    }

    if (req.method === "GET" && pathname === "/ui/call.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(readFileSync(path.join(UI_DIR, "call.js"), "utf8"));
      return;
    }

    if (req.method === "GET" && pathname === "/ui/theme.css") {
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(readFileSync(path.join(UI_DIR, "theme.css"), "utf8"));
      return;
    }

    if (req.method === "GET" && pathname === "/ui/jack.jpg") {
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" });
      res.end(readFileSync(path.join(UI_DIR, "jack.jpg")));
      return;
    }

    if (req.method === "GET" && pathname === "/ui") {
      html(res, readFileSync(path.join(UI_DIR, "index.html"), "utf8"));
      return;
    }

    if (req.method === "GET" && pathname === "/api/support-call") {
      const origin = String(req.headers.origin || `http://${req.headers.host || "127.0.0.1:8080"}`);
      json(res, 200, await supportCallConfig(origin));
      return;
    }

    if (req.method === "POST" && (pathname === "/api/call/start" || pathname === "/api/call/end")) {
      await clearCallVerification();
      json(res, 200, { ok: true, verified: false });
      return;
    }

    if (req.method === "GET" && pathname === "/api/products") {
      const rows = await n1ql(
        `SELECT p.product_id, p.name, p.price, p.eta_days, p.tag, p.blurb FROM ${PRODUCTS} p`,
      );
      json(res, 200, { products: rows.length ? rows : CATALOG });
      return;
    }

    if (req.method === "GET" && pathname === "/api/orders") {
      const email = url.searchParams.get("email")?.trim() || "";
      const rows = await n1ql(
        `SELECT META(o).id AS doc_id, o.order_id, o.status, o.estimated_delivery, o.customer,
                o.customer_email, o.items, o.total, o.created_at
         FROM ${ORDERS} o
         ${email ? "WHERE LOWER(o.customer_email) = LOWER($email)" : ""}`,
        email ? { email } : undefined,
      );
      rows.sort((a, b) => String(a.order_id || "").localeCompare(String(b.order_id || "")));
      json(res, 200, { orders: rows.map((row) => withPolicy(row as Order)) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/orders") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        product_id?: string;
        quantity?: number;
        customer?: string;
        customer_email?: string;
      };
      const customer = body.customer?.trim() || "";
      const customerEmail = body.customer_email?.trim() || "";
      const quantity = Math.max(1, Math.min(9, Number(body.quantity) || 1));
      if (!body.product_id || !customer || !isEmail(customerEmail)) {
        json(res, 400, { error: "product_id, customer, and a valid customer_email are required" });
        return;
      }
      const found = await n1ql(
        `SELECT p.product_id, p.name, p.price, p.eta_days FROM ${PRODUCTS} p WHERE p.product_id = $id LIMIT 1`,
        { id: body.product_id },
      );
      const product = (found[0] as (typeof CATALOG)[number] | undefined)
        || CATALOG.find((item) => item.product_id === body.product_id);
      if (!product) {
        json(res, 404, { error: "Product not found" });
        return;
      }
      const { orderId, docId } = await nextOrderId();
      const total = Math.round(product.price * quantity * 100) / 100;
      const doc = {
        order_id: orderId,
        status: "processing",
        items: [{ name: product.name, quantity, price: product.price }],
        total,
        estimated_delivery: addDays(product.eta_days),
        customer,
        customer_email: customerEmail,
        created_at: new Date().toISOString(),
      };
      await n1ql(`INSERT INTO ${ORDERS} (KEY, VALUE) VALUES ($key, $doc)`, {
        key: docId,
        doc,
      });
      json(res, 201, withPolicy({ ...doc, doc_id: docId }));
      return;
    }

    if (req.method === "POST" && pathname === "/api/orders/cancel") {
      const body = JSON.parse((await readBody(req)) || "{}") as { order_id?: string };
      if (!body.order_id) {
        json(res, 400, { error: "order_id is required" });
        return;
      }
      const order = await findOrder(body.order_id);
      if (!order) {
        json(res, 404, { cancelled: false, error: "Order not found" });
        return;
      }
      if (!(await otpVerified(order.order_id))) {
        json(res, 403, {
          cancelled: false,
          error: "not_verified",
          message: "Verify the email code for this order before cancelling.",
        });
        return;
      }
      const window = cancelWindow(order);
      if (window.needs_approval) {
        const existing = await pendingCancel(order.order_id);
        const requestId = existing?.request_id || `cnl-${Date.now().toString(36)}`;
        if (!existing?.request_id) {
          const doc: ChangeRequest = {
            request_id: requestId,
            order_id: order.order_id,
            order_doc_id: order.doc_id,
            kind: "cancel",
            current_delivery: order.estimated_delivery,
            requested_delivery: "cancelled",
            customer: order.customer,
            customer_email: orderEmail(order),
            status: "pending",
            created_at: new Date().toISOString(),
          };
          await n1ql(`UPSERT INTO ${CHANGES} (KEY, VALUE) VALUES ($key, $doc)`, {
            key: requestId,
            doc,
          });
        }
        json(res, 200, {
          cancelled: false,
          needs_approval: true,
          request_id: requestId,
          order_id: order.order_id,
          hours_since_order: window.hours_since_order,
          message:
            "Speak this exact sentence now: This action needs approval from a supervisor. Please stay on the line. Then call check_delivery_change. Never say wait a sec.",
          spoken_reply: "This action needs approval from a supervisor. Please stay on the line.",
        });
        return;
      }
      if (!window.eligible) {
        json(res, 200, {
          cancelled: false,
          needs_approval: false,
          order_id: order.order_id,
          status: order.status,
          hours_since_order: window.hours_since_order,
          message: window.reason,
        });
        return;
      }
      const cancelledAt = new Date().toISOString();
      await n1ql(
        `UPDATE ${ORDERS} o USE KEYS $docId SET o.status = $status, o.cancelled_at = $at`,
        { docId: order.doc_id, status: "cancelled", at: cancelledAt },
      );
      const to = orderEmail(order);
      if (to) {
        try {
          await sendMail({
            to,
            subject: `Order ${order.order_id} cancelled`,
            text: `Your order ${order.order_id} has been cancelled. This was allowed because it was placed within the last six hours.`,
          });
        } catch {
          // Cancellation still succeeds if mail is down.
        }
      }
      json(res, 200, {
        cancelled: true,
        order_id: order.order_id,
        status: "cancelled",
        hours_since_order: window.hours_since_order,
        message: "Order cancelled. Confirm it to the caller. The shop will show cancelled.",
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/requests") {
      const rows = await n1ql(
        `SELECT c.request_id, c.order_id, c.order_doc_id, c.kind, c.current_delivery, c.requested_delivery,
                c.customer, c.status, c.created_at, c.reviewed_at
         FROM ${CHANGES} c
         ORDER BY c.created_at DESC`,
      );
      json(res, 200, { requests: rows });
      return;
    }

    if (req.method === "GET" && pathname === "/api/otp") {
      const rows = await n1ql(
        `SELECT o.order_id, o.code, o.expires_at FROM ${OTPS} o WHERE o.code IS NOT MISSING`,
      );
      const now = Date.now();
      json(res, 200, {
        codes: rows.filter((row) => Date.parse(String(row.expires_at ?? "")) > now),
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/otp/send") {
      const body = JSON.parse((await readBody(req)) || "{}") as { order_id?: string };
      if (!body.order_id) {
        json(res, 400, { error: "order_id is required" });
        return;
      }
      if (await callAlreadyVerified()) {
        json(res, 200, {
          sent: false,
          already_verified: true,
          order_id: body.order_id,
          message:
            "Already verified on this live call only. Do not send or ask for a code. A new call later must verify again.",
        });
        return;
      }
      const order = await findOrder(body.order_id);
      if (!order) {
        json(res, 404, { error: "Order not found" });
        return;
      }
      const code = String(randomInt(100000, 1000000));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await n1ql(`UPSERT INTO ${OTPS} (KEY, VALUE) VALUES ($key, $doc)`, {
        key: `otp-${order.order_id}`,
        doc: {
          order_id: order.order_id,
          code,
          expires_at: expiresAt,
          verified_until: null,
          show_on_ui: true,
        },
      });
      const to = orderEmail(order);
      let mailed: Awaited<ReturnType<typeof sendMail>>;
      try {
        mailed = to
          ? await sendMail({
              to,
              subject: `Your order verification code for ${order.order_id}`,
              text: `Your verification code is ${code}. It expires in 10 minutes. If you did not call order support, ignore this email.`,
            })
          : { ok: false as const, reason: "No recipient" };
      } catch (err) {
        mailed = { ok: false, reason: err instanceof Error ? err.message : "send failed" };
      }
      json(res, 200, {
        sent: true,
        order_id: order.order_id,
        emailed: mailed.ok,
        email_hint: to ? maskEmail(to) : "the supervisor screen",
        message: mailed.ok
          ? `Code emailed to ${maskEmail(to)}. Ask the caller to read the six-digit code. Never speak the code yourself.`
          : "Email is not available. Tell the caller the six-digit code is on the supervisor approval screen. Never speak the code yourself.",
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/otp/verify") {
      const body = JSON.parse((await readBody(req)) || "{}") as { order_id?: string; code?: string };
      if (!body.order_id || !body.code) {
        json(res, 400, { error: "order_id and code are required" });
        return;
      }
      const order = await findOrder(body.order_id);
      if (!order) {
        json(res, 404, { error: "Order not found" });
        return;
      }
      const rows = await n1ql(`SELECT o.code, o.expires_at FROM ${OTPS} o USE KEYS $key`, {
        key: `otp-${order.order_id}`,
      });
      const stored = rows[0] as { code?: string; expires_at?: string } | undefined;
      const given = body.code.replace(/\D/g, "");
      if (
        !stored?.code ||
        !stored.expires_at ||
        Date.parse(stored.expires_at) < Date.now() ||
        !codesEqual(stored.code, given)
      ) {
        json(res, 200, {
          verified: false,
          order_id: order.order_id,
          message: "That code is incorrect or expired. Ask them to try again.",
        });
        return;
      }
      const verifiedUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      await n1ql(
        `UPDATE ${OTPS} o USE KEYS $key SET o.verified_until = $until, o.code = MISSING`,
        { key: `otp-${order.order_id}`, until: verifiedUntil },
      );
      await n1ql(`UPSERT INTO ${OTPS} (KEY, VALUE) VALUES ($key, $doc)`, {
        key: OTP_CALL_KEY,
        doc: { verified_until: verifiedUntil, order_id: order.order_id },
      });
      json(res, 200, {
        verified: true,
        order_id: order.order_id,
        message:
          "Caller is verified for the rest of this live call only, including new shop orders. Never ask for another code until they hang up.",
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/requests") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        order_id?: string;
        requested_delivery?: string;
      };
      if (!body.order_id || !body.requested_delivery) {
        json(res, 400, { error: "order_id and requested_delivery are required" });
        return;
      }
      const order = await findOrder(body.order_id);
      if (!order) {
        json(res, 404, { error: "Order not found", order_id: body.order_id });
        return;
      }
      const policy = orderPolicy(order);
      if (!policy.can_change_date) {
        json(res, 409, {
          error: "date_locked",
          message: policy.date_summary + (policy.cancel_reason ? ` ${policy.cancel_reason}` : ""),
        });
        return;
      }
      if (!(await otpVerified(order.order_id))) {
        json(res, 403, {
          error: "not_verified",
          message: "Verify the email code for this order before raising a delivery change.",
        });
        return;
      }
      const requestId = `chg-${Date.now().toString(36)}`;
      const doc: ChangeRequest = {
        request_id: requestId,
        order_id: order.order_id,
        order_doc_id: order.doc_id,
        kind: "delivery",
        current_delivery: order.estimated_delivery,
        requested_delivery: body.requested_delivery,
        customer: order.customer,
        customer_email: orderEmail(order),
        status: "pending",
        created_at: new Date().toISOString(),
      };
      await n1ql(`UPSERT INTO ${CHANGES} (KEY, VALUE) VALUES ($key, $doc)`, {
        key: requestId,
        doc,
      });
      json(res, 201, {
        ...doc,
        message:
          "Speak this exact sentence now: This action needs approval from a supervisor. Please stay on the line. Then call check_delivery_change. Never say wait a sec.",
        spoken_reply: "This action needs approval from a supervisor. Please stay on the line.",
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/requests/status") {
      const body = JSON.parse((await readBody(req)) || "{}") as { request_id?: string };
      if (!body.request_id) {
        json(res, 400, { error: "request_id is required" });
        return;
      }
      const row = await waitForRequest(body.request_id);
      if (!row) {
        json(res, 404, { error: "Request not found", request_id: body.request_id });
        return;
      }
      const kind = row.kind === "cancel" ? "cancel" : "delivery";
      json(res, 200, {
        ...row,
        kind,
        message:
          row.status === "pending"
            ? "Still pending. Do not speak. Do not say wait. Call check_delivery_change again now with the same request_id."
            : kind === "cancel" && row.status === "approved"
              ? "Cancellation approved. Tell the caller the order is cancelled."
              : kind === "cancel"
                ? "Cancellation rejected. The order stays as it is."
                : row.status === "approved"
                  ? "Delivery date approved. Speak the new date."
                  : "Delivery date rejected. The current date stays.",
      });
      return;
    }

    const decision = pathname.match(/^\/api\/requests\/([^/]+)\/(approve|reject)$/);
    if (req.method === "POST" && decision) {
      const requestId = decodeURIComponent(decision[1]);
      const action = decision[2] as "approve" | "reject";
      const rows = await n1ql(
        `SELECT META(c).id AS doc_key, c.* FROM ${CHANGES} c WHERE c.request_id = $id LIMIT 1`,
        { id: requestId },
      );
      const current = rows[0] as (ChangeRequest & { doc_key: string }) | undefined;
      if (!current) {
        json(res, 404, { error: "Request not found" });
        return;
      }
      if (current.status !== "pending") {
        json(res, 409, { error: `Request already ${current.status}`, request: current });
        return;
      }
      const reviewedAt = new Date().toISOString();
      const kind = current.kind === "cancel" ? "cancel" : "delivery";
      if (action === "approve") {
        if (kind === "cancel") {
          await n1ql(
            `UPDATE ${ORDERS} o USE KEYS $docId SET o.status = $status, o.cancelled_at = $at`,
            { docId: current.order_doc_id, status: "cancelled", at: reviewedAt },
          );
        } else {
          await n1ql(
            `UPDATE ${ORDERS} o USE KEYS $docId SET o.estimated_delivery = $date`,
            { docId: current.order_doc_id, date: current.requested_delivery },
          );
        }
        const to = current.customer_email || demoInbox();
        if (to) {
          try {
            await sendMail({
              to,
              subject:
                kind === "cancel"
                  ? `Order ${current.order_id} cancelled`
                  : `Delivery date updated for ${current.order_id}`,
              text:
                kind === "cancel"
                  ? `Your order ${current.order_id} has been cancelled after supervisor approval.`
                  : `Your delivery date for ${current.order_id} changed from ${current.current_delivery} to ${current.requested_delivery}.`,
            });
          } catch {
            // Approval still succeeds if mail is down.
          }
        }
      }
      await n1ql(
        `UPDATE ${CHANGES} c USE KEYS $key SET c.status = $status, c.reviewed_at = $at`,
        { key: current.doc_key, status: action === "approve" ? "approved" : "rejected", at: reviewedAt },
      );
      json(res, 200, {
        request_id: current.request_id,
        order_id: current.order_id,
        kind,
        status: action === "approve" ? "approved" : "rejected",
        estimated_delivery:
          kind === "cancel"
            ? current.current_delivery
            : action === "approve"
              ? current.requested_delivery
              : current.current_delivery,
      });
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

ensureCollection()
  .catch((err) => {
    console.error("Could not ensure delivery_changes collection:", err);
  })
  .finally(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Changes API and approval UI on 0.0.0.0:${PORT}`);
    });
  });
