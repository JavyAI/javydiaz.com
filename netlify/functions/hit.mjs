// javydiaz.com human-visit counter (Netlify Function v2 + Netlify Blobs).
// Privacy: never stores raw IPs or user agents. Uniques are deduped on a salted
// sha256 of ip + ua + ET date, and only that hash is kept, in that day's set.
// No read endpoint: data is read with the Netlify CLI / API by the site owner.
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const STORE = "jd-visits";
const SALT = (typeof Netlify !== "undefined" && Netlify.env.get("JD_VISIT_SALT")) || "12ae3fcae46f39bcd8a2aed3a19831950e26d0230e833578";
const BOT_RE = /bot|crawl|spider|headless|curl|python|wget|preview|facebookexternalhit/i;
const COUNT_HOSTS = new Set(["javydiaz.com", "www.javydiaz.com"]);

const done = (why) => new Response(null, { status: 204, headers: { "cache-control": "no-store", "x-jd": why } });

const etDate = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const refHost = (r, ownHost) => {
  if (!r || typeof r !== "string") return "(direct)";
  try {
    const h = new URL(r).hostname.toLowerCase().replace(/^www\./, "");
    if (!h) return "(direct)";
    if (h === ownHost.replace(/^www\./, "")) return "(internal)";
    return h.slice(0, 100);
  } catch { return "(other)"; }
};

const cleanPath = (p) => {
  if (typeof p !== "string" || !p.startsWith("/")) return "/";
  p = p.split("?")[0].split("#")[0].slice(0, 120);
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p === "/index.html") p = "/";
  if (p === "/resume.html") p = "/resume";
  return p;
};

const bump = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };

export default async (req, context) => {
  try {
    if (req.method !== "POST") return done("skip-method");
    const ua = req.headers.get("user-agent") || "";
    if (!ua || BOT_RE.test(ua)) return done("skip-ua");
    const host = (req.headers.get("host") || new URL(req.url).hostname || "").toLowerCase().split(":")[0];
    if (!COUNT_HOSTS.has(host)) return done("skip-host");
    const origin = req.headers.get("origin");
    if (origin) {
      try { if (!COUNT_HOSTS.has(new URL(origin).hostname.toLowerCase())) return done("skip-origin"); }
      catch { return done("skip-origin"); }
    }

    let body = {};
    try { body = JSON.parse((await req.text()).slice(0, 2048)) || {}; } catch { body = {}; }
    const path = cleanPath(body.p);
    const ref = refHost(body.r, host);
    const date = etDate();
    const ip = context.ip || req.headers.get("x-nf-client-connection-ip") || "";
    const hash = createHash("sha256").update(SALT + "|" + ip + "|" + ua + "|" + date).digest("hex").slice(0, 32);

    const store = getStore({ name: STORE, consistency: "strong" });
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await store.getWithMetadata(date, { type: "json" });
      const d = (cur && cur.data) || { date, pageviews: 0, uniques: 0, paths: {}, referrers: {}, hashes: [] };
      d.pageviews += 1;
      if (!d.hashes.includes(hash)) { d.hashes.push(hash); d.uniques = d.hashes.length; }
      bump(d.paths, path);
      bump(d.referrers, ref);
      d.updated = new Date().toISOString();
      const opts = cur && cur.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true };
      const res = await store.setJSON(date, d, opts);
      if (!res || res.modified !== false) return done("counted");
    }
    return done("skip-conflict");
  } catch (e) {
    console.error("hit error", e && e.message);
    return done("error");
  }
};

export const config = { path: "/api/hit" };
