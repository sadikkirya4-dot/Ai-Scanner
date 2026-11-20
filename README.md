# LifeVault

A privacy-first, installable life-admin and expense tracker built with vanilla HTML, CSS, and JavaScript. No application server or third-party database is used; records and receipt images stay in the browser's IndexedDB.

## Run locally

Serve this folder from `localhost` (service workers require HTTPS or localhost):

```sh
python3 -m http.server 8000
```

Open [http://localhost:8000](http://localhost:8000). Install LifeVault from the browser's install option to use the cached app shell offline.

## Privacy and storage

- Vault entries, expenses, shopping-list items, and receipt image blobs are stored in IndexedDB on this device.
- Wallet top-ups and debts are stored locally too. The available wallet balance is total funds added minus expenses dated on or after the first top-up; borrowed and lent balances remain separate. Debt entries support editing, settlement, and deletion.
- Expense pie charts can be filtered by day, month, year, custom date range, and category.
- Use **Data & settings → Export JSON backup** before clearing browser data or moving to another device. Restore replaces local records.
- OCR loads Tesseract.js and English language data from jsDelivr only after **Scan with OCR** is selected. Recognition runs in the browser; receipt images are not uploaded.
- WhatsApp reminders open WhatsApp with a pre-filled message only after you select the reminder action.
- There are no remote fonts, analytics, or automatic data sync.
- The default five-record limit includes both vault entries and expenses. `LIFE-PRO-2026` is a local demo key; it does not process a payment.
- A provider verification hook is available by defining `window.LifeVaultLicenseEndpoint` before `app.js` loads. It posts only the entered license key and product identifier; configure a trusted verification endpoint before using real license keys.

## App files

- `index.html` — accessible app layout and dialogs
- `styles.css` — responsive light/dark design system
- `app.js` — IndexedDB wrapper, views, and local-only features
- `manifest.json`, `icon.svg`, `sw.js` — install metadata, app icon, and offline app-shell cache