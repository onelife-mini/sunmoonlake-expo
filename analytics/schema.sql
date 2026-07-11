-- 台北旅展 逐路船騎 — 統計資料表（Cloudflare D1 / SQLite）
-- 只存匿名裝置 ID，無個資。

-- 每支不重複的手機（進站即記一筆；重複進站只更新 last_seen）
CREATE TABLE IF NOT EXISTS devices (
  id         TEXT PRIMARY KEY,   -- 匿名 deviceId（前端 localStorage 產生的 UUID）
  first_seen INTEGER,            -- 首次進站（epoch ms）
  last_seen  INTEGER             -- 最近進站（epoch ms）
);

-- 每支手機對每家店的「按過兌換」（device+shop 唯一，天生去重）
CREATE TABLE IF NOT EXISTS claims (
  device_id TEXT,
  shop_id   TEXT,
  first_ts  INTEGER,             -- 首次按兌換（epoch ms）
  PRIMARY KEY (device_id, shop_id)
);

CREATE INDEX IF NOT EXISTS idx_claims_shop ON claims(shop_id);

-- 事件時間軸（每一次進站/兌換都記一筆，供日期/時段/區間分析；台灣時區於查詢時 +8h 換算）
CREATE TABLE IF NOT EXISTS events (
  ts        INTEGER,   -- epoch ms（UTC）
  type      TEXT,      -- 'visit' | 'claim'
  device_id TEXT,
  shop_id   TEXT,
  page      TEXT       -- 頁面/軸線：lake(日月潭)/taomi(桃米)/toushe(頭社)…
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);

-- 後台設定（key/value）：目前存 admin_pass_hash（後台密碼的 SHA-256 雜湊）
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT
);
