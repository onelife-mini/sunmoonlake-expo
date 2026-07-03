// 台北旅展 逐路船騎 — 流量/兌換統計 Worker（Cloudflare Workers + D1）
// 端點：
//   POST /e     收事件 {t:"visit"|"claim", d:deviceId, s:shopId?}   （匿名，去重）
//   GET  /stats?key=金鑰   回統計 JSON（給 admin 後台）
//   GET  /health           健康檢查
// 隱私：只存匿名隨機 deviceId，不含任何個資。

const MAX = 64;
const clip = (v) => (v == null ? "" : String(v)).slice(0, MAX);

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const h = cors(req.headers.get("Origin"));

    if (req.method === "OPTIONS") return new Response(null, { headers: h });

    // 收事件
    if (url.pathname === "/e" && req.method === "POST") {
      let b;
      try { b = JSON.parse(await req.text()); } catch { return json({ ok: false }, 400, h); }
      const d = clip(b && b.d);
      if (!d) return json({ ok: false, err: "no id" }, 400, h);
      const now = Date.now();
      // 每個事件都先確保裝置存在（visit / claim 皆算一次進站）
      await env.DB.prepare(
        "INSERT INTO devices(id, first_seen, last_seen) VALUES(?1, ?2, ?2) " +
        "ON CONFLICT(id) DO UPDATE SET last_seen=?2"
      ).bind(d, now).run();
      if (b.t === "claim") {
        const s = clip(b.s);
        await env.DB.prepare(
          "INSERT OR IGNORE INTO claims(device_id, shop_id, first_ts) VALUES(?, ?, ?)"
        ).bind(d, s, now).run();
      }
      return json({ ok: true }, 200, h);
    }

    // 統計（需金鑰）
    if (url.pathname === "/stats" && req.method === "GET") {
      if (!env.STATS_KEY || url.searchParams.get("key") !== env.STATS_KEY)
        return json({ ok: false, err: "unauthorized" }, 401, h);
      const visitors = await env.DB.prepare("SELECT COUNT(*) n FROM devices").first("n");
      const claimers = await env.DB.prepare("SELECT COUNT(DISTINCT device_id) n FROM claims").first("n");
      const claimEvents = await env.DB.prepare("SELECT COUNT(*) n FROM claims").first("n");
      const perShop = await env.DB.prepare(
        "SELECT shop_id, COUNT(DISTINCT device_id) n FROM claims GROUP BY shop_id ORDER BY n DESC"
      ).all();
      return json({
        ok: true,
        generatedAt: Date.now(),
        visitors: visitors || 0,        // 不重複進站手機數
        claimers: claimers || 0,        // 不重複「按過兌換」手機數
        claimEvents: claimEvents || 0,  // 兌換券別總數（同手機多店家會分別計）
        perShop: (perShop && perShop.results) || [],
      }, 200, h);
    }

    if (url.pathname === "/health") return json({ ok: true }, 200, h);
    return json({ ok: false, err: "not found" }, 404, h);
  },
};

function json(obj, status, h) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...h, "Content-Type": "application/json; charset=utf-8" },
  });
}
