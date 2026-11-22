(() => {
  "use strict";

  const DB_NAME = "lifevault-local";
  const DB_VERSION = 4;
  const FREE_LIMIT = 5;
  const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
  const CATEGORIES = {
    vault: {
      "IDs & travel": "✈",
      Insurance: "⌑",
      "Home & bills": "⌂",
      "Rewards & points": "✦",
      Events: "◷",
      Warranties: "▣"
    },
    expense: {
      Groceries: "🥬",
      "Dining & Coffee": "☕",
      "Fuel & Transport": "⛽",
      Utilities: "⌂",
      Shopping: "🛍"
    }
  };
  const CURRENCY_SYMBOLS = { AED: "AED", USD: "$", EUR: "€", GBP: "£", SAR: "SAR" };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const todayISO = () => dateInputValue(new Date());
  function dateInputValue(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  function readPreference(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
  }
  function savePreference(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      showToast("This browser could not save the display preference.", "error");
    }
  }
  let db;
  let isPro = false;
  let currency = readPreference("lifevault-currency", "AED");
  let darkMode = readPreference("lifevault-theme", "light") === "dark";
  let overviewPeriod = "all";
  let currentView = "dashboard";
  let expenseReceipt = null;
  let detectedReceiptItems = [];
  let receiptObjectUrl = null;
  let previewObjectUrl = null;
  let ocrBusy = false;
  let deferredPrompt = null;
  let homeVault = [];
  let taskPhoto = null;
  let taskPhotoObjectUrl = null;

  class LocalDatabase {
    open() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("vault")) database.createObjectStore("vault", { keyPath: "id" });
          if (!database.objectStoreNames.contains("expenses")) database.createObjectStore("expenses", { keyPath: "id" });
          if (!database.objectStoreNames.contains("shopping")) database.createObjectStore("shopping", { keyPath: "id" });
          if (!database.objectStoreNames.contains("wallet")) database.createObjectStore("wallet", { keyPath: "id" });
          if (!database.objectStoreNames.contains("debts")) database.createObjectStore("debts", { keyPath: "id" });
          if (!database.objectStoreNames.contains("tasks")) database.createObjectStore("tasks", { keyPath: "id" });
          if (!database.objectStoreNames.contains("products")) database.createObjectStore("products", { keyPath: "id" });
          if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta", { keyPath: "key" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Unable to open local storage."));
        request.onblocked = () => reject(new Error("LifeVault storage is blocked by another open tab. Close other tabs and try again."));
      });
    }
    request(store, mode, action) {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = action(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("The local storage request failed."));
        transaction.onabort = () => reject(transaction.error || new Error("The local storage transaction was aborted."));
      });
    }

    all(store) { return this.request(store, "readonly", (objectStore) => objectStore.getAll()); }
    get(store, key) { return this.request(store, "readonly", (objectStore) => objectStore.get(key)); }
    put(store, value) { return this.request(store, "readwrite", (objectStore) => objectStore.put(value)); }
    delete(store, key) { return this.request(store, "readwrite", (objectStore) => objectStore.delete(key)); }
    clear(store) { return this.request(store, "readwrite", (objectStore) => objectStore.clear()); }

    replaceRecords(vault, expenses, shopping, wallet, debts, tasks = [], products = []) {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["vault", "expenses", "shopping", "wallet", "debts", "tasks", "products"], "readwrite");
        for (const [store, records] of [
          ["vault", vault], ["expenses", expenses], ["shopping", shopping], ["wallet", wallet], ["debts", debts], ["tasks", tasks], ["products", products]
        ]) {
          const objectStore = transaction.objectStore(store);
          objectStore.clear();
          records.forEach((record) => objectStore.put(record));
        }
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("Could not restore the backup."));
        transaction.onabort = () => reject(transaction.error || new Error("The backup restore was cancelled."));
      });
    }
  }

  const database = new LocalDatabase();

  function makeId() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function showToast(message, type = "success") {
    const region = $("#toast-region");
    const toast = document.createElement("div");
    toast.className = `toast${type === "error" ? " error" : ""}`;
    toast.textContent = message;
    region.append(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }

  function reportError(error, context) {
    showToast(`${context}: ${error?.message || "Please try again."}`, "error");
  }

  function money(amount) {
    const numeric = Number(amount) || 0;
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
        minimumFractionDigits: 0
      }).format(numeric);
    } catch {
      return `${CURRENCY_SYMBOLS[currency] || currency} ${numeric.toFixed(2)}`;
    }
  }

  function localDate(isoDate, options = { year: "numeric", month: "short", day: "numeric" }) {
    if (!isoDate) return "No date";
    const date = new Date(`${isoDate}T12:00:00`);
    return Number.isNaN(date.getTime()) ? "Invalid date" : new Intl.DateTimeFormat(undefined, options).format(date);
  }

  function dayDifference(isoDate) {
    const target = new Date(`${isoDate}T00:00:00`);
    if (Number.isNaN(target.getTime())) return null;
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.ceil((target.getTime() - now.getTime()) / 86400000);
  }

  function formatVaultTime(time) {
    if (!time) return "";
    const date = new Date(`1970-01-01T${time}`);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function countdownLabel(date, time, done) {
    if (done) return "Completed";
    if (!date) return "No date";
    if (!time) return getUrgency(date, done).text;
    const target = new Date(`${date}T${time || "23:59"}:00`);
    if (Number.isNaN(target.getTime())) return "Date unavailable";
    const difference = target.getTime() - Date.now();
    if (difference < 60000 && difference > -60000) return "Due now";
    if (difference < 0) {
      const duration = countdownDuration(Math.abs(difference));
      return `Expired ${duration} ago`;
    }
    return `In ${countdownDuration(difference)}`;
  }

  function countdownDuration(milliseconds) {
    let minutes = Math.max(0, Math.floor(milliseconds / 60000));
    const days = Math.floor(minutes / 1440);
    minutes %= 1440;
    const hours = Math.floor(minutes / 60);
    minutes %= 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function updateHomeClock(vault = []) {
    const now = new Date();
    const dateText = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric"
    }).format(now);
    const timeText = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit"
    }).format(now);
    $("#today-label").textContent = dateText.toUpperCase();
    $("#home-time").textContent = timeText;

    const next = vault
      .filter((item) => !item.done && item.date)
      .map((item) => ({
        item,
        target: new Date(`${item.date}T${item.time || "23:59"}:00`)
      }))
      .filter((entry) => !Number.isNaN(entry.target.getTime()) && entry.target.getTime() >= now.getTime())
      .sort((a, b) => a.target.getTime() - b.target.getTime())[0];

    const countdownElement = $("#home-countdown");
    countdownElement.textContent = next
      ? `Next: ${next.item.name} · ${countdownDuration(next.target.getTime() - now.getTime())}`
      : "No upcoming reminders";
    countdownElement.classList.toggle("has-reminder", Boolean(next));
  }

  function vaultDateLine(item) {
    const date = localDate(item.date);
    const time = formatVaultTime(item.time);
    return [date, time, countdownLabel(item.date, item.time, item.done)].filter(Boolean).join(" · ");
  }

  async function renderHomeSearch(query) {
    const box = $("#home-search-results");
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) { box.hidden = true; box.replaceChildren(); return; }
    const [vault, expenses, debts, tasks] = await Promise.all([
      database.all("vault"), database.all("expenses"), database.all("debts"), database.all("tasks")
    ]);
    const matches = [
      ...vault.map((item) => ({ text: `${item.name} ${item.category} ${item.location || ""} ${item.reference || ""}`, label: item.location ? `Stored at ${item.location}` : "Reminder", view: "vault" })),
      ...expenses.map((item) => ({ text: `${item.name} ${item.category}`, label: "Expense", view: "expenses" })),
      ...debts.map((item) => ({ text: `${item.person} ${item.note || ""}`, label: "Debt", view: "debts" })),
      ...tasks.map((item) => ({ text: `${item.title} ${item.location || ""}`, label: "To-do", view: "tasks" }))
    ].filter((item) => item.text.toLocaleLowerCase().includes(normalized)).slice(0, 8);
    box.hidden = false;
    box.innerHTML = matches.length
      ? matches.map((item) => `<button class="home-search-result" type="button" data-view="${item.view}"><strong>${escapeHtml(item.text)}</strong><span>${item.label}</span></button>`).join("")
      : '<p class="home-search-empty">No matching records</p>';
  }

  function getUrgency(date, done) {
    if (done) return { text: "Completed", className: "badge-done" };
    const days = dayDifference(date);
    if (days === null) return { text: "Date unavailable", className: "badge-done" };
    if (days < 0) return { text: `Expired ${Math.abs(days)}d ago`, className: "badge-red" };
    if (days === 0) return { text: "Due today", className: "badge-red" };
    if (days <= 7) return { text: `${days} day${days === 1 ? "" : "s"} left`, className: "badge-red" };
    if (days <= 30) return { text: `${days} days left`, className: "badge-amber" };
    return { text: "On track", className: "badge-green" };
  }

  function dateOffset(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return dateInputValue(date);
  }

  function dateInCurrentMonth(daysAgo) {
    const date = new Date();
    date.setDate(Math.max(1, date.getDate() - daysAgo));
    return dateInputValue(date);
  }

  async function seedSamplesIfEmpty() {
    const initialized = await database.get("meta", "initialized");
    if (initialized?.value) {
      const richWalletSeed = await database.get("meta", "rich-wallet-samples-v1");
      if (!richWalletSeed?.value) {
        const wallet = await database.all("wallet");
        if (!wallet.length) {
          const walletSamples = [
            { id: "sample-wallet-1", amount: 8500, date: dateOffset(-90), note: "Monthly salary", sample: true, createdAt: Date.now() - 1500 },
            { id: "sample-wallet-2", amount: 450, date: dateOffset(-82), note: "Travel reimbursement", sample: true, createdAt: Date.now() - 1490 },
            { id: "sample-wallet-3", amount: 8500, date: dateOffset(-61), note: "Monthly salary", sample: true, createdAt: Date.now() - 1480 },
            { id: "sample-wallet-4", amount: 1250, date: dateOffset(-55), note: "Freelance project payment", sample: true, createdAt: Date.now() - 1470 },
            { id: "sample-wallet-5", amount: 300, date: dateOffset(-48), note: "Cash deposit", sample: true, createdAt: Date.now() - 1460 },
            { id: "sample-wallet-6", amount: 8500, date: dateOffset(-31), note: "Monthly salary", sample: true, createdAt: Date.now() - 1450 },
            { id: "sample-wallet-7", amount: 600, date: dateOffset(-27), note: "Friend reimbursement", sample: true, createdAt: Date.now() - 1440 },
            { id: "sample-wallet-8", amount: 1000, date: dateOffset(-20), note: "Bank transfer", sample: true, createdAt: Date.now() - 1430 },
            { id: "sample-wallet-9", amount: 8500, date: dateOffset(-1), note: "Monthly salary", sample: true, createdAt: Date.now() - 1420 },
            { id: "sample-wallet-10", amount: 300, date: dateOffset(-1), note: "Cash reimbursement", sample: true, createdAt: Date.now() - 1410 },
            { id: "sample-wallet-11", amount: 800, date: todayISO(), note: "Side project payment", sample: true, createdAt: Date.now() - 1400 }
          ];
          await Promise.all(walletSamples.map((entry) => database.put("wallet", entry)));
        }
        await database.put("meta", { key: "rich-wallet-samples-v1", value: true });
      }
      const richDebtSeed = await database.get("meta", "rich-debt-samples-v1");
      if (!richDebtSeed?.value) {
        const debts = await database.all("debts");
        if (!debts.some((debt) => String(debt.id).startsWith("sample-debt-"))) {
          await Promise.all([
            database.put("debts", { id: "sample-debt-1", person: "Sarah", direction: "owed-to-me", amount: 600, remaining: 250, date: dateOffset(-20), dueDate: dateOffset(10), note: "Shared dinner and taxi", settledRemaining: 250, sample: true, createdAt: Date.now() - 1200 }),
            database.put("debts", { id: "sample-debt-2", person: "Omar", direction: "i-owe", amount: 400, remaining: 400, date: dateOffset(-9), dueDate: dateOffset(5), note: "Weekend fuel advance", settledRemaining: 400, sample: true, createdAt: Date.now() - 1100 })
          ]);
        }
        await database.put("meta", { key: "rich-debt-samples-v1", value: true });
      }
      return;
    }
    const [vault, expenses, wallet, debts, tasks, products] = await Promise.all([
      database.all("vault"), database.all("expenses"), database.all("wallet"),
      database.all("debts"), database.all("tasks"), database.all("products")
    ]);
    if (vault.length + expenses.length + wallet.length + debts.length + tasks.length + products.length !== 0) {
      await database.put("meta", { key: "initialized", value: true });
      return;
    }
    const now = Date.now();
    const samples = [
      {
        id: "sample-passport", name: "Passport renewal", category: "IDs & travel",
        date: dateOffset(14), time: "09:30", recurrence: "yearly", location: "Blue filing cabinet",
        reference: "UAE passport", value: 0,
        notes: "Start the renewal process before travel season.", sample: true, done: false, createdAt: now
      },
      {
        id: "sample-insurance", name: "Car insurance renewal", category: "Insurance",
        date: dateOffset(42), time: "10:00", recurrence: "yearly", location: "Insurance folder",
        reference: "POL-CAR-2048", value: 3200,
        notes: "Compare provider quotes before renewing.", sample: true, done: false, createdAt: now - 100
      },
      {
        id: "sample-rent", name: "Apartment rent", category: "Home & bills",
        date: dateOffset(9), time: "18:00", recurrence: "monthly", location: "Payments folder",
        reference: "UNIT-14A", value: 5500,
        notes: "Scheduled monthly rent payment.", sample: true, done: false, createdAt: now - 200
      },
      {
        id: "sample-warranty", name: "Laptop warranty check", category: "Warranties",
        date: dateOffset(75), recurrence: "none", location: "Desk drawer",
        reference: "SN-LPT-7781", value: 2800,
        notes: "Confirm warranty coverage and keep purchase receipt.", sample: true, done: false, createdAt: now - 300
      }
    ];
    const expenseSamples = [
      { id: "sample-grocery-1", name: "Pantry groceries", productId: "sample-product-milk", category: "Groceries", vendor: "Carrefour", amount: 84.5, quantity: 1, unitPrice: 84.5, vat: 5, date: dateInCurrentMonth(5), sample: true, createdAt: now - 3000 },
      { id: "sample-grocery-2", name: "Whole milk", productId: "sample-product-milk", category: "Groceries", vendor: "Carrefour", amount: 78, quantity: 6, unitPrice: 12.38, vat: 5, date: dateInCurrentMonth(2), sample: true, createdAt: now - 2000 },
      { id: "sample-grocery-3", name: "Fresh vegetables", productId: "sample-product-vegetables", category: "Groceries", vendor: "Fresh Market", amount: 46.75, quantity: 1, unitPrice: 46.75, vat: 5, date: dateOffset(-8), sample: true, createdAt: now - 2900 },
      { id: "sample-grocery-4", name: "Rice and pantry staples", productId: "sample-product-rice", category: "Groceries", vendor: "Lulu Hypermarket", amount: 112.4, quantity: 1, unitPrice: 112.4, vat: 5, date: dateOffset(-21), sample: true, createdAt: now - 2800 },
      { id: "sample-coffee-1", name: "Iced latte", productId: "sample-product-latte", category: "Dining & Coffee", vendor: "Costa Coffee", amount: 24.5, quantity: 1, unitPrice: 24.5, vat: 5, date: dateOffset(-2), sample: true, createdAt: now - 2700 },
      { id: "sample-coffee-2", name: "Breakfast and coffee", productId: "", category: "Dining & Coffee", vendor: "Starbucks", amount: 68, quantity: 2, unitPrice: 34, vat: 5, date: dateOffset(-6), sample: true, createdAt: now - 2600 },
      { id: "sample-coffee-3", name: "Lunch meal", productId: "", category: "Dining & Coffee", vendor: "Kcal", amount: 54, quantity: 1, unitPrice: 54, vat: 5, date: dateOffset(-12), sample: true, createdAt: now - 2500 },
      { id: "sample-fuel-1", name: "Vehicle fuel", productId: "sample-product-fuel", category: "Fuel & Transport", vendor: "ENOC", amount: 185, quantity: 38, unitPrice: 4.87, vat: 0, date: dateOffset(-4), sample: true, createdAt: now - 2400 },
      { id: "sample-fuel-2", name: "Metro and taxi", productId: "", category: "Fuel & Transport", vendor: "Careem", amount: 92.25, quantity: 3, unitPrice: 30.75, vat: 5, date: dateOffset(-15), sample: true, createdAt: now - 2300 },
      { id: "sample-fuel-3", name: "Vehicle fuel", productId: "sample-product-fuel", category: "Fuel & Transport", vendor: "ADNOC", amount: 210, quantity: 43, unitPrice: 4.88, vat: 0, date: dateOffset(-29), sample: true, createdAt: now - 2200 },
      { id: "sample-utility-1", name: "Electricity and water", productId: "", category: "Utilities", vendor: "DEWA", amount: 420, quantity: 1, unitPrice: 420, vat: 0, date: dateOffset(-10), sample: true, createdAt: now - 2100 },
      { id: "sample-utility-2", name: "Internet subscription", productId: "sample-product-internet", category: "Utilities", vendor: "Du", amount: 299, quantity: 1, unitPrice: 299, vat: 5, date: dateOffset(-18), sample: true, createdAt: now - 2000 },
      { id: "sample-shopping-1", name: "Running shoes", productId: "sample-product-shoes", category: "Shopping", vendor: "Nike Store", amount: 480, quantity: 1, unitPrice: 480, vat: 5, date: dateOffset(-7), sample: true, createdAt: now - 1900 },
      { id: "sample-shopping-2", name: "Office headphones", productId: "", category: "Shopping", vendor: "Amazon.ae", amount: 325, quantity: 1, unitPrice: 325, vat: 5, date: dateOffset(-24), sample: true, createdAt: now - 1800 },
      { id: "sample-grocery-5", name: "Whole milk", productId: "sample-product-milk", category: "Groceries", vendor: "Carrefour", amount: 74.4, quantity: 6, unitPrice: 12.4, vat: 5, date: dateOffset(-35), sample: true, createdAt: now - 1700 },
      { id: "sample-grocery-6", name: "Pantry groceries", category: "Groceries", vendor: "Lulu Hypermarket", amount: 96, quantity: 1, unitPrice: 96, vat: 5, date: dateOffset(-48), sample: true, createdAt: now - 1600 }
    ];
    const walletSamples = [
      { id: "sample-wallet-1", amount: 8500, date: dateOffset(-90), note: "Monthly salary", sample: true, createdAt: now - 1500 },
      { id: "sample-wallet-2", amount: 450, date: dateOffset(-82), note: "Travel reimbursement", sample: true, createdAt: now - 1490 },
      { id: "sample-wallet-3", amount: 8500, date: dateOffset(-61), note: "Monthly salary", sample: true, createdAt: now - 1480 },
      { id: "sample-wallet-4", amount: 1250, date: dateOffset(-55), note: "Freelance project payment", sample: true, createdAt: now - 1470 },
      { id: "sample-wallet-5", amount: 300, date: dateOffset(-48), note: "Cash deposit", sample: true, createdAt: now - 1460 },
      { id: "sample-wallet-6", amount: 8500, date: dateOffset(-31), note: "Monthly salary", sample: true, createdAt: now - 1450 },
      { id: "sample-wallet-7", amount: 600, date: dateOffset(-27), note: "Friend reimbursement", sample: true, createdAt: now - 1440 },
      { id: "sample-wallet-8", amount: 1000, date: dateOffset(-20), note: "Bank transfer", sample: true, createdAt: now - 1430 },
      { id: "sample-wallet-9", amount: 8500, date: dateOffset(-1), note: "Monthly salary", sample: true, createdAt: now - 1420 },
      { id: "sample-wallet-10", amount: 300, date: dateOffset(-1), note: "Cash reimbursement", sample: true, createdAt: now - 1410 },
      { id: "sample-wallet-11", amount: 800, date: todayISO(), note: "Side project payment", sample: true, createdAt: now - 1400 }
    ];
    const debtSamples = [
      { id: "sample-debt-1", person: "Sarah", direction: "owed-to-me", amount: 600, remaining: 250, date: dateOffset(-20), dueDate: dateOffset(10), note: "Shared dinner and taxi", settledRemaining: 250, sample: true, createdAt: now - 1200 },
      { id: "sample-debt-2", person: "Omar", direction: "i-owe", amount: 400, remaining: 400, date: dateOffset(-9), dueDate: dateOffset(5), note: "Weekend fuel advance", settledRemaining: 400, sample: true, createdAt: now - 1100 }
    ];
    const taskSamples = [
      { id: "sample-task-1", title: "Find car keys", location: "Bottom drawer · bedroom", date: todayISO(), priority: "high", done: false, sample: true, createdAt: now - 1000 },
      { id: "sample-task-2", title: "Pay apartment rent", location: "Bank app · payments", date: dateOffset(9), priority: "high", done: false, sample: true, createdAt: now - 900 },
      { id: "sample-task-3", title: "Buy replacement water filters", location: "Kitchen cupboard", date: dateOffset(4), priority: "normal", done: false, sample: true, createdAt: now - 800 },
      { id: "sample-task-4", title: "Renew internet subscription", location: "Router folder", date: dateOffset(-18), priority: "normal", done: true, sample: true, createdAt: now - 700 }
    ];
    const productSamples = [
      { id: "sample-product-milk", name: "Whole milk", category: "Groceries", unitPrice: 12.4, vat: 5, sample: true, createdAt: now - 600 },
      { id: "sample-product-vegetables", name: "Fresh vegetables", category: "Groceries", unitPrice: 46.75, vat: 5, sample: true, createdAt: now - 500 },
      { id: "sample-product-rice", name: "Rice and pantry staples", category: "Groceries", unitPrice: 112.4, vat: 5, sample: true, createdAt: now - 400 },
      { id: "sample-product-latte", name: "Iced latte", category: "Dining & Coffee", unitPrice: 24.5, vat: 5, sample: true, createdAt: now - 300 },
      { id: "sample-product-fuel", name: "Vehicle fuel", category: "Fuel & Transport", unitPrice: 4.88, vat: 0, sample: true, createdAt: now - 200 },
      { id: "sample-product-internet", name: "Internet subscription", category: "Utilities", unitPrice: 299, vat: 5, sample: true, createdAt: now - 100 },
      { id: "sample-product-shoes", name: "Running shoes", category: "Shopping", unitPrice: 480, vat: 5, sample: true, createdAt: now }
    ];
    await Promise.all([
      ...samples.map((item) => database.put("vault", item)),
      ...expenseSamples.map((item) => database.put("expenses", item)),
      ...walletSamples.map((item) => database.put("wallet", item)),
      ...debtSamples.map((item) => database.put("debts", item)),
      ...taskSamples.map((item) => database.put("tasks", item)),
      ...productSamples.map((item) => database.put("products", item)),
      database.put("meta", { key: "initialized", value: true })
    ]);
  }

  async function loadAll() {
    const [vault, expenses, shopping, wallet, debts, tasks, products, meta] = await Promise.all([
      database.all("vault"), database.all("expenses"), database.all("shopping"),
      database.all("wallet"), database.all("debts"), database.all("tasks"), database.all("products"), database.get("meta", "pro")
    ]);
    isPro = Boolean(meta?.value);
    return { vault, expenses, shopping, wallet, debts, tasks, products };
  }

  function normalizeName(name) {
    return String(name || "").toLocaleLowerCase().normalize("NFKC")
      .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  }

  function getBulkGroups(expenses) {
    const groups = new Map();
    expenses.forEach((expense) => {
      const key = normalizeName(expense.name);
      if (!key) return;
      const group = groups.get(key) || { key, name: expense.name.trim(), purchases: [], amount: 0, quantity: 0 };
      group.purchases.push(expense);
      group.amount += Number(expense.amount) || 0;
      group.quantity += Number(expense.quantity) || 0;
      if (expense.createdAt > (group.createdAt || 0)) {
        group.name = expense.name.trim();
        group.createdAt = expense.createdAt;
      }
      groups.set(key, group);
    });
    return [...groups.values()].filter((group) => group.purchases.length >= 2)
      .sort((a, b) => b.amount - a.amount);
  }

  function getOverviewRange() {
    const now = new Date();
    const today = todayISO();
    if (overviewPeriod === "all") return null;
    if (overviewPeriod === "today") return { start: today, end: today };
    if (overviewPeriod === "last-month") {
      return {
        start: dateInputValue(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        end: dateInputValue(new Date(now.getFullYear(), now.getMonth(), 0))
      };
    }
    if (overviewPeriod === "year") {
      return { start: dateInputValue(new Date(now.getFullYear(), 0, 1)), end: today };
    }
    return {
      start: $("#overview-start-date").value,
      end: $("#overview-end-date").value
    };
  }

  function isInOverviewRange(date, range) {
    return !range || ((!range.start || date >= range.start) && (!range.end || date <= range.end));
  }

  function getOverviewPresentation(range) {
    const labels = {
      all: { spend: "All-time spend", savings: "Est. bulk savings", heading: "Spending · all time", caption: "ALL TIME" },
      today: { spend: "Today's spend", savings: "Est. savings · today", heading: "Spending · today", caption: "TODAY" },
      "last-month": { spend: "Last month's spend", savings: "Est. savings · last month", heading: "Spending · last month", caption: "LAST MONTH" },
      year: { spend: "Year-to-date spend", savings: "Est. savings · year", heading: "Spending · year to date", caption: "YEAR TO DATE" },
      custom: { spend: "Selected-period spend", savings: "Est. savings · custom", heading: "Spending · custom range", caption: "CUSTOM RANGE" }
    };
    const presentation = labels[overviewPeriod];
    if (overviewPeriod === "custom" && range?.start && range?.end) {
      presentation.caption = `${localDate(range.start, { month: "short", day: "numeric" })}–${localDate(range.end, { month: "short", day: "numeric" })}`.toUpperCase();
    }
    return presentation;
  }

  function computeEstimatedSavings(expenses) {
    return getBulkGroups(expenses).reduce((sum, group) => sum + group.amount * 0.18, 0);
  }

  function getWalletSummary(wallet, expenses, range) {
    const allTimeAdded = wallet.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
    const firstFundingDate = wallet.reduce((first, entry) => !first || entry.date < first ? entry.date : first, "");
    const trackedExpenses = firstFundingDate
      ? expenses.filter((entry) => entry.date >= firstFundingDate)
      : [];
    const rangedWallet = wallet.filter((entry) => isInOverviewRange(entry.date, range));
    const rangedExpenses = trackedExpenses.filter((entry) => isInOverviewRange(entry.date, range));
    const totalAdded = range
      ? rangedWallet.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
      : allTimeAdded;
    const spent = range
      ? rangedExpenses.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
      : trackedExpenses.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
    const asOfDate = range?.end || todayISO();
    const available = range
      ? wallet.filter((entry) => entry.date <= asOfDate).reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
        - trackedExpenses.filter((entry) => entry.date <= asOfDate).reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
      : allTimeAdded - spent;
    return { totalAdded, spent, available, asOfDate };
  }

  function getDebtSummary(debts, range = null) {
    return debts.filter((debt) => Number(debt.remaining) > 0 && isInOverviewRange(debt.date, range)).reduce((summary, debt) => {
      if (debt.direction === "i-owe") {
        summary.owe += Number(debt.remaining);
        summary.oweCount += 1;
      } else {
        summary.owed += Number(debt.remaining);
        summary.owedCount += 1;
      }
      return summary;
    }, { owe: 0, owed: 0, oweCount: 0, owedCount: 0 });
  }

  function updateHeaderCount(count) {
    $("#vault-count").textContent = String(count);
  }

  function renderDashboard(data) {
    const { vault, expenses, tasks = [] } = data;
    const range = getOverviewRange();
    const overviewExpenses = expenses.filter((item) => isInOverviewRange(item.date, range));
    const overviewVault = vault.filter((item) => isInOverviewRange(item.date, range));
    const presentation = getOverviewPresentation(range);
    const activeAlerts = overviewVault.filter((item) => !item.done && dayDifference(item.date) !== null
      && dayDifference(item.date) <= 30).length;
    const spendTotal = overviewExpenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const pointsValue = overviewVault.reduce((sum, item) => sum + Number(item.value || 0), 0);
    const savings = computeEstimatedSavings(overviewExpenses);

    if ($("#urgent-value")) $("#urgent-value").textContent = String(activeAlerts);
    if ($("#spend-label")) $("#spend-label").textContent = presentation.spend;
    if ($("#spend-value")) $("#spend-value").textContent = money(spendTotal);
    if ($("#savings-label")) $("#savings-label").textContent = presentation.savings;
    if ($("#savings-value")) $("#savings-value").textContent = money(savings);
    if ($("#value-value")) $("#value-value").textContent = money(pointsValue);
    $("#dashboard-spend-title").textContent = presentation.heading;
    $("#sample-footer").hidden = ![...vault, ...expenses].some((item) => item.sample);
    updateHeaderCount(vault.length);

    const upcomingItems = [
      ...overviewVault.filter((item) => !item.done).map((item) => ({
        name: item.name,
        detail: `${item.category} · ${vaultDateLine(item)}`,
        date: item.date,
        icon: CATEGORIES.vault[item.category] || "◷"
      })),
      ...tasks.filter((task) => !task.done && task.date && isInOverviewRange(task.date, range)).map((task) => ({
        name: task.title,
        detail: `${task.location || "To-do"} · ${localDate(task.date)}`,
        date: task.date,
        icon: "✓"
      }))
    ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4);
    const upcomingList = $("#upcoming-list");
    if (!upcomingItems.length) {
      upcomingList.innerHTML = '<div class="empty-inline"><p>No reminders in this overview period.</p></div>';
    } else {
      upcomingList.innerHTML = upcomingItems.map((item) => {
        return `<div class="compact-item"><span class="compact-icon">${item.icon}</span><span class="compact-copy"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.detail)}</small></span></div>`;
      }).join("");
    }
    renderCategoryPie($("#dashboard-breakdown"), overviewExpenses, Object.keys(CATEGORIES.expense), presentation.caption);

    const walletSummary = getWalletSummary(data.wallet, expenses, range);
    const debtSummary = getDebtSummary(data.debts, range);
    $("#wallet-available").textContent = money(walletSummary.available);
    $("#wallet-out-of").textContent = range
      ? `Balance as of ${localDate(walletSummary.asOfDate)}`
      : `of ${money(walletSummary.totalAdded)} added`;
    $("#wallet-spent").textContent = money(walletSummary.spent);
    $("#wallet-added").textContent = money(walletSummary.totalAdded);
    $("#wallet-savings").textContent = money(savings);
    $("#dashboard-owe").textContent = money(debtSummary.owe);
    $("#dashboard-owed").textContent = money(debtSummary.owed);
    const metricParts = [
      ["spent", "Spent", walletSummary.spent],
      ["added", "Funds added", walletSummary.totalAdded],
      ["owe", "I owe", debtSummary.owe],
      ["owed", "Owed to me", debtSummary.owed],
      ["savings", "Estimated savings", savings]
    ];
    const metricTotal = metricParts.reduce((total, [, , amount]) => total + Math.max(0, Number(amount) || 0), 0);
    metricParts.forEach(([key, , amount]) => {
      const value = Math.max(0, Number(amount) || 0);
      const segment = $(`[data-wallet-segment="${key}"]`);
      segment.style.width = `${metricTotal ? value / metricTotal * 100 : 0}%`;
      segment.style.display = value > 0 ? "block" : "none";
    });
    $("#wallet-analytics").setAttribute("aria-label",
      `Relative metric comparison; segment widths represent ${metricParts.map(([label, name, amount]) => `${name.toLowerCase()} ${money(amount)}`).join(", ")}. These values are not a combined wallet balance.`);
    const allDebtSummary = getDebtSummary(data.debts, range);
    const openDebtCount = allDebtSummary.oweCount + allDebtSummary.owedCount;
    $("#debt-count").textContent = String(openDebtCount);

    const groups = getBulkGroups(overviewExpenses).slice(0, 2);
    const preview = $("#dashboard-savings");
    preview.innerHTML = groups.length ? groups.map((group) =>
      `<div class="mini-savings"><span class="mini-savings-icon">✳</span><span><strong>${escapeHtml(group.name)}</strong><small>${group.purchases.length} buys · ${money(group.amount * 0.18)} possible savings</small></span></div>`
    ).join("") : '<p class="muted-small">Your repeat purchases will show up here.</p>';
    renderSpendingInsights(overviewExpenses, range);
    renderDashboardSummary(overviewExpenses, range, presentation);
  }

  function renderDashboardSummary(expenses, range, presentation) {
    const spent = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
    $("#dashboard-month-spend").textContent = money(spent);
    const summaryLabel = $(".summary-primary .eyebrow");
    if (summaryLabel) summaryLabel.textContent = presentation?.caption || "THIS MONTH";

    const budgets = getBudgetPreferences();
    const limits = Object.values(budgets).map(Number).filter((limit) => limit > 0);
    const budgetTotal = limits.reduce((sum, limit) => sum + limit, 0);
    const progress = $("#dashboard-budget-progress");
    if (range) {
      $("#dashboard-budget-remaining").textContent = `${expenses.length} transaction${expenses.length === 1 ? "" : "s"} in this period`;
      progress.style.width = "0";
      progress.classList.remove("over");
    } else if (budgetTotal > 0) {
      const percentage = budgetTotal ? Math.min(100, spent / budgetTotal * 100) : 0;
      const remaining = budgetTotal - spent;
      $("#dashboard-budget-remaining").textContent = remaining >= 0
        ? `${money(remaining)} remaining across monthly budgets`
        : `${money(Math.abs(remaining))} over monthly budgets`;
      progress.style.width = `${percentage}%`;
      progress.classList.toggle("over", remaining < 0);
    } else {
      $("#dashboard-budget-remaining").textContent = "Set category budgets in Settings";
      progress.style.width = "0";
    }

    const categoryTotals = new Map();
    expenses.forEach((expense) => categoryTotals.set(expense.category,
      (categoryTotals.get(expense.category) || 0) + Number(expense.amount || 0)));
    const topCategory = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topCategory) {
      $("#dashboard-primary-insight").textContent = `${topCategory[0]} is the largest category`;
      $("#dashboard-primary-detail").textContent = `${money(topCategory[1])} spent · ${spent ? Math.round(topCategory[1] / spent * 100) : 0}% of selected-period spending`;
    } else {
      $("#dashboard-primary-insight").textContent = "No spending in this period";
      $("#dashboard-primary-detail").textContent = "Add an expense to begin your spending pattern analysis.";
    }
  }

  function renderSpendingInsights(expenses, range) {
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    const toISO = (date) => dateInputValue(date);

    const currentMonth = expenses;
    const previousMonth = range ? [] : expenses.filter((expense) =>
      expense.date >= toISO(previousMonthStart) && expense.date <= toISO(previousMonthEnd)
    );
    const currentTotal = currentMonth.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
    const previousTotal = previousMonth.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
    const monthDifference = previousTotal ? (currentTotal - previousTotal) / previousTotal * 100 : 0;
    const weeklyTotals = [];
    if (!range) {
      for (let offset = 21; offset >= 0; offset -= 7) {
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - offset);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        weeklyTotals.push(expenses
          .filter((expense) => expense.date >= dateInputValue(weekStart) && expense.date <= dateInputValue(weekEnd))
          .reduce((sum, expense) => sum + Number(expense.amount || 0), 0));
      }
    }
    let savingsStreak = 0;
    for (let index = weeklyTotals.length - 1; index > 0; index -= 1) {
      if (weeklyTotals[index] <= weeklyTotals[index - 1]) savingsStreak += 1;
      else break;
    }

    const categoryTotals = new Map();
    currentMonth.forEach((expense) => {
      categoryTotals.set(expense.category, (categoryTotals.get(expense.category) || 0) + Number(expense.amount || 0));
    });
    const topCategory = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1])[0];

    const budgets = getBudgetPreferences();
    const overspent = Object.entries(budgets).filter(([category, limit]) =>
      Number(limit) > 0
      && (categoryTotals.get(category) || 0) > Number(limit)
    );

    const coach = [];
    if (previousTotal > 0) {
      coach.push({
        icon: monthDifference <= 0 ? "↘" : "↗",
        title: monthDifference <= 0
          ? `Spending is ${Math.abs(Math.round(monthDifference))}% lower than last month`
          : `Spending is ${Math.round(monthDifference)}% higher than last month`,
        detail: monthDifference <= 0
          ? `${money(previousTotal - currentTotal)} kept from spending`
          : `Review recent purchases to get back on track`
      });
    }
    if (savingsStreak > 0) {
      coach.unshift({
        icon: "★",
        title: `${savingsStreak}-week spending streak`,
        detail: "You spent less than the previous week. Keep the habit going."
      });
    }
    if (topCategory) {
      const share = currentTotal ? Math.round(topCategory[1] / currentTotal * 100) : 0;
      coach.push({
        icon: "◫",
        title: `${topCategory[0]} is your largest spending category`,
        detail: `${money(topCategory[1])} · ${share}% of selected-period spending`
      });
    }
    if (overspent.length) {
      overspent.slice(0, 2).forEach(([category, limit]) => {
        coach.push({
          icon: "!",
          title: `${category} budget exceeded`,
          detail: `${money((categoryTotals.get(category) || 0) - Number(limit))} over your ${money(limit)} limit`
        });
      });
    }
    const dining = currentMonth.filter((expense) => expense.category === "Dining & Coffee");
    if (dining.length >= 3) {
      const diningTotal = dining.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
      coach.push({
        icon: "☕",
        title: "Small dining purchases can add up",
        detail: `${dining.length} purchases · about ${money(diningTotal * 0.18)} could be saved`
      });
    }
    if (!coach.length) {
      coach.push({ icon: "✓", title: "Your spending coach is ready", detail: "Add expenses to start seeing personalized insights" });
    }

    $("#spending-coach").innerHTML = coach.slice(0, 2).map((insight) =>
      `<div class="coach-insight"><span class="coach-insight-icon">${insight.icon}</span><span><strong>${escapeHtml(insight.title)}</strong><small>${escapeHtml(insight.detail)}</small></span></div>`
    ).join("");

    const vendorTotals = new Map();
    expenses.forEach((expense) => {
      if (!expense.vendor) return;
      const vendor = expense.vendor.trim();
      vendorTotals.set(vendor, (vendorTotals.get(vendor) || 0) + Number(expense.amount || 0));
    });
    const vendors = [...vendorTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    $("#vendor-ranking").innerHTML = vendors.length
      ? vendors.map(([vendor, amount], index) =>
        `<div class="vendor-row"><span class="vendor-rank">${index + 1}</span><span><strong>${escapeHtml(vendor)}</strong><small>Tracked spending</small></span><strong class="vendor-amount">${money(amount)}</strong></div>`
      ).join("")
      : '<p class="muted-small">Add a vendor or shop to each expense to see rankings.</p>';
  }

  function renderCategoryPie(container, expenses, categories, caption) {
    const sums = new Map(categories.map((category) => [category, 0]));
    expenses.forEach((expense) => sums.set(expense.category, (sums.get(expense.category) || 0) + Number(expense.amount || 0)));
    const colors = ["#806ef0", "#43aa8c", "#6395e7", "#e0a544", "#dc6b87"];
    const rows = categories.map((category, index) => ({
      category,
      amount: sums.get(category) || 0,
      color: colors[index % colors.length]
    }));
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    const activeRows = rows.filter((row) => row.amount > 0);
    let offset = 0;
    const segments = activeRows.map((row) => {
      const start = offset;
      offset += row.amount / total * 100;
      return `${row.color} ${start}% ${offset}%`;
    });

    container.classList.add("pie-breakdown");
    container.replaceChildren();

    const chart = document.createElement("div");
    chart.className = "pie-chart";
    chart.setAttribute("role", "img");
    chart.setAttribute("aria-label", total
      ? `Spending breakdown. ${activeRows.map((row) => `${row.category}: ${money(row.amount)}`).join(", ")}. Total ${money(total)}.`
      : "No spending in this range.");
    chart.style.setProperty("--pie-gradient", total
      ? `conic-gradient(${segments.join(",")})`
      : "conic-gradient(var(--pie-empty) 0% 100%)");

    const center = document.createElement("div");
    center.className = "pie-center";
    const centerLabel = document.createElement("span");
    centerLabel.textContent = caption;
    const centerTotal = document.createElement("strong");
    centerTotal.textContent = money(total);
    center.append(centerLabel, centerTotal);
    chart.append(center);
    container.append(chart);

    const legend = document.createElement("div");
    legend.className = "pie-legend";
    if (!activeRows.length) {
      const empty = document.createElement("p");
      empty.className = "pie-empty";
      empty.textContent = "No spending in this range.";
      legend.append(empty);
    } else {
      activeRows.forEach((row) => {
        const entry = document.createElement("div");
        entry.className = "pie-legend-row";
        const dot = document.createElement("span");
        dot.className = "pie-dot";
        dot.style.backgroundColor = row.color;
        const label = document.createElement("span");
        label.className = "pie-legend-label";
        const name = document.createElement("strong");
        name.textContent = row.category;
        label.append(name);
        const amount = document.createElement("b");
        amount.textContent = money(row.amount);
        entry.append(dot, label, amount);
        legend.append(entry);
      });
    }
    container.append(legend);
  }

  function updateThemeToggle() {
    const toggle = $(".theme-toggle");
    $(".theme-icon", toggle).textContent = darkMode ? "☀" : "☾";
    toggle.setAttribute("aria-pressed", String(darkMode));
    toggle.setAttribute("aria-label", `Switch to ${darkMode ? "light" : "dark"} mode`);
    toggle.title = `${darkMode ? "Light" : "Dark"} mode is available`;
    document.documentElement.style.backgroundColor = darkMode ? "#171824" : "#f5f6fa";
    $('meta[name="theme-color"]').content = darkMode ? "#171824" : "#f5f6fa";
  }

  function renderVault(vault) {
    const query = $("#vault-search").value.trim().toLocaleLowerCase();
    const category = $("#vault-filter").value;
    const filtered = vault.filter((item) => (category === "all" || item.category === category)
      && `${item.name} ${item.category} ${item.reference || ""} ${item.notes || ""}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => Number(a.done) - Number(b.done) || a.date.localeCompare(b.date));
    $("#vault-results").textContent = `${filtered.length} item${filtered.length === 1 ? "" : "s"}`;
    $("#vault-empty").hidden = filtered.length !== 0;
    const list = $("#vault-list");
    list.replaceChildren();
    const template = $("#vault-card-template");
    filtered.forEach((item) => {
      const card = template.content.firstElementChild.cloneNode(true);
      card.dataset.id = item.id;
      $(".category-icon", card).textContent = CATEGORIES.vault[item.category] || "◷";
      $(".vault-category", card).textContent = item.category;
      $(".vault-name", card).textContent = item.name;
      $(".vault-date", card).textContent = vaultDateLine(item);
      const location = $(".vault-location", card);
      location.textContent = item.location ? `Stored at · ${item.location}` : "";
      const urgency = getUrgency(item.date, item.done);
      const badge = $(".urgency-badge", card);
      badge.className = `urgency-badge ${urgency.className}`;
      badge.textContent = urgency.text;
      $(".vault-reference", card).textContent = item.reference ? `Ref · ${item.reference}` : "";
      $(".vault-notes", card).textContent = item.notes || "";
      const value = $(".vault-card-value", card);
      if (Number(item.value) > 0) {
        value.hidden = false;
        value.textContent = `Estimated value · ${money(item.value)}`;
      }
      const doneButton = $(".done-action", card);
      doneButton.querySelector("span").textContent = item.done ? "Undo" : item.category === "Events" ? "Done" : "Renew";
      doneButton.title = item.done ? "Reopen item" : item.category === "Events" ? "Mark as done" : "Renew item";
      if (item.done) $(".calendar-action", card).disabled = true;
      list.append(card);
    });
  }

  function getChartExpenses(expenses) {
    const period = $("#chart-period").value;
    const today = todayISO();
    const now = new Date();
    let start = today;
    let end = today;
    let caption = "TODAY";
    if (period === "month") {
      start = dateInputValue(new Date(now.getFullYear(), now.getMonth(), 1));
      caption = "THIS MONTH";
    } else if (period === "year") {
      start = dateInputValue(new Date(now.getFullYear(), 0, 1));
      caption = "THIS YEAR";
    } else if (period === "custom") {
      start = $("#chart-start-date").value;
      end = $("#chart-end-date").value;
      caption = "CUSTOM RANGE";
    }

    const validRange = Boolean(start && end && start <= end);
    const category = $("#chart-category").value;
    const filtered = validRange ? expenses.filter((item) => item.date >= start && item.date <= end
      && (category === "all" || item.category === category)) : [];
    return { expenses: filtered, caption, validRange, period };
  }

  function renderExpenses(expenses) {
    const chart = getChartExpenses(expenses);
    const total = chart.expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    $("#expense-month-total").textContent = money(total);
    $("#expense-period-caption").textContent = chart.caption;
    $("#expense-entry-count").textContent = chart.validRange
      ? `${chart.expenses.length} transaction${chart.expenses.length === 1 ? "" : "s"}`
      : chart.period === "custom" && (!$("#chart-start-date").value || !$("#chart-end-date").value)
        ? "Choose dates to see this range" : "Choose a valid date range";
    $("#chart-date-range").hidden = chart.period !== "custom";
    renderCategoryPie($("#expense-breakdown"), chart.expenses, Object.keys(CATEGORIES.expense), chart.caption);

    const query = $("#expense-search").value.trim().toLocaleLowerCase();
    const category = $("#expense-filter").value;
    const filtered = expenses.filter((item) => (category === "all" || item.category === category)
      && `${item.name} ${item.category}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
    $("#expense-results").textContent = `${filtered.length} entr${filtered.length === 1 ? "y" : "ies"}`;
    $("#expense-empty").hidden = filtered.length !== 0;
    const list = $("#expense-list");
    list.replaceChildren();
    filtered.forEach((item) => {
      const row = document.createElement("article");
      row.className = "expense-row";
      row.dataset.id = item.id;
      const categoryIcon = CATEGORIES.expense[item.category] || "↗";
      row.innerHTML = `
        <div class="expense-primary"><span class="expense-emoji">${categoryIcon}</span><span class="expense-copy"><strong></strong><small></small></span></div>
        <span class="expense-cell">${escapeHtml(item.category)}</span>
        <span class="expense-cell">${escapeHtml(localDate(item.date))}</span>
        <span class="expense-cell">${Number(item.quantity) || 1} unit${Number(item.quantity) === 1 ? "" : "s"}</span>
        <strong class="expense-amount">${money(item.amount)}</strong>
        <div class="expense-actions">
          ${item.receipt ? '<button class="mini-action" data-expense-action="receipt" title="View receipt">▧ <span>Receipt</span></button>' : ""}
          <button class="mini-action" data-expense-action="edit" title="Edit expense">✎ <span>Edit</span></button>
          <button class="mini-action delete-action" data-expense-action="delete" title="Delete expense">⌫ <span>Delete</span></button>
        </div>`;
      $(".expense-copy strong", row).textContent = item.name;
      $(".expense-copy small", row).textContent = item.sample ? `${item.category} · Sample record` : item.category;
      list.append(row);
    });
  }

  function renderWalletLedger(wallet) {
    const list = $("#wallet-ledger");
    const entries = [...wallet].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "ledger-empty";
      empty.textContent = "No funds added yet. Add a balance to start tracking wallet availability.";
      list.append(empty);
      return;
    }
    entries.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "wallet-ledger-row";
      row.dataset.id = entry.id;
      row.innerHTML = `
        <span class="ledger-icon">＋</span>
        <span class="ledger-copy"><strong></strong><small></small></span>
        <strong class="ledger-amount"></strong>
        <button class="mini-action" data-wallet-action="edit" title="Edit funds entry" aria-label="Edit funds entry">✎</button>
        <button class="mini-action delete-action" data-wallet-action="delete" title="Delete funds entry" aria-label="Delete funds entry">⌫</button>`;
      $(".ledger-copy strong", row).textContent = entry.note || "Funds added";
      $(".ledger-copy small", row).textContent = localDate(entry.date);
      $(".ledger-amount", row).textContent = `+${money(entry.amount)}`;
      list.append(row);
    });
  }

  function renderDebts(debts) {
    const totals = getDebtSummary(debts);
    $("#debts-owe-total").textContent = money(totals.owe);
    $("#debts-owed-total").textContent = money(totals.owed);
    $("#debts-owe-count").textContent = `${totals.oweCount} open`;
    $("#debts-owed-count").textContent = `${totals.owedCount} open`;

    const query = $("#debt-search").value.trim().toLocaleLowerCase();
    const filter = $("#debt-filter").value;
    const filtered = debts.filter((debt) => {
      const settled = Number(debt.remaining) <= 0;
      const matchesFilter = filter === "all" || (filter === "settled" ? settled : debt.direction === filter);
      return matchesFilter && `${debt.person} ${debt.note || ""}`.toLocaleLowerCase().includes(query);
    }).sort((a, b) => Number(a.remaining <= 0) - Number(b.remaining <= 0)
      || (a.dueDate || a.date).localeCompare(b.dueDate || b.date));

    $("#debt-results").textContent = `${filtered.length} record${filtered.length === 1 ? "" : "s"}`;
    $("#debt-empty").hidden = filtered.length !== 0;
    const list = $("#debt-list");
    list.replaceChildren();
    filtered.forEach((debt) => {
      const settled = Number(debt.remaining) <= 0;
      const card = document.createElement("article");
      card.className = "panel debt-card";
      card.dataset.id = debt.id;
      card.innerHTML = `
        <div class="debt-card-heading"><span class="debt-total-icon ${debt.direction === "i-owe" ? "owe-icon" : "owed-icon"}">${debt.direction === "i-owe" ? "↗" : "↙"}</span><span class="debt-person"><strong></strong><small></small></span><span class="debt-status ${settled ? "settled" : ""}">${settled ? "Settled" : "Open"}</span></div>
        <div class="debt-card-amounts"><span>Outstanding<strong></strong></span><span>Original<strong></strong></span></div>
        <p class="debt-card-dates"></p><p class="debt-card-note"></p>
        <div class="card-actions">
          <button class="mini-action" data-debt-action="edit" title="Edit debt">✎ <span>Edit</span></button>
          <button class="mini-action done-action" data-debt-action="settle" title="${settled ? "Reopen debt" : "Mark debt as settled"}">${settled ? "↶" : "✓"} <span>${settled ? "Reopen" : "Settle"}</span></button>
          <button class="mini-action delete-action" data-debt-action="delete" title="Delete debt">⌫ <span>Delete</span></button>
        </div>`;
      $(".debt-person strong", card).textContent = debt.person;
      $(".debt-person small", card).textContent = debt.direction === "i-owe" ? "I borrowed / I owe" : "Owed to me";
      $(".debt-card-amounts span:first-child strong", card).textContent = money(debt.remaining);
      $(".debt-card-amounts span:last-child strong", card).textContent = money(debt.amount);
      $(".debt-card-dates", card).textContent = debt.dueDate
        ? `Recorded ${localDate(debt.date)} · Due ${localDate(debt.dueDate)}`
        : `Recorded ${localDate(debt.date)}`;
      $(".debt-card-note", card).textContent = debt.note || "";
      list.append(card);
    });
  }

  async function renderBulk(data) {
    const groups = getBulkGroups(data.expenses);
    $("#bulk-results").textContent = `${groups.length} suggestion${groups.length === 1 ? "" : "s"}`;
    $("#bulk-empty").hidden = groups.length !== 0;
    const list = $("#bulk-list");
    list.replaceChildren();
    groups.forEach((group) => {
      const card = document.createElement("article");
      card.className = "panel bulk-card";
      card.dataset.key = group.key;
      card.innerHTML = `
        <div class="bulk-top"><div class="bulk-product"><span class="compact-icon">✳</span><span><strong></strong><small></small></span></div><span class="save-chip">18% EST. SAVE</span></div>
        <div class="bulk-metrics"><span>Purchases<strong>${group.purchases.length}</strong></span><span>Total units<strong>${group.quantity}</strong></span><span>Total spent<strong>${money(group.amount)}</strong></span></div>
        <p class="bulk-recommendation"></p><button class="button button-secondary add-shopping" data-bulk-key="${escapeHtml(group.key)}">＋ Add to bulk shopping list</button>`;
      $("strong", card).textContent = group.name;
      $(".bulk-product small", card).textContent = group.purchases.length >= 3 ? "A regular repeat buy" : "You bought this more than once";
      $(".bulk-recommendation", card).textContent = `Consider a monthly bulk pack. At an illustrative 18% discount, you could save about ${money(group.amount * 0.18)} on similar purchases.`;
      list.append(card);
    });
    const shopping = $("#shopping-list");
    shopping.replaceChildren();
    if (!data.shopping.length) {
      shopping.innerHTML = '<div class="shopping-empty">Your shopping list is empty. Add a stock-up suggestion to get started.</div>';
      return;
    }
    data.shopping.sort((a, b) => Number(a.done) - Number(b.done)).forEach((item) => {
      const row = document.createElement("label");
      row.className = "shopping-row";
      row.innerHTML = `<input type="checkbox" ${item.done ? "checked" : ""} aria-label="Mark ${escapeHtml(item.name)} as ${item.done ? "not done" : "done"}"><span>${escapeHtml(item.name)}</span><small>${item.frequency} past buys</small><button type="button" class="mini-action delete-action" data-shopping-remove="${escapeHtml(item.id)}" aria-label="Remove ${escapeHtml(item.name)}">⌫</button>`;
      $("input", row).addEventListener("change", async (event) => {
        try {
          await database.put("shopping", { ...item, done: event.target.checked });
          await refresh();
        } catch (error) { reportError(error, "Could not update the shopping list"); }
      });
      shopping.append(row);
    });
  }

  function updateCurrencyLabels() {
    $$(".form-currency").forEach((element) => { element.textContent = currency; });
  }

  function getBudgetPreferences() {
    try { return JSON.parse(localStorage.getItem("lifevault-budgets") || "{}"); }
    catch { return {}; }
  }

  function renderBudgetSettings(expenses) {
    const container = $("#budget-settings");
    if (!container) return;
    const budgets = getBudgetPreferences();
    container.innerHTML = Object.keys(CATEGORIES.expense).map((category) => `
      <label>${escapeHtml(category)}<input type="number" min="0" step="1" data-budget-category="${escapeHtml(category)}" value="${Number(budgets[category] || 0)}" aria-label="${escapeHtml(category)} monthly budget"></label>
    `).join("");
  }

  function renderBudgetProgress(expenses) {
    const budgets = getBudgetPreferences();
    const month = todayISO().slice(0, 7);
    const active = Object.entries(budgets).filter(([, limit]) => Number(limit) > 0);
    const panel = $("#budget-progress-panel");
    if (!panel) return;
    panel.hidden = active.length === 0;
    $("#budget-progress").innerHTML = active.map(([category, limit]) => {
      const spent = expenses.filter((expense) => expense.category === category && expense.date.startsWith(month))
        .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
      const percentage = Math.min(100, Math.round(spent / Number(limit) * 100));
      return `<div class="budget-bar"><div><strong>${escapeHtml(category)}</strong><span>${money(spent)} / ${money(limit)}</span></div><div class="bar-track"><div class="bar-fill${percentage >= 100 ? " budget-over" : ""}" style="width:${percentage}%"></div></div></div>`;
    }).join("");
  }

  async function refresh() {
    const data = await loadAll();
    homeVault = data.vault;
    updateHomeClock(data.vault);
    renderBudgetSettings(data.expenses);
    renderDashboard(data);
    arrangeDashboardLayout();
    renderVault(data.vault);
    renderExpenses(data.expenses);
    renderBudgetProgress(data.expenses);
    renderWalletLedger(data.wallet);
    renderDebts(data.debts);
    renderTasks(data.tasks);
    await renderBulk(data);
    $("#license-status").textContent = isPro
      ? "LifeVault Pro is active on this device. Your local records are unlimited."
      : `Free plan · ${getRecordCount(data)} of ${FREE_LIMIT} records used on this device.`;
    updateCurrencyLabels();
  }

  function getRecordCount(data) {
    return data.vault.length + data.expenses.length + data.wallet.length + data.debts.length + (data.tasks?.length || 0) + (data.products?.length || 0);
  }

  function arrangeDashboardLayout() {
    const dashboard = $("#view-dashboard");
    const wallet = $(".finance-overview-grid", dashboard);
    const insights = $(".spending-insights-grid", dashboard);
    const sampleFooter = $("#sample-footer");
    if (dashboard && wallet && insights && sampleFooter) {
      dashboard.insertBefore(wallet, sampleFooter);
    }
  }

  function setView(view) {
    const validViews = ["dashboard", "vault", "expenses", "debts", "tasks", "bulk", "settings"];
    if (!validViews.includes(view)) return;
    currentView = view;
    $$(".view").forEach((section) => section.classList.toggle("active", section.id === `view-${view}`));
    $$("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    $("#page-title").textContent = ({
      dashboard: "Overview", vault: "Life admin", expenses: "Expenses",
      debts: "Debts", bulk: "Smart savings", settings: "Data & settings"
    })[view];
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showDialog(dialog) {
    if (!dialog.open) dialog.showModal();
  }

  function openVaultForm(item) {
    const form = $("#vault-form");
    $("#dialog-title").textContent = item ? "Edit vault item" : "Add to your vault";
    $("#dialog-eyebrow").textContent = item ? "UPDATE LIFE ADMIN" : "LIFE ADMIN";
    form.hidden = false;
    $("#expense-form").hidden = true;
    form.reset();
    form.elements.id.value = item?.id || "";
    form.elements.name.value = item?.name || "";
    form.elements.category.value = item?.category || "IDs & travel";
    form.elements.date.value = item?.date || todayISO();
    form.elements.time.value = item?.time || "";
    form.elements.recurrence.value = item?.recurrence || "none";
    form.elements.location.value = item?.location || "";
    form.elements.reference.value = item?.reference || "";
    form.elements.value.value = item?.value || "";
    form.elements.notes.value = item?.notes || "";
    showDialog($("#item-dialog"));
    form.elements.name.focus();
  }

  async function showReceiptPreview(file) {
    if (receiptObjectUrl) URL.revokeObjectURL(receiptObjectUrl);
    receiptObjectUrl = file ? URL.createObjectURL(file) : null;
    const preview = $("#receipt-preview");
    preview.hidden = !file;
    preview.replaceChildren();
    if (!file) return;
    const image = document.createElement("img");
    image.src = receiptObjectUrl;
    image.alt = "Selected receipt preview";
    const name = document.createElement("span");
    name.textContent = file.name || "Attached receipt";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.action = "remove-receipt";
    remove.textContent = "Remove";
    preview.append(image, name, remove);
  }

  function updateExpenseTotal() {
    const form = $("#expense-form");
    const quantity = Number(form.elements.quantity.value) || 0;
    const unitPrice = Number(form.elements.unitPrice.value) || 0;
    const vat = Number(form.elements.vat.value) || 0;
    if (quantity > 0 && unitPrice >= 0) {
      form.elements.amount.value = (quantity * unitPrice * (1 + vat / 100)).toFixed(2);
      form.elements.amount.dataset.autoCalculated = "1";
    }
  }

  async function openExpenseForm(item) {
    const form = $("#expense-form");
    $("#dialog-title").textContent = item ? "Edit expense" : "Add an expense";
    $("#dialog-eyebrow").textContent = item ? "UPDATE EXPENSE" : "YOUR EXPENSES";
    $("#vault-form").hidden = true;
    form.hidden = false;
    form.reset();
    expenseReceipt = item?.receipt || null;
    form.elements.id.value = item?.id || "";
    form.elements.name.value = item?.name || "";
    form.elements.category.value = item?.category || "Groceries";
    form.elements.vendor.value = item?.vendor || "";
    const products = await database.all("products");
    const productSelect = form.elements.product;
    productSelect.replaceChildren(new Option("Choose saved product", ""));
    products.filter((product) => !item || product.category === item.category).sort((a, b) => a.name.localeCompare(b.name)).forEach((product) => {
      productSelect.add(new Option(product.name, product.id));
    });
    if (item?.productId) productSelect.value = item.productId;
    form.elements.amount.value = item?.amount ?? "";
    form.elements.quantity.value = item?.quantity ?? 1;
    form.elements.unitPrice.value = item?.unitPrice ?? (item?.amount && item?.quantity ? (Number(item.amount) / Number(item.quantity)).toFixed(2) : "");
    form.elements.vat.value = item?.vat ?? 0;
    form.elements.date.value = item?.date || todayISO();
    $("#ocr-status").textContent = "";
    detectedReceiptItems = [];
    $("#detected-items").hidden = true;
    $("#detected-items").replaceChildren();
    await showReceiptPreview(expenseReceipt);
    showDialog($("#item-dialog"));
    form.elements.name.focus();
  }

  function closeDialogs() {
    $$("dialog[open]").forEach((dialog) => dialog.close());
    if (receiptObjectUrl) URL.revokeObjectURL(receiptObjectUrl);
    receiptObjectUrl = null;
    if (taskPhotoObjectUrl) URL.revokeObjectURL(taskPhotoObjectUrl);
    taskPhotoObjectUrl = null;
    expenseReceipt = null;
    detectedReceiptItems = [];
    $("#ocr-status").textContent = "";
  }

  async function canAddRecord() {
    if (isPro) return true;
    const [vault, expenses, wallet, debts, tasks, products] = await Promise.all([
      database.all("vault"), database.all("expenses"), database.all("wallet"), database.all("debts"), database.all("tasks"), database.all("products")
    ]);
    if (getRecordCount({ vault, expenses, wallet, debts, tasks, products }) < FREE_LIMIT) return true;
    showDialog($("#upgrade-dialog"));
    showToast(`The free plan includes ${FREE_LIMIT} records. Upgrade to Pro to add more.`, "error");
    return false;
  }

  function openWalletForm(entry) {
    const form = $("#wallet-form");
    $("#debt-form").hidden = true;
    form.hidden = false;
    $("#finance-dialog-title").textContent = entry ? "Edit funds entry" : "Add funds";
    $("#finance-dialog-eyebrow").textContent = "YOUR WALLET";
    form.reset();
    form.elements.id.value = entry?.id || "";
    form.elements.amount.value = entry?.amount ?? "";
    form.elements.date.value = entry?.date || todayISO();
    form.elements.note.value = entry?.note || "";
    showDialog($("#finance-dialog"));
  }

  function openDebtForm(debt) {
    const form = $("#debt-form");
    $("#wallet-form").hidden = true;
    form.hidden = false;
    $("#finance-dialog-title").textContent = debt ? "Edit debt" : "Add a debt";
    $("#finance-dialog-eyebrow").textContent = "DEBT TRACKER";
    form.reset();
    form.elements.id.value = debt?.id || "";
    form.elements.direction.value = debt?.direction || "i-owe";
    form.elements.person.value = debt?.person || "";
    form.elements.amount.value = debt?.amount ?? "";
    form.elements.remaining.value = debt?.remaining ?? "";
    form.elements.date.value = debt?.date || todayISO();
    form.elements.dueDate.value = debt?.dueDate || "";
    form.elements.note.value = debt?.note || "";
    showDialog($("#finance-dialog"));
    form.elements.person.focus();
  }

  async function showTaskPhoto(file) {
    if (taskPhotoObjectUrl) URL.revokeObjectURL(taskPhotoObjectUrl);
    taskPhotoObjectUrl = file ? URL.createObjectURL(file) : null;
    const preview = $("#task-photo-preview");
    preview.hidden = !file;
    preview.replaceChildren();
    if (!file) return;
    const image = document.createElement("img");
    image.src = taskPhotoObjectUrl;
    image.alt = "Task reminder photo";
    const name = document.createElement("span");
    name.textContent = file.name || "Captured photo";
    preview.append(image, name);
  }

  async function openTaskForm(task) {
    const form = $("#task-form");
    $("#task-dialog-title").textContent = task ? "Edit reminder" : "Add a task";
    $("#task-dialog-eyebrow").textContent = task ? "UPDATE REMINDER" : "QUICK REMINDER";
    form.reset();
    form.elements.id.value = task?.id || "";
    form.elements.title.value = task?.title || "";
    form.elements.date.value = task?.date || "";
    form.elements.priority.value = task?.priority || "normal";
    form.elements.location.value = task?.location || "";
    taskPhoto = task?.photo || null;
    await showTaskPhoto(taskPhoto);
    showDialog($("#task-dialog"));
    form.elements.title.focus();
  }

  async function saveTask(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    if (!id && !(await canAddRecord())) return;
    const existing = id ? await database.get("tasks", id) : null;
    const selectedPhoto = form.elements.photo.files[0];
    const task = {
      id: id || makeId(),
      title: form.elements.title.value.trim(),
      date: form.elements.date.value,
      priority: form.elements.priority.value,
      location: form.elements.location.value.trim(),
      photo: selectedPhoto || taskPhoto || null,
      done: existing?.done || false,
      createdAt: existing?.createdAt || Date.now()
    };
    await database.put("tasks", task);
    taskPhoto = null;
    closeDialogs();
    await refresh();
    showToast(id ? "Reminder updated." : "Reminder added.");
  }

  function renderTasks(tasks) {
    const query = $("#task-search").value.trim().toLocaleLowerCase();
    const filter = $("#task-filter").value;
    const filtered = tasks.filter((task) =>
      (filter === "all" || (filter === "done" ? task.done : !task.done))
      && `${task.title} ${task.location || ""}`.toLocaleLowerCase().includes(query)
    ).sort((a, b) => Number(a.done) - Number(b.done) || a.createdAt - b.createdAt);
    $("#task-count").textContent = String(tasks.filter((task) => !task.done).length);
    $("#task-empty").hidden = filtered.length !== 0;
    const list = $("#task-list");
    list.replaceChildren();
    filtered.forEach((task) => {
      const row = document.createElement("div");
      row.className = `task-row${task.done ? " done" : ""}`;
      row.dataset.id = task.id;
      const details = [task.location, task.date ? localDate(task.date) : "", task.priority === "high" ? "High priority" : ""].filter(Boolean).join(" · ");
      row.innerHTML = `
        <input class="task-check" type="checkbox" ${task.done ? "checked" : ""} aria-label="Mark ${escapeHtml(task.title)} as ${task.done ? "not done" : "done"}">
        <span class="task-copy"><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(details || "No extra details")}</small></span>
        <span class="task-actions">${task.photo ? '<button class="mini-action" data-task-action="photo" aria-label="View photo">▧</button>' : ""}<button class="mini-action" data-task-action="edit" aria-label="Edit task">✎</button><button class="mini-action delete-action" data-task-action="delete" aria-label="Delete task">⌫</button></span>`;
      list.append(row);
    });
  }

  function openQuickAdd() {
    const choice = document.createElement("dialog");
    choice.className = "app-dialog compact-dialog";
    choice.innerHTML = `<button class="icon-button dialog-close modal-x" aria-label="Close dialog">×</button><div class="upgrade-mark">＋</div><p class="eyebrow">MAKE A NOTE OF IT</p><h2>What would you like to add?</h2><p class="upgrade-copy">Choose where this belongs in your LifeVault.</p><div class="quick-choice"><button class="button button-primary" data-choice="vault">▤ &nbsp; Life admin item</button><button class="button button-secondary" data-choice="task">✓ &nbsp; Quick reminder</button><button class="button button-secondary" data-choice="expense">↗ &nbsp; Expense</button></div>`;
    document.body.append(choice);
    choice.addEventListener("click", async (event) => {
      if (event.target === choice || event.target.closest(".modal-x")) {
        choice.close();
        choice.remove();
      }
      const button = event.target.closest("[data-choice]");
      if (!button) return;
      const allowed = await canAddRecord();
      choice.close();
      choice.remove();
      if (allowed) {
        if (button.dataset.choice === "vault") openVaultForm();
        else if (button.dataset.choice === "task") openTaskForm();
        else openExpenseForm();
      }
    });
    choice.addEventListener("close", () => choice.remove(), { once: true });
    showDialog(choice);
  }

  async function saveVault(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    if (!id && !(await canAddRecord())) return;
    const existing = id ? await database.get("vault", id) : null;
    const item = {
      id: id || makeId(),
      name: form.elements.name.value.trim(),
      category: form.elements.category.value,
      vendor: form.elements.vendor.value.trim(),
      date: form.elements.date.value,
      time: form.elements.time.value,
      recurrence: form.elements.recurrence.value,
      location: form.elements.location.value.trim(),
      reference: form.elements.reference.value.trim(),
      value: Number(form.elements.value.value) || 0,
      notes: form.elements.notes.value.trim(),
      done: existing?.done || false,
      sample: existing?.sample || false,
      createdAt: existing?.createdAt || Date.now()
    };
    await database.put("vault", item);
    closeDialogs();
    await refresh();
    showToast(id ? "Vault item updated." : "Added to your vault.");
  }

  async function saveExpense(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    if (!id && !(await canAddRecord())) return;
    const existing = id ? await database.get("expenses", id) : null;
    const quantity = Number(form.elements.quantity.value) || 1;
    const unitPrice = Number(form.elements.unitPrice.value) || 0;
    const vat = Number(form.elements.vat.value) || 0;
    const calculatedSubtotal = quantity * unitPrice;
    const calculatedTotal = calculatedSubtotal * (1 + vat / 100);
    let amount = Number(form.elements.amount.value) || 0;
    if (unitPrice > 0 && (!amount || Number(form.elements.amount.dataset.autoCalculated) === 1)) {
      amount = calculatedTotal;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast("Enter a valid expense total.", "error");
      return;
    }
    form.elements.amount.value = amount.toFixed(2);
    const name = form.elements.name.value.trim();
    if (!name) {
      showToast("Choose or enter an item or merchant name.", "error");
      return;
    }
    const products = await database.all("products");
    const knownProduct = products.find((product) => product.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (!id && !knownProduct && window.confirm(`"${name}" is not in the saved product list. Add it for future expenses?`)) {
      await database.put("products", {
        id: makeId(),
        name,
        category: form.elements.category.value,
        unitPrice,
        vat,
        createdAt: Date.now()
      });
    }
    if (knownProduct) {
      await database.put("products", {
        ...knownProduct,
        category: form.elements.category.value,
        unitPrice: unitPrice || knownProduct.unitPrice || 0,
        vat: vat || knownProduct.vat || 0
      });
    }
    if (!id) {
      const duplicate = (await database.all("expenses")).find((entry) =>
        entry.name.toLocaleLowerCase() === form.elements.name.value.trim().toLocaleLowerCase()
        && entry.amount === Number(form.elements.amount.value)
        && entry.date === form.elements.date.value
      );
      if (duplicate && !window.confirm("A similar expense already exists. Save it anyway?")) return;
    }
    const selectedFile = form.elements.receipt.files[0];
    if (selectedFile && (!selectedFile.type.startsWith("image/") || selectedFile.size > MAX_RECEIPT_BYTES)) {
      showToast("Choose an image smaller than 8 MB.", "error");
      return;
    }
    const item = {
      id: id || makeId(),
      name: form.elements.name.value.trim(),
      category: form.elements.category.value,
      productId: form.elements.product.value || knownProduct?.id || "",
      amount: Number(form.elements.amount.value),
      quantity,
      unitPrice,
      vat,
      date: form.elements.date.value,
      receipt: selectedFile || expenseReceipt || null,
      receiptItems: detectedReceiptItems,
      sample: existing?.sample || false,
      createdAt: existing?.createdAt || Date.now()
    };
    await database.put("expenses", item);
    closeDialogs();
    await refresh();
    showToast(id ? "Expense updated." : "Expense saved on this device.");
  }

  async function saveWalletEntry(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    if (!id && !(await canAddRecord())) return;
    const amount = Number(form.elements.amount.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast("Enter an amount greater than zero.", "error");
      return;
    }
    const existing = id ? await database.get("wallet", id) : null;
    await database.put("wallet", {
      id: id || makeId(),
      amount,
      date: form.elements.date.value,
      note: form.elements.note.value.trim(),
      createdAt: existing?.createdAt || Date.now()
    });
    closeDialogs();
    await refresh();
    showToast(id ? "Wallet entry updated." : "Funds added to your wallet.");
  }

  async function saveDebt(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    if (!id && !(await canAddRecord())) return;
    const amount = Number(form.elements.amount.value);
    const remaining = Number(form.elements.remaining.value);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(remaining) || remaining < 0) {
      showToast("Enter valid original and outstanding amounts.", "error");
      return;
    }
    if (remaining > amount) {
      showToast("The outstanding amount cannot exceed the original amount.", "error");
      return;
    }
    const existing = id ? await database.get("debts", id) : null;
    const debtEntry = {
      id: id || makeId(),
      direction: form.elements.direction.value,
      person: form.elements.person.value.trim(),
      amount,
      remaining,
      date: form.elements.date.value,
      dueDate: form.elements.dueDate.value,
      note: form.elements.note.value.trim(),
      createdAt: existing?.createdAt || Date.now()
    };
    if (remaining === 0) {
      debtEntry.settledRemaining = Number(existing?.remaining) > 0
        ? Number(existing.remaining) : Number(existing?.settledRemaining ?? amount);
    }
    await database.put("debts", debtEntry);
    closeDialogs();
    await refresh();
    showToast(id ? "Debt updated." : "Debt saved.");
  }

  function downloadFile(filename, contents, type) {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function calendarEscape(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  }

  function addToCalendar(item) {
    const date = item.date.replaceAll("-", "");
    const dateTime = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const start = item.time
      ? `DTSTART:${date}T${item.time.replace(":", "")}00`
      : `DTSTART;VALUE=DATE:${date}`;
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//LifeVault//Life Admin//EN",
      "CALSCALE:GREGORIAN", "BEGIN:VEVENT", `UID:${item.id}@lifevault.local`,
      `DTSTAMP:${dateTime}`, start,
      `SUMMARY:${calendarEscape(item.name)}`,
      `DESCRIPTION:${calendarEscape(`${item.category}${item.reference ? ` · Ref: ${item.reference}` : ""}${item.notes ? ` · ${item.notes}` : ""}`)}`,
      "BEGIN:VALARM", "TRIGGER:-P7D", "ACTION:DISPLAY",
      `DESCRIPTION:${calendarEscape(`Reminder: ${item.name} is coming up in 7 days`)}`, "END:VALARM",
      "END:VEVENT", "END:VCALENDAR", ""
    ].join("\r\n");
    downloadFile(`${item.name.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-|-$/g, "") || "lifevault-reminder"}.ics`, ics, "text/calendar;charset=utf-8");
    showToast("Calendar reminder downloaded.");
  }

  function openWhatsApp(item) {
    const time = formatVaultTime(item.time);
    const when = time ? `${localDate(item.date)} at ${time}` : localDate(item.date);
    const message = `LifeVault reminder: ${item.name} is due on ${when}.`;
    const url = `https://wa.me/?text=${encodeURIComponent(message)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function handleVaultAction(event) {
    const button = event.target.closest("[data-card-action]");
    if (!button) return;
    const card = button.closest("[data-id]");
    const item = await database.get("vault", card.dataset.id);
    if (!item) return;
    switch (button.dataset.cardAction) {
      case "calendar": addToCalendar(item); break;
      case "whatsapp": openWhatsApp(item); break;
      case "edit": openVaultForm(item); break;
      case "delete":
        if (window.confirm(`Delete "${item.name}" from your vault?`)) {
          await database.delete("vault", item.id);
          await refresh();
          showToast("Vault item deleted.");
        }
        break;
      case "done":
        if (item.done) item.done = false;
        else if (item.category === "Events") item.done = true;
        else {
          const date = new Date(`${item.date}T12:00:00`);
          if (Number.isNaN(date.getTime())) throw new Error("This item's date is invalid. Edit the date before renewing.");
          if (item.recurrence === "monthly") date.setMonth(date.getMonth() + 1);
          else date.setFullYear(date.getFullYear() + 1);
          item.date = dateInputValue(date);
        }
        await database.put("vault", item);
        await refresh();
        showToast(item.done ? "Marked as complete." : "Renewed for another year.");
        break;
      default: break;
    }
  }

  async function handleExpenseAction(event) {
    const button = event.target.closest("[data-expense-action]");
    if (!button) return;
    const row = button.closest("[data-id]");
    const item = await database.get("expenses", row.dataset.id);
    if (!item) return;
    if (button.dataset.expenseAction === "edit") await openExpenseForm(item);
    if (button.dataset.expenseAction === "delete") {
      if (window.confirm(`Delete the expense "${item.name}"?`)) {
        await database.delete("expenses", item.id);
        await refresh();
        showToast("Expense deleted.");
      }
    }
    if (button.dataset.expenseAction === "receipt") openReceipt(item);
  }

  async function handleWalletAction(event) {
    const button = event.target.closest("[data-wallet-action]");
    if (!button) return;
    const row = button.closest("[data-id]");
    const entry = await database.get("wallet", row.dataset.id);
    if (!entry) return;
    if (button.dataset.walletAction === "edit") openWalletForm(entry);
    if (button.dataset.walletAction === "delete" && window.confirm("Delete this wallet funding entry?")) {
      await database.delete("wallet", entry.id);
      await refresh();
      showToast("Wallet entry deleted.");
    }
  }

  async function handleDebtAction(event) {
    const button = event.target.closest("[data-debt-action]");
    if (!button) return;
    const card = button.closest("[data-id]");
    const debt = await database.get("debts", card.dataset.id);
    if (!debt) return;
    switch (button.dataset.debtAction) {
      case "edit":
        openDebtForm(debt);
        break;
      case "settle":
        if (Number(debt.remaining) > 0) {
          if (!window.confirm(`Mark the debt with ${debt.person} as settled?`)) return;
          debt.settledRemaining = Number(debt.remaining);
          debt.remaining = 0;
        } else {
          debt.remaining = Number(debt.settledRemaining ?? debt.amount);
          delete debt.settledRemaining;
        }
        await database.put("debts", debt);
        await refresh();
        showToast(debt.remaining > 0 ? "Debt reopened." : "Debt marked as settled.");
        break;
      case "delete":
        if (!window.confirm(`Delete the debt record for ${debt.person}?`)) return;
        await database.delete("debts", debt.id);
        await refresh();
        showToast("Debt record deleted.");
        break;
      default:
        break;
    }
  }

  function openReceipt(item) {
    const viewer = $("#receipt-viewer");
    viewer.replaceChildren();
    const image = document.createElement("img");
    previewObjectUrl = URL.createObjectURL(item.receipt);
    image.src = previewObjectUrl;
    image.alt = `Receipt for ${item.name}`;
    viewer.append(image);
    $("#receipt-title").textContent = item.name;
    showDialog($("#receipt-dialog"));
  }

  async function addShoppingItem(key) {
    const expenses = await database.all("expenses");
    const group = getBulkGroups(expenses).find((entry) => entry.key === key);
    if (!group) return;
    const shopping = await database.all("shopping");
    if (shopping.some((item) => normalizeName(item.name) === key)) {
      showToast("That item is already on your shopping list.");
      return;
    }
    await database.put("shopping", {
      id: makeId(), name: group.name, frequency: group.purchases.length, done: false, createdAt: Date.now()
    });
    await refresh();
    showToast(`${group.name} added to your shopping list.`);
  }

  function bytesToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(reader.error || new Error("Could not read the receipt image for backup."));
      reader.readAsDataURL(blob);
    });
  }

  function base64ToBlob(encoded, type) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: type || "application/octet-stream" });
  }

  async function exportBackup() {
    const [vault, expenses, shopping, wallet, debts, tasks, products] = await Promise.all([
      database.all("vault"), database.all("expenses"), database.all("shopping"),
      database.all("wallet"), database.all("debts"), database.all("tasks"), database.all("products")
    ]);
    const serializedExpenses = await Promise.all(expenses.map(async (expense) => {
      if (!(expense.receipt instanceof Blob)) return expense;
      return {
        ...expense,
        receipt: {
          data: await bytesToBase64(expense.receipt),
          type: expense.receipt.type,
          name: expense.receipt.name || ""
        }
      };
    }));
    const serializedTasks = await Promise.all(tasks.map(async (task) => {
      if (!(task.photo instanceof Blob)) return task;
      return {
        ...task,
        photo: {
          data: await bytesToBase64(task.photo),
          type: task.photo.type,
          name: task.photo.name || ""
        }
      };
    }));
    const backup = {
      app: "LifeVault", version: 4, exportedAt: new Date().toISOString(),
      vault, expenses: serializedExpenses, shopping, wallet, debts, tasks: serializedTasks, products
    };
    downloadFile(`lifevault-backup-${todayISO()}.json`, JSON.stringify(backup), "application/json");
    showToast("Your local backup is ready to download.");
  }

  function validateBackup(input) {
    if (!input || input.app !== "LifeVault" || ![1, 2, 3, 4].includes(input.version)
      || !Array.isArray(input.vault) || !Array.isArray(input.expenses) || !Array.isArray(input.shopping)) {
      throw new Error("This file is not a supported LifeVault backup.");
    }
    if (input.wallet === undefined) input.wallet = [];
    if (input.debts === undefined) input.debts = [];
    if (input.tasks === undefined) input.tasks = [];
    if (input.products === undefined) input.products = [];
    if (!Array.isArray(input.wallet) || !Array.isArray(input.debts) || !Array.isArray(input.tasks) || !Array.isArray(input.products)) {
      throw new Error("The backup contains invalid wallet, debt, task, or product data.");
    }
    const allRecords = [...input.vault, ...input.expenses, ...input.shopping, ...input.wallet, ...input.debts, ...input.tasks, ...input.products];
    if (allRecords.length > 10000) throw new Error("This backup contains too many records to restore.");
    const uniqueIds = new Set();
    input.vault.forEach((item) => {
      if (!item || typeof item.id !== "string" || !item.name || !item.date || !CATEGORIES.vault[item.category]) {
        throw new Error("The backup contains an invalid vault item.");
      }
      if (uniqueIds.has(`vault:${item.id}`)) throw new Error("The backup contains duplicate vault IDs.");
      uniqueIds.add(`vault:${item.id}`);
    });
    input.expenses.forEach((item) => {
      if (!item || typeof item.id !== "string" || !item.name || !item.date || !CATEGORIES.expense[item.category]
        || !Number.isFinite(Number(item.amount)) || Number(item.amount) <= 0) {
        throw new Error("The backup contains an invalid expense.");
      }
      if (uniqueIds.has(`expense:${item.id}`)) throw new Error("The backup contains duplicate expense IDs.");
      uniqueIds.add(`expense:${item.id}`);
    });
    input.shopping.forEach((item) => {
      if (!item || typeof item.id !== "string" || !item.name) throw new Error("The backup contains an invalid shopping item.");
    });
    input.wallet.forEach((entry) => {
      if (!entry || typeof entry.id !== "string" || !entry.date
        || !Number.isFinite(Number(entry.amount)) || Number(entry.amount) <= 0) {
        throw new Error("The backup contains an invalid wallet entry.");
      }
      if (uniqueIds.has(`wallet:${entry.id}`)) throw new Error("The backup contains duplicate wallet IDs.");
      uniqueIds.add(`wallet:${entry.id}`);
    });
    input.debts.forEach((debt) => {
      const amount = Number(debt?.amount);
      const remaining = Number(debt?.remaining);
      if (!debt || typeof debt.id !== "string" || !debt.person || !debt.date
        || !["i-owe", "owed-to-me"].includes(debt.direction)
        || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(remaining) || remaining < 0 || remaining > amount) {
        throw new Error("The backup contains an invalid debt entry.");
      }
      if (debt.settledRemaining !== undefined
        && (!Number.isFinite(Number(debt.settledRemaining)) || Number(debt.settledRemaining) < 0
          || Number(debt.settledRemaining) > amount)) {
        throw new Error("The backup contains an invalid settled debt amount.");
      }
      if (uniqueIds.has(`debt:${debt.id}`)) throw new Error("The backup contains duplicate debt IDs.");
      uniqueIds.add(`debt:${debt.id}`);
    });
    input.tasks.forEach((task) => {
      if (!task || typeof task.id !== "string" || !task.title) throw new Error("The backup contains an invalid task.");
      if (uniqueIds.has(`task:${task.id}`)) throw new Error("The backup contains duplicate task IDs.");
      uniqueIds.add(`task:${task.id}`);
    });
    input.products.forEach((product) => {
      if (!product || typeof product.id !== "string" || !product.name || !CATEGORIES.expense[product.category]) {
        throw new Error("The backup contains an invalid saved product.");
      }
      if (uniqueIds.has(`product:${product.id}`)) throw new Error("The backup contains duplicate product IDs.");
      uniqueIds.add(`product:${product.id}`);
    });
  }

  async function restoreBackup(file) {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) throw new Error("Backup files must be smaller than 50 MB.");
    const raw = await file.text();
    const backup = JSON.parse(raw);
    validateBackup(backup);
    if (!isPro && backup.vault.length + backup.expenses.length + backup.wallet.length + backup.debts.length + backup.tasks.length + backup.products.length > FREE_LIMIT) {
      showDialog($("#upgrade-dialog"));
      throw new Error("This backup has more than 5 records. Activate Pro before restoring it.");
    }
    if (!window.confirm("Restore this backup? It will replace all current vault, expense, wallet, debt, and shopping-list records.")) return;
    const expenses = backup.expenses.map((expense) => ({
      ...expense,
      receipt: expense.receipt && typeof expense.receipt === "object" && typeof expense.receipt.data === "string"
        ? base64ToBlob(expense.receipt.data, expense.receipt.type) : null
    }));
    const tasks = backup.tasks.map((task) => ({
      ...task,
      photo: task.photo && typeof task.photo === "object" && typeof task.photo.data === "string"
        ? base64ToBlob(task.photo.data, task.photo.type) : null
    }));
    await database.replaceRecords(backup.vault, expenses, backup.shopping, backup.wallet, backup.debts, tasks, backup.products);
    await refresh();
    showToast("Backup restored to this device.");
  }

  async function clearSamples() {
    const [vault, expenses, wallet, debts, tasks, products] = await Promise.all([
      database.all("vault"), database.all("expenses"), database.all("wallet"),
      database.all("debts"), database.all("tasks"), database.all("products")
    ]);
    const samples = [...vault, ...expenses, ...wallet, ...debts, ...tasks, ...products].filter((item) => item.sample);
    if (!samples.length) {
      showToast("There is no sample data to clear.");
      return;
    }
    if (!window.confirm(`Remove ${samples.length} sample record${samples.length === 1 ? "" : "s"}? Your own records will stay.`)) return;
    await Promise.all([
      ...vault.filter((item) => item.sample).map((item) => database.delete("vault", item.id)),
      ...expenses.filter((item) => item.sample).map((item) => database.delete("expenses", item.id)),
      ...wallet.filter((item) => item.sample).map((item) => database.delete("wallet", item.id)),
      ...debts.filter((item) => item.sample).map((item) => database.delete("debts", item.id)),
      ...tasks.filter((item) => item.sample).map((item) => database.delete("tasks", item.id)),
      ...products.filter((item) => item.sample).map((item) => database.delete("products", item.id))
    ]);
    await refresh();
    showToast("Sample data cleared.");
  }

  async function clearAll() {
    if (!window.confirm("Permanently delete all vault items, expenses, wallet entries, debts, tasks, photos, and shopping-list entries from this device? This cannot be undone.")) return;
    await Promise.all(["vault", "expenses", "shopping", "wallet", "debts", "tasks", "products"].map((store) => database.clear(store)));
    await refresh();
    showToast("All local LifeVault records were deleted.");
  }

  async function clearShopping() {
    const shopping = await database.all("shopping");
    if (!shopping.length) {
      showToast("Your shopping list is already empty.");
      return;
    }
    if (!window.confirm("Clear all items from your bulk shopping list?")) return;
    await database.clear("shopping");
    await refresh();
    showToast("Shopping list cleared.");
  }

  function licenseEndpoint() {
    return typeof window.LifeVaultLicenseEndpoint === "string" ? window.LifeVaultLicenseEndpoint.trim() : "";
  }

  async function verifyLicenseWithProvider(key) {
    const endpoint = licenseEndpoint();
    if (!endpoint) return false;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ license_key: key, product: "lifevault" })
    });
    if (!response.ok) throw new Error(`License verification service returned ${response.status}.`);
    const result = await response.json();
    return result.valid === true || result.activated === true;
  }

  async function activateLicense() {
    const key = $("#license-input").value.trim();
    if (!key) {
      showToast("Enter a license key to continue.", "error");
      return;
    }
    const button = $('[data-action="activate-license"]');
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      const valid = key.toUpperCase() === "LIFE-PRO-2026" || await verifyLicenseWithProvider(key);
      if (!valid) {
        showToast("That key couldn't be verified. Check it and try again.", "error");
        return;
      }
      await database.put("meta", { key: "pro", value: true, activatedAt: Date.now() });
      isPro = true;
      closeDialogs();
      await refresh();
      showToast("LifeVault Pro is active on this device.");
    } finally {
      button.disabled = false;
      button.textContent = "Activate";
    }
  }

  async function loadTesseract() {
    if (window.Tesseract) return window.Tesseract;
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    script.async = true;
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(new Error("Could not load the OCR engine. Check your connection and try again."));
      document.head.append(script);
    });
    if (!window.Tesseract) throw new Error("The OCR engine loaded but could not be initialized.");
    return window.Tesseract;
  }

  function extractReceiptFields(text) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const merchant = lines.find((line) => line.length > 2 && /[a-z]/i.test(line)
      && !/(receipt|tax invoice|invoice|thank you|cashier|subtotal|total|date|tel:)/i.test(line));
    const numberPattern = /([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;
    const vatMatch = text.match(/(?:vat|tax|gst)[^\d]*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
    const vat = vatMatch ? vatMatch[1].replace(/,/g, "") : "";
    const products = [];
    lines.forEach((line) => {
      if (/^(?:subtotal|total|tax|vat|gst|balance|cash|change|date|tel)/i.test(line)) return;
      const values = [...line.matchAll(numberPattern)].map((match) => Number(match[1].replace(/,/g, ""))).filter(Number.isFinite);
      if (values.length < 2) return;
      const quantityMatch = line.match(/(?:^|[\s])([0-9]+(?:\.[0-9]+)?)[x×*]\s/i)
        || line.match(/^([0-9]+(?:\.[0-9]+)?)\s+/);
      const quantity = quantityMatch ? Number(quantityMatch[1]) : 1;
      const unitPrice = quantityMatch ? values.find((value) => value !== quantity) || 0 : values.length > 1 ? values[values.length - 2] : values[0];
      const lineTotal = values[values.length - 1];
      const name = line
        .replace(/^[0-9]+(?:\.[0-9]+)?[\s]*[x×*]?[\s]*/i, "")
        .replace(/[0-9][0-9,]*(?:\.[0-9]{1,2})?/g, "")
        .replace(/[\s]+/g, " ")
        .replace(/[|:,-]+$/g, "")
        .trim();
      if (name.length >= 2) products.push({ name: name.slice(0, 100), quantity, unitPrice, vat: "", total: lineTotal });
    });
    const totalPatterns = [
      /(?:grand\s+total|total\s+due|amount\s+due|net\s+total|total)\s*[:\-]?\s*(?:aed|usd|eur|gbp|sar|د\.إ|[$€£])?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i,
      /(?:aed|usd|eur|gbp|sar|د\.إ|[$€£])\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i
    ];
    let amount = "";
    for (const pattern of totalPatterns) {
      const match = text.match(pattern);
      if (match) {
        const parsed = Number(match[1].replace(/,/g, ""));
        if (Number.isFinite(parsed) && parsed > 0) {
          amount = parsed.toFixed(2);
          break;
        }
      }
    }
    return { merchant: merchant?.slice(0, 100) || "", amount, vat, quantity: products[0]?.quantity || 1, unitPrice: products[0]?.unitPrice || "", products };
  }

  async function scanReceipt() {
    const form = $("#expense-form");
    const file = form.elements.receipt.files[0] || expenseReceipt;
    if (!file) {
      showToast("Choose a receipt photo before scanning.", "error");
      return;
    }
    if (ocrBusy) return;
    ocrBusy = true;
    const button = $('[data-action="scan-receipt"]');
    const status = $("#ocr-status");
    button.disabled = true;
    button.textContent = "Scanning…";
    status.textContent = "Loading OCR and reading this image on your device…";
    try {
      const tesseract = await loadTesseract();
      const result = await tesseract.recognize(file, "eng", {
        logger: (progress) => {
          if (progress.status === "recognizing text") status.textContent = `Reading receipt… ${Math.round(progress.progress * 100)}%`;
        }
      });
      const fields = extractReceiptFields(result.data.text);
      detectedReceiptItems = fields.products;
      if (fields.products[0]) {
        form.elements.name.value = fields.products[0].name;
        form.elements.quantity.value = fields.products[0].quantity;
        form.elements.unitPrice.value = fields.products[0].unitPrice || "";
        form.elements.amount.value = fields.products[0].total || fields.amount;
      } else if (fields.merchant) {
        form.elements.name.value = fields.merchant;
      }
      if (fields.vat) form.elements.vat.value = fields.vat;
      if (!fields.products[0] && fields.amount) form.elements.amount.value = fields.amount;
      if (fields.merchant) form.elements.vendor.value = fields.merchant;
      const detected = $("#detected-items");
      detected.hidden = fields.products.length === 0;
      detected.innerHTML = fields.products.length
        ? `<div class="detected-item-row"><strong>Detected item</strong><strong>Qty</strong><strong>Price</strong><strong>Total</strong></div>${fields.products.map((line) =>
          `<div class="detected-item-row"><span>${escapeHtml(line.name)}</span><span>${line.quantity}</span><span>${money(line.unitPrice)}</span><span>${money(line.total)}</span></div>`
        ).join("")}`
        : "";
      status.textContent = fields.merchant || fields.amount
        ? "Review the detected values, then save. OCR can make mistakes."
        : "No clear merchant or total found. You can fill in the details manually.";
      if (fields.merchant || fields.amount) showToast("Receipt scanned. Please check the detected details.");
    } catch (error) {
      status.textContent = "";
      reportError(error, "Receipt scan failed");
    } finally {
      ocrBusy = false;
      button.disabled = false;
      button.textContent = "⌕ Scan with OCR";
    }
  }

  async function handleAction(action, target) {
    switch (action) {
      case "quick-add": openQuickAdd(); break;
      case "add-vault":
        if (await canAddRecord()) openVaultForm();
        break;
      case "add-expense":
        if (await canAddRecord()) await openExpenseForm();
        break;
      case "add-funds":
        if (await canAddRecord()) openWalletForm();
        break;
      case "add-debt":
        if (await canAddRecord()) openDebtForm();
        break;
      case "add-task":
        if (await canAddRecord()) openTaskForm();
        break;
      case "close-dialog": closeDialogs(); break;
      case "upgrade": showDialog($("#upgrade-dialog")); break;
      case "license": showDialog($("#upgrade-dialog")); $("#license-input").focus(); break;
      case "activate-license": await activateLicense(); break;
      case "clear-samples": await clearSamples(); break;
      case "clear-all": await clearAll(); break;
      case "clear-shopping": await clearShopping(); break;
      case "export": await exportBackup(); break;
      case "restore": $("#restore-file").click(); break;
      case "install-app":
        if (!deferredPrompt) { showToast("LifeVault is already installed or this browser does not offer installation."); break; }
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        break;
      case "remove-receipt":
        expenseReceipt = null;
        $("#expense-form").elements.receipt.value = "";
        await showReceiptPreview(null);
        break;
      case "scan-receipt": await scanReceipt(); break;
      default:
        if (target.dataset.bulkKey) await addShoppingItem(target.dataset.bulkKey);
        if (target.dataset.shoppingRemove) {
          await database.delete("shopping", target.dataset.shoppingRemove);
          await refresh();
          showToast("Removed from your shopping list.");
        }
    }
  }

  function bindEvents() {
    document.addEventListener("click", async (event) => {
      const nav = event.target.closest("[data-view]");
      if (nav) {
        event.preventDefault();
        setView(nav.dataset.view);
        return;
      }
      const actionTarget = event.target.closest("[data-action], [data-bulk-key], [data-shopping-remove]");
      if (actionTarget) {
        try {
          await handleAction(actionTarget.dataset.action, actionTarget);
        } catch (error) {
          reportError(error, "Could not complete that action");
        }
      }
    });

    $("#vault-list").addEventListener("click", async (event) => {
      try { await handleVaultAction(event); } catch (error) { reportError(error, "Could not update vault item"); }
    });
    $("#expense-list").addEventListener("click", async (event) => {
      try { await handleExpenseAction(event); } catch (error) { reportError(error, "Could not update expense"); }
    });
    $("#wallet-ledger").addEventListener("click", async (event) => {
      try { await handleWalletAction(event); } catch (error) { reportError(error, "Could not update wallet entry"); }
    });
    $("#debt-list").addEventListener("click", async (event) => {
      try { await handleDebtAction(event); } catch (error) { reportError(error, "Could not update debt"); }
    });
    $("#task-list").addEventListener("click", async (event) => {
      const row = event.target.closest("[data-id]");
      if (!row) return;
      const task = await database.get("tasks", row.dataset.id);
      if (!task) return;
      if (event.target.matches(".task-check")) {
        await database.put("tasks", { ...task, done: event.target.checked });
        await refresh();
      } else {
        const action = event.target.closest("[data-task-action]")?.dataset.taskAction;
        if (action === "edit") openTaskForm(task);
        if (action === "photo" && task.photo instanceof Blob) {
          if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
          previewObjectUrl = URL.createObjectURL(task.photo);
          $("#receipt-viewer").innerHTML = `<img src="${previewObjectUrl}" alt="Task reminder photo">`;
          showDialog($("#receipt-dialog"));
        }
        if (action === "delete" && window.confirm(`Delete "${task.title}"?`)) {
          await database.delete("tasks", task.id);
          await refresh();
          showToast("Reminder deleted.");
        }
      }
    });
    $("#task-search").addEventListener("input", () => database.all("tasks").then(renderTasks).catch((error) => reportError(error, "Could not search tasks")));
    $("#task-filter").addEventListener("change", () => database.all("tasks").then(renderTasks).catch((error) => reportError(error, "Could not filter tasks")));
    $("#task-form").addEventListener("submit", (event) => saveTask(event).catch((error) => reportError(error, "Could not save reminder")));
    $("#task-form").elements.photo.addEventListener("change", (event) => {
      const file = event.target.files[0];
      if (file && (!file.type.startsWith("image/") || file.size > MAX_RECEIPT_BYTES)) {
        event.target.value = "";
        showToast("Choose an image smaller than 8 MB.", "error");
        return;
      }
      taskPhoto = file || null;
      showTaskPhoto(file).catch((error) => reportError(error, "Could not preview photo"));
    });
    $("#vault-form").addEventListener("submit", (event) => {
      saveVault(event).catch((error) => reportError(error, "Could not save vault item"));
    });
    $("#expense-form").addEventListener("submit", (event) => {
      saveExpense(event).catch((error) => reportError(error, "Could not save expense"));
    });
    const expenseForm = $("#expense-form");
    expenseForm.elements.product.addEventListener("change", async (event) => {
      const products = await database.all("products");
      const product = products.find((item) => item.id === event.target.value);
      if (!product) return;
      expenseForm.elements.name.value = product.name;
      expenseForm.elements.category.value = product.category || expenseForm.elements.category.value;
      expenseForm.elements.unitPrice.value = product.unitPrice || 0;
      expenseForm.elements.vat.value = product.vat || 0;
      updateExpenseTotal();
    });
    ["quantity", "unitPrice", "vat"].forEach((name) => {
      expenseForm.elements[name].addEventListener("input", updateExpenseTotal);
    });
    expenseForm.elements.amount.addEventListener("input", (event) => {
      event.target.dataset.autoCalculated = "0";
    });
    expenseForm.elements.category.addEventListener("change", async () => {
      const products = await database.all("products");
      const productSelect = expenseForm.elements.product;
      productSelect.replaceChildren(new Option("Choose saved product", ""));
      products.filter((product) => product.category === expenseForm.elements.category.value).sort((a, b) => a.name.localeCompare(b.name)).forEach((product) => {
        productSelect.add(new Option(product.name, product.id));
      });
    });
    $("#wallet-form").addEventListener("submit", (event) => {
      saveWalletEntry(event).catch((error) => reportError(error, "Could not save wallet entry"));
    });
    $("#debt-form").addEventListener("submit", (event) => {
      saveDebt(event).catch((error) => reportError(error, "Could not save debt"));
    });
    $("#debt-form").elements.amount.addEventListener("input", (event) => {
      if (!$("#debt-form").elements.id.value) $("#debt-form").elements.remaining.value = event.target.value;
    });
    $("#home-search").addEventListener("input", (event) => {
      renderHomeSearch(event.target.value).catch((error) => reportError(error, "Could not search LifeVault"));
    });
    $("#reminder-offset").value = readPreference("lifevault-reminder-offset", "7");
    $("#reminder-offset").addEventListener("change", (event) => {
      savePreference("lifevault-reminder-offset", event.target.value);
      showToast("Reminder preference saved.");
    });
    $("#budget-settings").addEventListener("change", (event) => {
      if (!event.target.dataset.budgetCategory) return;
      const budgets = getBudgetPreferences();
      budgets[event.target.dataset.budgetCategory] = Number(event.target.value) || 0;
      savePreference("lifevault-budgets", JSON.stringify(budgets));
      refresh().catch((error) => reportError(error, "Could not update budgets"));
      showToast("Monthly budget updated.");
    });
    window.addEventListener("offline", () => { $("#offline-banner").hidden = false; });
    window.addEventListener("online", () => { $("#offline-banner").hidden = true; showToast("You are back online."); });
    $("#vault-search").addEventListener("input", () => database.all("vault").then(renderVault).catch((error) => reportError(error, "Could not search vault")));
    $("#vault-filter").addEventListener("change", () => database.all("vault").then(renderVault).catch((error) => reportError(error, "Could not filter vault")));
    $("#expense-search").addEventListener("input", () => database.all("expenses").then(renderExpenses).catch((error) => reportError(error, "Could not search expenses")));
    $("#expense-filter").addEventListener("change", () => database.all("expenses").then(renderExpenses).catch((error) => reportError(error, "Could not filter expenses")));
    const updateExpenseView = () => database.all("expenses").then(renderExpenses)
      .catch((error) => reportError(error, "Could not update expense chart"));
    $("#chart-period").addEventListener("change", updateExpenseView);
    $("#chart-category").addEventListener("change", updateExpenseView);
    $("#chart-start-date").addEventListener("change", updateExpenseView);
    $("#chart-end-date").addEventListener("change", updateExpenseView);
    $("#debt-search").addEventListener("input", () => database.all("debts").then(renderDebts).catch((error) => reportError(error, "Could not search debts")));
    $("#debt-filter").addEventListener("change", () => database.all("debts").then(renderDebts).catch((error) => reportError(error, "Could not filter debts")));

    const refreshOverview = () => {
      const start = $("#overview-start-date").value;
      const end = $("#overview-end-date").value;
      if (overviewPeriod === "custom" && !start && !end) {
        $("#overview-filter-error").textContent = "Choose a start date or end date for the custom range.";
        $("#overview-filter-error").hidden = false;
        return;
      }
      if (overviewPeriod === "custom" && start && end && start > end) {
        $("#overview-filter-error").textContent = "The start date must be on or before the end date.";
        $("#overview-filter-error").hidden = false;
        return;
      }
      $("#overview-filter-error").hidden = true;
      refresh().catch((error) => reportError(error, "Could not filter dashboard"));
    };
    $$("[data-overview-period]").forEach((button) => {
      button.addEventListener("click", () => {
        overviewPeriod = button.dataset.overviewPeriod;
        $$("[data-overview-period]").forEach((option) => {
          const selected = option === button;
          option.classList.toggle("active", selected);
          option.setAttribute("aria-pressed", String(selected));
        });
        $("#overview-custom-range").hidden = overviewPeriod !== "custom";
        $("#overview-filter-error").hidden = true;
        if (overviewPeriod === "custom" && !$("#overview-start-date").value && !$("#overview-end-date").value) {
          const today = new Date();
          $("#overview-start-date").value = dateInputValue(new Date(today.getFullYear(), today.getMonth(), 1));
          $("#overview-end-date").value = todayISO();
        }
        refreshOverview();
      });
    });
    $("#overview-start-date").addEventListener("change", refreshOverview);
    $("#overview-end-date").addEventListener("change", refreshOverview);

    $("#currency-select").value = CURRENCY_SYMBOLS[currency] ? currency : "AED";
    currency = $("#currency-select").value;
    $("#currency-select").addEventListener("change", async (event) => {
      currency = event.target.value;
      savePreference("lifevault-currency", currency);
      await refresh();
    });
    $("#restore-file").addEventListener("change", async (event) => {
      try { await restoreBackup(event.target.files[0]); } catch (error) { reportError(error, "Could not restore backup"); }
      finally { event.target.value = ""; }
    });
    $("#expense-form").elements.receipt.addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (file && (!file.type.startsWith("image/") || file.size > MAX_RECEIPT_BYTES)) {
        event.target.value = "";
        showToast("Choose an image smaller than 8 MB.", "error");
        return;
      }
      if (file) expenseReceipt = file;
      await showReceiptPreview(file || expenseReceipt);
    });
    $("#receipt-dialog").addEventListener("close", () => {
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = null;
    });
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredPrompt = event;
    });
    window.addEventListener("appinstalled", () => {
      deferredPrompt = null;
      showToast("LifeVault was installed successfully.");
    });
  }

  async function init() {
    try {
      document.body.classList.toggle("dark", darkMode);
      updateThemeToggle();
      $(".theme-toggle").addEventListener("click", () => {
        darkMode = !darkMode;
        document.body.classList.toggle("dark", darkMode);
        updateThemeToggle();
        savePreference("lifevault-theme", darkMode ? "dark" : "light");
      });
      if (!("indexedDB" in window)) throw new Error("This browser does not support IndexedDB, which LifeVault needs for private on-device storage.");
      db = await database.open();
      await seedSamplesIfEmpty();
      bindEvents();
      await refresh();
      $("#offline-banner").hidden = navigator.onLine;
      if (!readPreference("lifevault-onboarding", "")) {
        savePreference("lifevault-onboarding", "seen");
        showToast("Welcome to LifeVault. Start with Settings to choose your currency and budgets.");
      }
      window.setInterval(() => updateHomeClock(homeVault), 1000);
      window.setInterval(() => {
        refresh().catch((error) => reportError(error, "Could not refresh countdown"));
      }, 60000);
      if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
        navigator.serviceWorker.register("./sw.js").catch((error) => {
          showToast(`Offline app setup failed: ${error.message || "service worker unavailable"}`, "error");
        });
      }
      if (deferredPrompt) document.body.classList.add("install-available");
    } catch (error) {
      showToast(`LifeVault could not start: ${error.message || "Local storage unavailable."}`, "error");
      document.querySelectorAll("button,input,select").forEach((control) => { control.disabled = true; });
    }
  }

  init();
})();
