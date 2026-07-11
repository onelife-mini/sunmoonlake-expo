// 台北旅展 逐路船騎 — 流量/兌換統計 Worker（Cloudflare Workers + D1）
// 端點：
//   POST /e     收事件 {t:"visit"|"claim", d:deviceId, s:shopId?}   （匿名，去重＋時間軸）
//   GET  /stats?key=金鑰[&from=YYYY-MM-DD&to=YYYY-MM-DD]   回統計 JSON（台灣時區）
//   GET  /health           健康檢查
// 隱私：只存匿名隨機 deviceId，不含任何個資。時間分析以台灣時間(+8)為準。

const MAX = 64;
const TZ = "+8 hours";            // SQLite 時區位移（台灣 UTC+8）
const TZ_OFFSET_MS = 8 * 3600 * 1000;
const clip = (v) => (v == null ? "" : String(v)).slice(0, MAX);

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function getSetting(env, k) {
  return await env.DB.prepare("SELECT v FROM settings WHERE k=?").bind(k).first("v");
}

// 把「台灣日期 YYYY-MM-DD」轉成 epoch ms 邊界
function dayStartMs(d) { const t = Date.parse(d + "T00:00:00Z"); return isNaN(t) ? null : t - TZ_OFFSET_MS; }
function dayEndMs(d)   { const t = Date.parse(d + "T00:00:00Z"); return isNaN(t) ? null : t - TZ_OFFSET_MS + 86400000 - 1; }

export default {
  async fetch(req, env) {
    const h = cors(req.headers.get("Origin"));
    try {
      return await handle(req, env, h);
    } catch (e) {
      // 單一查詢失敗不應拖垮整個端點
      return json({ ok: false, err: "server" }, 500, h);
    }
  },
};

async function handle(req, env, h) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: h });

    // ── 收事件 ──
    if (url.pathname === "/e" && req.method === "POST") {
      let b;
      try { b = JSON.parse(await req.text()); } catch { return json({ ok: false }, 400, h); }
      const d = clip(b && b.d);
      if (!d) return json({ ok: false, err: "no id" }, 400, h);
      const now = Date.now();
      const s = clip(b.s);
      const p = clip(b.p) || "lake"; // 頁面/軸線標記（歷史資料只有日月潭頁有埋點）
      // claim 必須帶 shop_id，否則視為無效（避免污染排行）→ 只當進站
      const type = (b.t === "claim" && s) ? "claim" : "visit";
      // 去重彙總表
      await env.DB.prepare(
        "INSERT INTO devices(id, first_seen, last_seen) VALUES(?1, ?2, ?2) ON CONFLICT(id) DO UPDATE SET last_seen=?2"
      ).bind(d, now).run();
      if (type === "claim") {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO claims(device_id, shop_id, first_ts) VALUES(?, ?, ?)"
        ).bind(d, s, now).run();
      }
      // 事件時間軸（每次都記，供日期/時段分析）
      await env.DB.prepare(
        "INSERT INTO events(ts, type, device_id, shop_id, page) VALUES(?, ?, ?, ?, ?)"
      ).bind(now, type, d, type === "claim" ? s : "", p).run();
      return json({ ok: true }, 200, h);
    }

    // ── 統計 ──
    if (url.pathname === "/stats" && req.method === "GET") {
      if (!env.STATS_KEY || url.searchParams.get("key") !== env.STATS_KEY)
        return json({ ok: false, err: "unauthorized" }, 401, h);

      const fromD = url.searchParams.get("from"); // YYYY-MM-DD（台灣），可省略
      const toD = url.searchParams.get("to");
      // 資料涵蓋的最早/最晚日期（也給日期選擇器用）
      const span = await env.DB.prepare(
        "SELECT MIN(date(ts/1000,'unixepoch',?1)) minD, MAX(date(ts/1000,'unixepoch',?1)) maxD FROM events"
      ).bind(TZ).first();
      // 未指定 from/to → 用資料實際涵蓋的完整範圍（未來/過去皆正確）
      const lo = fromD ? dayStartMs(fromD) : (span && span.minD ? dayStartMs(span.minD) : 0);
      const hi = toD ? dayEndMs(toD) : (span && span.maxD ? dayEndMs(span.maxD) : Date.now());
      const L = lo == null ? 0 : lo, H = hi == null ? Date.now() : hi;

      // 區間 KPI（以事件表計算）
      const tot = await env.DB.prepare(
        "SELECT " +
        "COUNT(DISTINCT CASE WHEN type='visit' THEN device_id END) visitors, " +
        "COUNT(DISTINCT CASE WHEN type='claim' THEN device_id END) claimers, " +
        "SUM(CASE WHEN type='visit' THEN 1 ELSE 0 END) visits, " +
        "SUM(CASE WHEN type='claim' THEN 1 ELSE 0 END) claims " +
        "FROM events WHERE ts BETWEEN ?1 AND ?2"
      ).bind(L, H).first();

      // 每日（台灣日）
      const byDay = await env.DB.prepare(
        "SELECT date(ts/1000,'unixepoch',?3) d, " +
        "COUNT(DISTINCT CASE WHEN type='visit' THEN device_id END) visitors, " +
        "SUM(CASE WHEN type='visit' THEN 1 ELSE 0 END) visits, " +
        "COUNT(DISTINCT CASE WHEN type='claim' THEN device_id END) claimers, " +
        "SUM(CASE WHEN type='claim' THEN 1 ELSE 0 END) claims " +
        "FROM events WHERE ts BETWEEN ?1 AND ?2 GROUP BY d ORDER BY d"
      ).bind(L, H, TZ).all();

      // 時段（0-23 台灣時）
      const byHour = await env.DB.prepare(
        "SELECT CAST(strftime('%H', ts/1000,'unixepoch',?3) AS INTEGER) h, " +
        "SUM(CASE WHEN type='visit' THEN 1 ELSE 0 END) visits, " +
        "SUM(CASE WHEN type='claim' THEN 1 ELSE 0 END) claims " +
        "FROM events WHERE ts BETWEEN ?1 AND ?2 GROUP BY h ORDER BY h"
      ).bind(L, H, TZ).all();

      // 各店家（區間內）
      const perShop = await env.DB.prepare(
        "SELECT shop_id, COUNT(DISTINCT device_id) devices, COUNT(*) claims " +
        "FROM events WHERE type='claim' AND ts BETWEEN ?1 AND ?2 GROUP BY shop_id ORDER BY devices DESC, claims DESC"
      ).bind(L, H).all();

      // 各頁面/軸線分流（區間內；歷史無 page 的視為日月潭頁）
      const byPage = await env.DB.prepare(
        "SELECT COALESCE(NULLIF(page,''),'lake') pg, " +
        "COUNT(DISTINCT CASE WHEN type='visit' THEN device_id END) visitors, " +
        "SUM(CASE WHEN type='visit' THEN 1 ELSE 0 END) visits " +
        "FROM events WHERE ts BETWEEN ?1 AND ?2 GROUP BY pg " +
        "HAVING SUM(CASE WHEN type='visit' THEN 1 ELSE 0 END) > 0 ORDER BY visitors DESC"
      ).bind(L, H).all();

      return json({
        ok: true,
        generatedAt: Date.now(),
        tz: "Asia/Taipei (UTC+8)",
        range: { from: fromD || null, to: toD || null },
        dataMinDate: (span && span.minD) || null,
        dataMaxDate: (span && span.maxD) || null,
        visitors: (tot && tot.visitors) || 0,
        claimers: (tot && tot.claimers) || 0,
        visits: (tot && tot.visits) || 0,
        claims: (tot && tot.claims) || 0,
        byDay: (byDay && byDay.results) || [],
        byHour: (byHour && byHour.results) || [],
        perShop: (perShop && perShop.results) || [],
        byPage: (byPage && byPage.results) || [],
      }, 200, h);
    }

    // ── 店家資料：公開讀取（前台用；未發佈過回 404，前台退回靜態 shops.json）──
    if (url.pathname === "/shops" && req.method === "GET") {
      const v = await getSetting(env, "shops_json");
      if (!v) return json({ ok: false, err: "not-published" }, 404, h);
      const at = await getSetting(env, "shops_published_at");
      return new Response('{"ok":true,"publishedAt":' + (at || 0) + ',"shops":' + v + "}", {
        status: 200,
        headers: { ...h, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    // ── 店家資料：發佈（後台用；statsKey 驗證）──
    if (url.pathname === "/shops" && req.method === "POST") {
      let b; try { b = JSON.parse(await req.text()); } catch { return json({ ok: false }, 400, h); }
      if (!env.STATS_KEY || (b && b.key) !== env.STATS_KEY)
        return json({ ok: false, err: "unauthorized" }, 401, h);
      const shops = b && b.shops;
      if (!Array.isArray(shops) || !shops.length || shops.length > 500)
        return json({ ok: false, err: "bad-shops" }, 400, h);
      for (const s of shops) {
        if (!s || typeof s !== "object" || s.id == null || !s.name)
          return json({ ok: false, err: "bad-shop-item" }, 400, h);
        if ((s.lat != null && !Number.isFinite(+s.lat)) || (s.lng != null && !Number.isFinite(+s.lng)))
          return json({ ok: false, err: "bad-coords: " + s.name }, 400, h);
      }
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO settings(k,v) VALUES('shops_json',?1) ON CONFLICT(k) DO UPDATE SET v=?1"
      ).bind(JSON.stringify(shops)).run();
      await env.DB.prepare(
        "INSERT INTO settings(k,v) VALUES('shops_published_at',?1) ON CONFLICT(k) DO UPDATE SET v=?1"
      ).bind(String(now)).run();
      return json({ ok: true, publishedAt: now, count: shops.length }, 200, h);
    }

    // ── 後台登入（驗密碼 → 回數據金鑰）──
    if (url.pathname === "/login" && req.method === "POST") {
      let b; try { b = JSON.parse(await req.text()); } catch { return json({ ok: false }, 400, h); }
      const stored = await getSetting(env, "admin_pass_hash");
      if (!stored) return json({ ok: false, err: "not-setup" }, 500, h);
      const hh = await sha256hex(String((b && b.pass) || ""));
      if (hh !== stored) return json({ ok: false, err: "wrong" }, 401, h);
      return json({ ok: true, statsKey: env.STATS_KEY || "" }, 200, h);
    }

    // ── 改後台密碼（驗舊 → 更新）──
    if (url.pathname === "/change-pass" && req.method === "POST") {
      let b; try { b = JSON.parse(await req.text()); } catch { return json({ ok: false }, 400, h); }
      const stored = await getSetting(env, "admin_pass_hash");
      const oldh = await sha256hex(String((b && b.pass) || ""));
      if (!stored || oldh !== stored) return json({ ok: false, err: "wrong-old" }, 401, h);
      const np = String((b && b.newPass) || "");
      if (np.length < 4) return json({ ok: false, err: "too-short" }, 400, h);
      const nh = await sha256hex(np);
      await env.DB.prepare("INSERT INTO settings(k,v) VALUES('admin_pass_hash',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(nh).run();
      return json({ ok: true }, 200, h);
    }

    if (url.pathname === "/health") return json({ ok: true }, 200, h);
    return json({ ok: false, err: "not found" }, 404, h);
}

function json(obj, status, h) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...h, "Content-Type": "application/json; charset=utf-8" },
  });
}
