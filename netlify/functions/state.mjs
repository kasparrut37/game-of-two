// Game of Two: gemeinsamer Spielstand fuer beide Handys.
// Laeuft als Netlify Function und speichert alles in Netlify Blobs.

import { getStore } from "@netlify/blobs";

const STORE_NAME = "game-of-two";
const KEY = "state";
const MAX_OPS = 500;

function emptyState() {
  return { values: {}, notes: {}, ops: [], updated: Date.now() };
}

function normalize(s) {
  if (!s || typeof s !== "object") return emptyState();
  return {
    values: s.values && typeof s.values === "object" ? s.values : {},
    notes: s.notes && typeof s.notes === "object" ? s.notes : {},
    ops: Array.isArray(s.ops) ? s.ops : [],
    updated: s.updated || Date.now(),
  };
}

function openStore() {
  try {
    return getStore({ name: STORE_NAME, consistency: "strong" });
  } catch {
    return getStore(STORE_NAME);
  }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const validId = (s) => typeof s === "string" && /^[a-z0-9_-]{1,40}$/i.test(s);
const round = (n) => Math.round(n * 1000) / 1000;

// Wendet eine Aktion auf den Spielstand an. Gleiche Logik wie im Browser (Demo-Modus).
export function applyAction(state, body) {
  const s = state;
  switch (body.action) {
    case "add":
    case "set": {
      if (!validId(body.c) || !validId(body.opId)) throw new Error("bad request");
      if (s.ops.some((o) => o.id === body.opId)) return s; // schon verarbeitet
      const cur = Number(s.values[body.c] || 0);
      let next;
      if (body.action === "set") {
        const v = Number(body.v);
        if (!Number.isFinite(v) || v < 0 || v > 1e7) throw new Error("bad value");
        next = v;
      } else {
        const d = Number(body.d);
        if (!Number.isFinite(d) || Math.abs(d) > 1e7) throw new Error("bad value");
        next = Math.max(0, round(cur + d));
      }
      s.values[body.c] = next;
      s.ops.push({ id: body.opId, c: body.c, d: round(next - cur), t: Date.now() });
      if (s.ops.length > MAX_OPS) s.ops = s.ops.slice(-MAX_OPS);
      break;
    }
    case "undo": {
      const op = s.ops.find((o) => o.id === body.opId);
      if (!op || op.u) return s;
      const cur = Number(s.values[op.c] || 0);
      s.values[op.c] = Math.max(0, round(cur - op.d));
      op.u = 1;
      break;
    }
    case "note": {
      if (!validId(body.c)) throw new Error("bad request");
      s.notes[body.c] = String(body.text || "").slice(0, 60);
      break;
    }
    case "reset":
      return emptyState();
    default:
      throw new Error("unknown action");
  }
  s.updated = Date.now();
  return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async (req) => {
  const store = openStore();

  if (req.method === "GET") {
    const data = await store.get(KEY, { type: "json" });
    return json({ ok: true, state: normalize(data) });
  }

  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }

  // Optimistisches Speichern: wenn beide gleichzeitig klicken, wird neu versucht statt ueberschrieben.
  for (let i = 0; i < 10; i++) {
    const cur = await store.getWithMetadata(KEY, { type: "json" });
    let state = normalize(cur ? cur.data : null);
    try {
      state = applyAction(state, body);
    } catch (e) {
      return json({ ok: false, error: e.message }, 400);
    }
    const res = cur
      ? await store.setJSON(KEY, state, { onlyIfMatch: cur.etag })
      : await store.setJSON(KEY, state, { onlyIfNew: true });
    if (res.modified) return json({ ok: true, state });
    await sleep(40 + Math.random() * 160);
  }
  return json({ ok: false, error: "busy" }, 503);
};

export const config = { path: "/api/state" };
