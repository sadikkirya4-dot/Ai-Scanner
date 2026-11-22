(() => {
  "use strict";

  const DB_NAME = "lifevault-local";
  const DB_VERSION = 2;
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
  let receiptObjectUrl = null;
  let previewObjectUrl = null;
  let ocrBusy = false;
  let deferredPrompt = null;
  let homeVault = [];

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

    replaceRecords(vault, expenses, shopping, wallet, debts) {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["vault", "expenses", "shopping", "wallet", "debts"], "readwrite");
        for (const [store, records] of [
          ["vault", vault], ["expenses", expenses], ["shopping", shopping], ["wallet", wallet], ["debts", debts]
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
    if (initialized?.value) return;
    const [vault, expenses] = await Promise.all([database.all("vault"), database.all("expenses")]);
    if (vault.length + expenses.length !== 0) {
      await database.put("meta", { key: "initialized", value: true });
      return;
    }
    const samples = [
      {
        id: "sample-passport", name: "Passport renewal", category: "IDs & travel",
        date: dateOffset(14), reference: "UAE passport", value: 0,
        notes: "Start the renewal process before travel season.", sample: true, done: false, createdAt: Date.now()
      },
      {
        id: "sample-grocery-1", name: "Pantry groceries", category: "Groceries",
        amount: 84.5, quantity: 1, date: dateInCurrentMonth(5), sample: true, createdAt: Date.now() - 3000
      },
      {
        id: "sample-grocery-2", name: "Pantry groceries", category: "Groceries",
        amount: 78, quantity: 1, date: dateInCurrentMonth(2), sample: true, createdAt: Date.now() - 2000
      }
    ];
    await Promise.all([
      database.put("vault", samples[0]),
      database.put("expenses", samples[1]),
      database.put("expenses", samples[2]),
      database.put("meta", { key: "initialized", value: true })
    ]);
  }

  async function loadAll() {
    const [vault, expenses, shopping, wallet, debts, meta] = await Promise.all([
      database.all("vault"), database.all("expenses"), database.all("shopping"),
      database.all("wallet"), database.all("debts"), database.get("meta", "pro")
    ]);
    isPro = Boolean(meta?.value);
    return { vault, expenses, shopping, wallet, debts };
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
      ? expenses.filter((entry) => !entry.sample && entry.date >= firstFundingDate)
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
    const { vault, expenses } = data;
    const range = getOverviewRange();
    const overviewExpenses = expenses.filter((item) => isInOverviewRange(item.date, range));
    const overviewVault = vault.filter((item) => isInOverviewRange(item.date, range));
    const presentation = getOverviewPresentation(range);
    const activeAlerts = vault.filter((item) => !item.done && dayDifference(item.date) !== null
      && dayDifference(item.date) <= 30).length;
    const spendTotal = overviewExpenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const pointsValue = overviewVault.reduce((sum, item) => sum + Number(item.value || 0), 0);
    const savings = computeEstimatedSavings(overviewExpenses);

    $("#urgent-value").textContent = String(activeAlerts);
    $("#spend-label").textContent = presentation.spend;
    $("#spend-value").textContent = money(spendTotal);
    $("#savings-label").textContent = presentation.savings;
    $("#savings-value").textContent = money(savings);
    $("#value-value").textContent = money(pointsValue);
    $("#dashboard-spend-title").textContent = presentation.heading;
    $("#sample-footer").hidden = ![...vault, ...expenses].some((item) => item.sample);
    updateHeaderCount(vault.length);

    const upcoming = vault.filter((item) => !item.done && dayDifference(item.date) !== null)
      .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4);
    const upcomingList = $("#upcoming-list");
    if (!upcoming.length) {
      upcomingList.innerHTML = '<div class="empty-inline"><p>No upcoming reminders. Add an item to keep an eye on it.</p></div>';
    } else {
      upcomingList.innerHTML = upcoming.map((item) => {
        const icon = CATEGORIES.vault[item.category] || "◷";
        return `<div class="compact-item"><span class="compact-icon">${icon}</span><span class="compact-copy"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.category)} · ${escapeHtml(vaultDateLine(item))}</small></span></div>`;
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
      $(`[data-wallet-segment="${key}"]`).style.width = `${metricTotal ? value / metricTotal * 100 : 0}%`;
    });
    $("#wallet-analytics").setAttribute("aria-label",
      `Relative metric comparison; segment widths represent ${metricParts.map(([label, name, amount]) => `${name.toLowerCase()} ${money(amount)}`).join(", ")}. These values are not a combined wallet balance.`);
    const allDebtSummary = getDebtSummary(data.debts);
    const openDebtCount = allDebtSummary.oweCount + allDebtSummary.owedCount;
    $("#debt-count").textContent = String(openDebtCount);

    const groups = getBulkGroups(overviewExpenses).slice(0, 2);
    const preview = $("#dashboard-savings");
    preview.innerHTML = groups.length ? groups.map((group) =>
      `<div class="mini-savings"><span class="mini-savings-icon">✳</span><span><strong>${escapeHtml(group.name)}</strong><small>${group.purchases.length} buys · ${money(group.amount * 0.18)} possible savings</small></span></div>`
    ).join("") : '<p class="muted-small">Your repeat purchases will show up here.</p>';
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

  async function refresh() {
    const data = await loadAll();
    homeVault = data.vault;
    updateHomeClock(data.vault);
    renderDashboard(data);
    renderVault(data.vault);
    renderExpenses(data.expenses);
    renderWalletLedger(data.wallet);
    renderDebts(data.debts);
    await renderBulk(data);
    $("#license-status").textContent = isPro
      ? "LifeVault Pro is active on this device. Your local records are unlimited."
      : `Free plan · ${getRecordCount(data)} of ${FREE_LIMIT} records used on this device.`;
    updateCurrencyLabels();
  }

  function getRecordCount(data) {
    return data.vault.length + data.expenses.length + data.wallet.length + data.debts.length;
  }

  function setView(view) {
    const validViews = ["dashboard", "vault", "expenses", "debts", "bulk", "settings"];
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
    form.elements.amount.value = item?.amount ?? "";
    form.elements.quantity.value = item?.quantity ?? 1;
    form.elements.date.value = item?.date || todayISO();
    $("#ocr-status").textContent = "";
    await showReceiptPreview(expenseReceipt);
    showDialog($("#item-dialog"));
    form.elements.name.focus();
  }

  function closeDialogs() {
    $$("dialog[open]").forEach((dialog) => dialog.close());
    if (receiptObjectUrl) URL.revokeObjectURL(receiptObjectUrl);
    receiptObjectUrl = null;
    expenseReceipt = null;
    $("#ocr-status").textContent = "";
  }

  async function canAddRecord() {
    if (isPro) return true;
    const [vault, expenses, wallet, debts] = await Promise.all([
      database.all("vault"), database.all("expenses"), database.all("wallet"), database.all("debts")
    ]);
    if (getRecordCount({ vault, expenses, wallet, debts }) < FREE_LIMIT) return true;
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

  function openQuickAdd() {
    const choice = document.createElement("dialog");
    choice.className = "app-dialog compact-dialog";
    choice.innerHTML = `<button class="icon-button dialog-close modal-x" aria-label="Close dialog">×</button><div class="upgrade-mark">＋</div><p class="eyebrow">MAKE A NOTE OF IT</p><h2>What would you like to add?</h2><p class="upgrade-copy">Choose where this belongs in your LifeVault.</p><div class="quick-choice"><button class="button button-primary" data-choice="vault">▤ &nbsp; Life admin item</button><button class="button button-secondary" data-choice="expense">↗ &nbsp; Expense</button></div>`;
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
      if (allowed) button.dataset.choice === "vault" ? openVaultForm() : openExpenseForm();
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
      date: form.elements.date.value,
      time: form.elements.time.value,
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
    const selectedFile = form.elements.receipt.files[0];
    if (selectedFile && (!selectedFile.type.startsWith("image/") || selectedFile.size > MAX_RECEIPT_BYTES)) {
      showToast("Choose an image smaller than 8 MB.", "error");
      return;
    }
    const item = {
      id: id || makeId(),
      name: form.elements.name.value.trim(),
      category: form.elements.category.value,
      amount: Number(form.elements.amount.value),
      quantity: Number(form.elements.quantity.value),
      date: form.elements.date.value,
      receipt: selectedFile || expenseReceipt || null,
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
          date.setFullYear(date.getFullYear() + 1);
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
    const [vault, expenses, shopping, wallet, debts] = await Promise.all([
      database.all("vault"), database.all("expenses"), database.all("shopping"),
      database.all("wallet"), database.all("debts")
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
    const backup = {
      app: "LifeVault", version: 2, exportedAt: new Date().toISOString(),
      vault, expenses: serializedExpenses, shopping, wallet, debts
    };
    downloadFile(`lifevault-backup-${todayISO()}.json`, JSON.stringify(backup), "application/json");
    showToast("Your local backup is ready to download.");
  }

  function validateBackup(input) {
    if (!input || input.app !== "LifeVault" || ![1, 2].includes(input.version)
      || !Array.isArray(input.vault) || !Array.isArray(input.expenses) || !Array.isArray(input.shopping)) {
      throw new Error("This file is not a supported LifeVault backup.");
    }
    if (input.wallet === undefined) input.wallet = [];
    if (input.debts === undefined) input.debts = [];
    if (!Array.isArray(input.wallet) || !Array.isArray(input.debts)) {
      throw new Error("The backup contains invalid wallet or debt data.");
    }
    const allRecords = [...input.vault, ...input.expenses, ...input.shopping, ...input.wallet, ...input.debts];
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
  }

  async function restoreBackup(file) {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) throw new Error("Backup files must be smaller than 50 MB.");
    const raw = await file.text();
    const backup = JSON.parse(raw);
    validateBackup(backup);
    if (!isPro && backup.vault.length + backup.expenses.length + backup.wallet.length + backup.debts.length > FREE_LIMIT) {
      showDialog($("#upgrade-dialog"));
      throw new Error("This backup has more than 5 records. Activate Pro before restoring it.");
    }
    if (!window.confirm("Restore this backup? It will replace all current vault, expense, wallet, debt, and shopping-list records.")) return;
    const expenses = backup.expenses.map((expense) => ({
      ...expense,
      receipt: expense.receipt && typeof expense.receipt === "object" && typeof expense.receipt.data === "string"
        ? base64ToBlob(expense.receipt.data, expense.receipt.type) : null
    }));
    await database.replaceRecords(backup.vault, expenses, backup.shopping, backup.wallet, backup.debts);
    await refresh();
    showToast("Backup restored to this device.");
  }

  async function clearSamples() {
    const [vault, expenses] = await Promise.all([database.all("vault"), database.all("expenses")]);
    const samples = [...vault, ...expenses].filter((item) => item.sample);
    if (!samples.length) {
      showToast("There is no sample data to clear.");
      return;
    }
    if (!window.confirm(`Remove ${samples.length} sample record${samples.length === 1 ? "" : "s"}? Your own records will stay.`)) return;
    await Promise.all([
      ...vault.filter((item) => item.sample).map((item) => database.delete("vault", item.id)),
      ...expenses.filter((item) => item.sample).map((item) => database.delete("expenses", item.id))
    ]);
    await refresh();
    showToast("Sample data cleared.");
  }

  async function clearAll() {
    if (!window.confirm("Permanently delete all vault items, expenses, wallet entries, debts, receipt images, and shopping-list entries from this device? This cannot be undone.")) return;
    await Promise.all(["vault", "expenses", "shopping", "wallet", "debts"].map((store) => database.clear(store)));
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
    return { merchant: merchant?.slice(0, 100) || "", amount };
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
      if (fields.merchant) form.elements.name.value = fields.merchant;
      if (fields.amount) form.elements.amount.value = fields.amount;
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
      case "close-dialog": closeDialogs(); break;
      case "upgrade": showDialog($("#upgrade-dialog")); break;
      case "license": showDialog($("#upgrade-dialog")); $("#license-input").focus(); break;
      case "activate-license": await activateLicense(); break;
      case "clear-samples": await clearSamples(); break;
      case "clear-all": await clearAll(); break;
      case "clear-shopping": await clearShopping(); break;
      case "export": await exportBackup(); break;
      case "restore": $("#restore-file").click(); break;
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
    $("#vault-form").addEventListener("submit", (event) => {
      saveVault(event).catch((error) => reportError(error, "Could not save vault item"));
    });
    $("#expense-form").addEventListener("submit", (event) => {
      saveExpense(event).catch((error) => reportError(error, "Could not save expense"));
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
