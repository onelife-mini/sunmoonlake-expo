# 流量／兌換統計後端（Cloudflare Workers + D1）

匿名統計「多少支手機進站」與「多少支手機按過兌換」，數據顯示在 `admin.html` 的「📊 數據」。
只存前端隨機產生的匿名 `deviceId`，**不含任何個資**。

## 一次性部署步驟

> 需要一個免費 Cloudflare 帳號。以下在 `analytics/` 資料夾內執行。

```bash
cd analytics

# 1) 安裝並登入 wrangler（Cloudflare CLI）
npm install -g wrangler
wrangler login

# 2) 建立 D1 資料庫（會回傳一段 database_id）
wrangler d1 create sunmoonlake-expo-stats
#    → 把回傳的 database_id 貼進 wrangler.toml 的 database_id 欄位

# 3) 建表
wrangler d1 execute sunmoonlake-expo-stats --remote --file schema.sql

# 3b)【既有資料庫升級用】schema.sql 的 CREATE TABLE IF NOT EXISTS 不會幫「已存在的表」補新欄位。
#     若資料庫是 2026-07-11 前建立的，部署新版 worker 前務必先跑（先 migrate、再 deploy）：
wrangler d1 execute sunmoonlake-expo-stats --remote --command "ALTER TABLE events ADD COLUMN page TEXT;"

# 4) 設定數據金鑰 STATS_KEY（統計 API 用；與登入密碼不同）
wrangler secret put STATS_KEY
#    → 貼上你的金鑰後 Enter

# 4b) 設定後台登入密碼（雜湊存 D1 settings 表；登入後可在後台「設定」自行更改）
#     把 <你的密碼> 換掉，算出 SHA-256 後寫入：
HASH=$(printf '%s' "<你的密碼>" | shasum -a 256 | cut -d' ' -f1)
wrangler d1 execute sunmoonlake-expo-stats --remote \
  --command "INSERT INTO settings(k,v) VALUES('admin_pass_hash','$HASH') ON CONFLICT(k) DO UPDATE SET v=excluded.v;"

# 5) 部署
wrangler deploy
#    → 會顯示網址，例如：
#      https://sunmoonlake-expo-stats.你的帳號.workers.dev
```

## 部署後：把網址接上前後台

把上面拿到的 worker 網址（**結尾不要加斜線**）填入兩個檔案的 `ANALYTICS_URL`：

- `index.html` — 搜尋 `const ANALYTICS_URL=`（前台埋點用）
- `admin.html` — 搜尋 `const ANALYTICS_URL=`（後台讀數據用）

例如：
```js
const ANALYTICS_URL="https://sunmoonlake-expo-stats.你的帳號.workers.dev";
```

填好後重新部署網站（推 main）。完成後：
- 使用者一進站 → 記一支手機（`/e` visit）
- 按「領取／兌換」→ 記該手機對該店的兌換（`/e` claim，天生去重）
- 打開 `admin.html` →「📊 數據」→ 輸入 STATS_KEY → 看即時數字

## 端點

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/e` | 收事件 `{t:"visit"｜"claim", d:deviceId, s:shopId?}` |
| GET | `/stats?key=STATS_KEY` | 回統計 JSON |
| GET | `/health` | 健康檢查 |

## 免費額度

Cloudflare Workers 免費方案每日 10 萬次請求、D1 免費 500 萬列讀取／天，
本活動規模（數百～數千支手機）遠遠用不完，成本 0 元。

## 之後要看歷史／清空

```bash
# 看目前總數
wrangler d1 execute sunmoonlake-expo-stats --remote \
  --command "SELECT (SELECT COUNT(*) FROM devices) visitors, (SELECT COUNT(DISTINCT device_id) FROM claims) claimers;"

# 活動結束想歸零（小心！會清光）
wrangler d1 execute sunmoonlake-expo-stats --remote --command "DELETE FROM devices; DELETE FROM claims;"
```
