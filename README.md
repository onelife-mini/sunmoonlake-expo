# 逐路船騎 ‧ 日月潭｜2026 台北國際旅展優惠導覽

旅展現場掃 QR 開啟的單頁網站：主推「逐路船騎」兩日遊、在地店家旅展優惠、互動地圖、優惠核銷打卡。

## 檔案
- `index.html` — 公開主頁
- `admin.html` — 店家位置後台（未公開連結，知道網址才進得去）
- `data/shops.json` — 店家資料（單一真相，後台改這個）
- `images/` — 日月潭實景照片

## 更新店家地址（後台流程）
1. 開 `你的網址/admin.html`
2. 逐家用「地址搜尋 / 地圖點選 / 貼 Google Maps 連結」設定位置，按「儲存這家」
3. 按「⬇ 匯出 shops.json」下載
4. 用下載的檔覆蓋 `data/shops.json`，commit + push，幾分鐘後生效

## 本機預覽
不能用 file:// 直接雙擊（會擋跨檔讀取）。請用簡易伺服器：
```bash
python3 -m http.server 8000   # 然後開 http://localhost:8000
```

## 照片來源
日月潭／台灣實景，CC 授權（Wikimedia Commons），詳見頁尾「照片來源」。
