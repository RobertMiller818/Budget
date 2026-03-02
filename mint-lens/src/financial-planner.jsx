import React, { useState, useMemo, useCallback } from "react";

// ─── Helpers ────────────────────────────────────────────────────────────────
const fmt = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

const normalize = (s) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

const normalizePayee = (desc) => {
  let s = normalize(desc);
  // Remove long digit sequences (reference/account numbers)
  s = s.replace(/\b\d{4,}\b/g, "");
  // Remove date-like patterns  MM/DD
  s = s.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, "");
  // Remove phone numbers
  s = s.replace(/\b\d{3}\s?\d{3}\s?\d{4}\b/g, "");
  // Remove common banking prefixes/suffixes
  s = s.replace(
    /\b(pos|ach|dbt|pmt|pymt|autopay|auto pay|purchase|recurring|direct debit|online transfer|wire transfer|bill pay|checkcard|visa|mastercard|check|des|web|indn|co id|id)\b/g,
    ""
  );
  // Remove masked card numbers like XXXXX34525
  s = s.replace(/x{3,}\d*/gi, "");
  // Remove state abbreviations at end (2 letter codes)
  s = s.replace(/\b[A-Z]{2}$/i, "");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[\s\-*]+|[\s\-*]+$/g, "").trim();
  return s;
};

const getMonthKey = (dateStr) => {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const getWeekKey = (dateStr) => {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const s = new Date(d.getFullYear(), 0, 1);
  const w = Math.ceil(((d - s) / 86400000 + s.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(w).padStart(2, "0")}`;
};

// ─── Keyword lists ──────────────────────────────────────────────────────────
const SUBSCRIPTION_HINTS = [
  "netflix", "hulu", "disney", "spotify", "apple music", "youtube",
  "amazon prime", "hbo", "paramount", "peacock", "audible", "kindle",
  "dropbox", "icloud", "google one", "adobe", "microsoft 365", "office 365",
  "chatgpt", "openai", "midjourney", "gym", "planet fitness",
  "anytime fitness", "equinox", "peloton", "crunch fitness",
  "doordash", "uber eats", "grubhub", "hello fresh", "blue apron",
  "nordvpn", "expressvpn", "1password", "lastpass", "dashlane",
  "patreon", "substack", "medium", "linkedin premium", "headspace", "calm",
  "xbox", "playstation", "nintendo", "ea play", "game pass",
  "sling", "fubo", "crunchyroll", "espn", "sirius", "paramount plus",
  "squarespace", "godaddy", "wix", "shopify", "canva",
  "zoom", "slack", "notion", "grammarly", "max", "tidal", "deezer",
  "apple tv", "discovery", "showtime", "starz", "apple.com/bill",
  "applecom/bill", "applebill", "fansly", "onlyfans", "dl-billing",
  "dlbilling",
];

const BILL_HINTS = [
  "mortgage", "rent", "lease", "hoa", "homeowner",
  "electric", "power", "energy", "gas", "water", "sewer", "trash", "waste",
  "utility", "utilities",
  "insurance", "geico", "state farm", "allstate", "progressive",
  "liberty mutual", "usaa", "farmers",
  "att", "t mobile", "tmobile", "verizon", "sprint",
  "xfinity", "comcast", "spectrum", "cox", "frontier",
  "internet", "cable", "phone", "wireless", "cellular", "broadband",
  "student loan", "car payment", "auto loan",
  "sallie mae", "navient", "fedloan", "nelnet",
  "daycare", "childcare", "tuition", "school",
  "property tax", "hoa dues",
  "citi autopay", "cardmember serv", "autopay",
];

// ─── CSV Parser (handles summary headers, quoted commas, \r\n) ──────────────
function splitCSVLine(line) {
  const cols = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQ = !inQ;
      continue;
    }
    if (ch === "," && !inQ) {
      cols.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

function parseAmount(str) {
  if (!str) return NaN;
  // Remove quotes, dollar signs, and commas inside numbers: "$-14,153.26" → -14153.26
  const cleaned = str.replace(/['"$\s]/g, "").replace(/,/g, "");
  return parseFloat(cleaned);
}

function findHeaderRow(lines) {
  // Look for the row that has "Date" AND ("Description" or similar) AND ("Amount" or "Debit" or "Credit")
  // This skips summary/preamble rows that many bank CSVs include
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const lower = lines[i].toLowerCase();
    const hasDate = /\bdate\b/.test(lower);
    const hasDesc =
      /\b(desc|memo|narr|merchant|payee|transaction|details|particulars|reference)\b/.test(lower) ||
      /\bdescription\b/.test(lower);
    const hasAmount =
      /\b(amount|value|sum|debit|credit|withdrawal|deposit|charge)\b/.test(lower);

    if (hasDate && (hasDesc || hasAmount)) {
      return i;
    }
  }
  // Fallback: return 0
  return 0;
}

function parseCSV(text) {
  // Normalize line endings
  const rawLines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n").filter(Boolean);

  if (rawLines.length < 2) return { transactions: [], headerInfo: "Too few lines" };

  // Find the real header row (skip summary preamble)
  const headerIdx = findHeaderRow(rawLines);
  const headerLine = rawLines[headerIdx];
  const rawHeaders = splitCSVLine(headerLine).map((h) =>
    h.toLowerCase().replace(/['"]/g, "").trim()
  );

  const dateIdx = rawHeaders.findIndex((h) => /\bdate\b/.test(h));
  const descIdx = rawHeaders.findIndex(
    (h) =>
      /\bdesc/.test(h) || /\bmemo\b/.test(h) || /\bnarr/.test(h) ||
      /\bmerchant\b/.test(h) || /\bpayee\b/.test(h) ||
      /\btransaction\b/.test(h) || h === "name" || h === "details" ||
      h === "particulars" || h === "reference"
  );
  const amtIdx = rawHeaders.findIndex(
    (h) => /\bamount\b/.test(h) || h === "value" || h === "sum"
  );
  const debitIdx = rawHeaders.findIndex(
    (h) => /\bdebit\b/.test(h) || /\bwithdrawal\b/.test(h) || /\bcharge\b/.test(h)
  );
  const creditIdx = rawHeaders.findIndex(
    (h) => /\bcredit\b/.test(h) || /\bdeposit\b/.test(h)
  );

  const headerInfo = `Row ${headerIdx}: [${rawHeaders.join(", ")}] → date:${dateIdx} desc:${descIdx} amt:${amtIdx} deb:${debitIdx} cred:${creditIdx}`;

  // Determine sign convention by sampling
  let signFlip = false;
  if (amtIdx >= 0) {
    let pos = 0, neg = 0;
    const sampleEnd = Math.min(rawLines.length, headerIdx + 21);
    for (let i = headerIdx + 1; i < sampleEnd; i++) {
      const cols = splitCSVLine(rawLines[i]);
      const val = parseAmount(cols[amtIdx]);
      if (!isNaN(val)) {
        if (val > 0) pos++;
        else if (val < 0) neg++;
      }
    }
    // If ALL amounts are positive → bank uses positive=debit convention
    signFlip = pos > 0 && neg === 0;
  }

  const transactions = [];
  const skipPatterns = [
    /beginning balance/i, /ending balance/i, /total credits/i,
    /total debits/i, /statement period/i, /account number/i,
  ];

  for (let i = headerIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line) continue;

    const cols = splitCSVLine(line);
    if (cols.length < 2) continue;

    const description = cols[descIdx >= 0 ? descIdx : 1] || "";
    const date = cols[dateIdx >= 0 ? dateIdx : 0] || "";

    // Skip summary/balance rows
    if (skipPatterns.some((p) => p.test(description) || p.test(date))) continue;
    // Skip rows where the date doesn't look like a date
    if (dateIdx >= 0 && !/\d/.test(date)) continue;

    let amount = 0;
    if (amtIdx >= 0) {
      const raw = parseAmount(cols[amtIdx]);
      if (isNaN(raw)) continue; // skip rows with no valid amount
      amount = signFlip ? -Math.abs(raw) : raw;
    } else if (debitIdx >= 0 || creditIdx >= 0) {
      const debit = debitIdx >= 0 ? (parseAmount(cols[debitIdx]) || 0) : 0;
      const credit = creditIdx >= 0 ? (parseAmount(cols[creditIdx]) || 0) : 0;
      amount = credit - debit;
    } else {
      continue; // no amount column found
    }

    if (description) {
      transactions.push({ date, description, amount });
    }
  }

  return { transactions, headerInfo };
}

// ─── Pattern-based Recurring Detection ──────────────────────────────────────
function detectRecurring(transactions) {
  const groups = {};
  transactions.forEach((t) => {
    if (t.amount >= 0) return;
    const payee = normalizePayee(t.description);
    if (!payee || payee.length < 2) return;
    if (!groups[payee]) groups[payee] = { transactions: [], originalDescs: new Set() };
    groups[payee].transactions.push(t);
    groups[payee].originalDescs.add(t.description);
  });

  const subscriptions = [];
  const bills = [];

  Object.entries(groups).forEach(([payee, data]) => {
    const txns = data.transactions;
    const months = new Set(txns.map((t) => getMonthKey(t.date)).filter(Boolean));
    if (months.size < 2) return;

    const amounts = txns.map((t) => Math.abs(t.amount));
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const total = amounts.reduce((a, b) => a + b, 0);
    const consistent = avg > 0 && amounts.every((a) => Math.abs(a - avg) / avg < 0.20);

    const isBill = BILL_HINTS.some((kw) => payee.includes(kw));
    const isSub = SUBSCRIPTION_HINTS.some((kw) => payee.includes(kw));

    const entry = {
      payee,
      originalDesc: [...data.originalDescs][0],
      allDescs: [...data.originalDescs],
      transactions: txns,
      monthCount: months.size,
      months: [...months].sort(),
      avgAmount: avg,
      totalSpent: total,
      isConsistentAmount: consistent,
    };

    if (isBill) bills.push(entry);
    else if (isSub) subscriptions.push(entry);
    else if (consistent && avg > 80) bills.push(entry);
    else if (consistent && avg <= 80) subscriptions.push(entry);
    else if (avg > 40) bills.push(entry);
    else subscriptions.push(entry);
  });

  subscriptions.sort((a, b) => b.totalSpent - a.totalSpent);
  bills.sort((a, b) => b.avgAmount - a.avgAmount);
  return { subscriptions, bills };
}

// ─── Budget Builder ─────────────────────────────────────────────────────────
function buildBudget(transactions) {
  const monthly = {}, weekly = {};
  transactions.forEach((t) => {
    const mK = getMonthKey(t.date), wK = getWeekKey(t.date);
    if (!mK) return;
    if (!monthly[mK]) monthly[mK] = { income: 0, expenses: 0, transactions: [] };
    if (wK && !weekly[wK]) weekly[wK] = { income: 0, expenses: 0, transactions: [] };
    monthly[mK].transactions.push(t);
    if (wK) weekly[wK].transactions.push(t);
    if (t.amount >= 0) {
      monthly[mK].income += t.amount;
      if (wK) weekly[wK].income += t.amount;
    } else {
      monthly[mK].expenses += Math.abs(t.amount);
      if (wK) weekly[wK].expenses += Math.abs(t.amount);
    }
  });
  return { monthly, weekly };
}

function getTopExpenses(transactions, limit = 10) {
  return transactions
    .filter((t) => t.amount < 0)
    .sort((a, b) => a.amount - b.amount)
    .slice(0, limit);
}

// ─── Debt Payoff (Avalanche) ────────────────────────────────────────────────
function debtPayoffPlan(cards) {
  if (!cards.length) return [];
  const sorted = [...cards].sort((a, b) => b.apr - a.apr);
  const totalMin = sorted.reduce((s, c) => s + c.monthlyPayment, 0);
  const extra = totalMin * 0.2;
  return sorted.map((card, i) => {
    let bal = card.balance, mo = 0;
    const rate = card.apr / 12 / 100;
    const pay = card.monthlyPayment + (i === 0 ? extra : 0);
    if (pay <= 0) return { ...card, suggestedPayment: pay, monthsToPayoff: 600, totalInterest: Infinity, priority: i + 1 };
    while (bal > 0 && mo < 600) { bal = bal * (1 + rate) - pay; mo++; if (bal < 0) bal = 0; }
    return { ...card, suggestedPayment: pay, monthsToPayoff: mo, totalInterest: pay * mo - card.balance, priority: i + 1 };
  });
}

// ─── ANALYTICAL MODELS ──────────────────────────────────────────────────────

// Categories for auto-classification
const CATEGORY_RULES = [
  { name: "Dining & Takeout", pattern: /domino|mcdonald|pizza|cafe|restaurant|taco|burger|wendy|chick.?fil|whataburg|sonic|panda|chipotle|favor|grubhub|doordash|uber eat|crumbl|saigon|starbuck|coffee|denny|ihop|applebee|olive garden|panera|subway|wingstop|popeye|arby|jack in|five guys|in.?n.?out|lamppost|rinkside/i },
  { name: "Groceries", pattern: /h-e-b|heb|walmart|kroger|target|costco|aldi|trader joe|whole food|grocery|publix|safeway|food lion|winco/i },
  { name: "Entertainment & Subscriptions", pattern: /netflix|hulu|disney|spotify|apple.*bill|paramount|fansly|onlyfans|dl-billing|game|steam|xbox|playstation|stir|hbo|audible|kindle|crunchyroll/i },
  { name: "Shopping", pattern: /amazon|ebay|etsy|best buy|home depot|lowes|ikea|nike|adidas|marshall|tj.?maxx|ross|old navy|gap|kohls|macys/i },
  { name: "Transport & Gas", pattern: /gas|shell|exxon|chevron|bp|uber|lyft|parking|toll|fuel|valero|murphy|qt\b|buc-ee/i },
  { name: "Bills & Loans", pattern: /autopay|cardmember|insurance|electric|water|internet|phone|att\b|verizon|mortgage|rent|usaa|citi|loan|spectrum|comcast|xfinity/i },
  { name: "Health & Personal", pattern: /cvs|walgreens|pharmacy|doctor|medical|dental|hospital|gym|fitness|haircut|salon|barber/i },
];

function categorizeTransaction(desc) {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(desc)) return rule.name;
  }
  return "Other";
}

// ═══════════════════════════════════════════════════════════════════════════
// MODEL 1: Spending Category Breakdown & Concentration Risk
// Identifies which categories consume the most budget and flags over-concentration
// ═══════════════════════════════════════════════════════════════════════════
function modelCategoryBreakdown(transactions) {
  const expenses = transactions.filter((t) => t.amount < 0);
  const totalExpenses = expenses.reduce((s, t) => s + Math.abs(t.amount), 0);
  const totalIncome = transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);

  const cats = {};
  expenses.forEach((t) => {
    const cat = categorizeTransaction(t.description);
    if (!cats[cat]) cats[cat] = { count: 0, total: 0, transactions: [] };
    cats[cat].count++;
    cats[cat].total += Math.abs(t.amount);
    cats[cat].transactions.push(t);
  });

  const sorted = Object.entries(cats)
    .map(([name, data]) => ({
      name,
      ...data,
      pctOfExpenses: totalExpenses > 0 ? data.total / totalExpenses : 0,
      pctOfIncome: totalIncome > 0 ? data.total / totalIncome : 0,
      avgPerTxn: data.count > 0 ? data.total / data.count : 0,
    }))
    .sort((a, b) => b.total - a.total);

  return { categories: sorted, totalExpenses, totalIncome };
}

// ═══════════════════════════════════════════════════════════════════════════
// MODEL 2: Temporal Spending Patterns (day-of-week, weekly trend, impulse)
// Detects when spending peaks occur and identifies impulse purchase patterns
// ═══════════════════════════════════════════════════════════════════════════
function modelTemporalPatterns(transactions) {
  const expenses = transactions.filter((t) => t.amount < 0);
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const byDay = {};
  dayNames.forEach((d) => (byDay[d] = { count: 0, total: 0 }));

  expenses.forEach((t) => {
    const d = new Date(t.date);
    if (isNaN(d)) return;
    const day = dayNames[d.getDay()];
    byDay[day].count++;
    byDay[day].total += Math.abs(t.amount);
  });

  const dayData = dayNames.map((d) => ({
    day: d,
    ...byDay[d],
    avg: byDay[d].count > 0 ? byDay[d].total / byDay[d].count : 0,
  }));

  const avgDailyTotal = dayData.reduce((s, d) => s + d.total, 0) / 7;
  const peakDay = dayData.reduce((best, d) => (d.total > best.total ? d : best), dayData[0]);
  const calmDay = dayData.filter((d) => d.count > 0).reduce((best, d) => (d.total < best.total ? d : best), dayData[0]);

  // Weekly trend (is spending accelerating or decelerating?)
  const weekMap = {};
  expenses.forEach((t) => {
    const d = new Date(t.date);
    if (isNaN(d)) return;
    const ws = new Date(d);
    ws.setDate(d.getDate() - d.getDay());
    const key = ws.toISOString().split("T")[0];
    if (!weekMap[key]) weekMap[key] = 0;
    weekMap[key] += Math.abs(t.amount);
  });
  const weeklyTrend = Object.entries(weekMap).sort(([a], [b]) => a.localeCompare(b)).map(([week, total]) => ({ week, total }));

  // Impulse score: ratio of small (<$25) frequent transactions
  const smallTxns = expenses.filter((t) => Math.abs(t.amount) < 25);
  const smallTotal = smallTxns.reduce((s, t) => s + Math.abs(t.amount), 0);
  const totalExp = expenses.reduce((s, t) => s + Math.abs(t.amount), 0);
  const impulseRatio = totalExp > 0 ? smallTotal / totalExp : 0;

  return { dayData, peakDay, calmDay, avgDailyTotal, weeklyTrend, impulseRatio, smallTxnCount: smallTxns.length, smallTxnTotal: smallTotal };
}

// ═══════════════════════════════════════════════════════════════════════════
// MODEL 3: Merchant Frequency & Habit Detection
// Finds the merchants you visit most and estimates savings from reducing frequency
// ═══════════════════════════════════════════════════════════════════════════
function modelMerchantHabits(transactions) {
  const expenses = transactions.filter((t) => t.amount < 0);
  const groups = {};
  expenses.forEach((t) => {
    const payee = normalizePayee(t.description);
    if (!payee || payee.length < 2) return;
    if (!groups[payee]) groups[payee] = { count: 0, total: 0, amounts: [], dates: [] };
    groups[payee].count++;
    groups[payee].total += Math.abs(t.amount);
    groups[payee].amounts.push(Math.abs(t.amount));
    groups[payee].dates.push(t.date);
  });

  const merchants = Object.entries(groups)
    .map(([name, data]) => ({
      name,
      ...data,
      avg: data.total / data.count,
      // If you cut visits by half, this is what you'd save
      savingsIfHalved: data.total / 2,
      // Frequency: visits per week (approximate)
      frequency: (() => {
        if (data.dates.length < 2) return 0;
        const sorted = data.dates.map((d) => new Date(d).getTime()).sort();
        const spanDays = (sorted[sorted.length - 1] - sorted[0]) / 86400000;
        return spanDays > 0 ? (data.count / spanDays) * 7 : 0;
      })(),
    }))
    .filter((m) => m.count >= 2)
    .sort((a, b) => b.total - a.total);

  return { merchants };
}

// ═══════════════════════════════════════════════════════════════════════════
// MODEL 4: Debt Snowball vs Avalanche vs Hybrid Simulation
// Runs 3 separate payoff simulations and compares total cost & time
// ═══════════════════════════════════════════════════════════════════════════
function modelDebtStrategies(cards, monthlyBudget) {
  if (!cards.length) return null;
  const totalMinPayments = cards.reduce((s, c) => s + c.monthlyPayment, 0);
  const extraBudget = monthlyBudget > 0 ? monthlyBudget : totalMinPayments * 0.2;

  function simulate(cardOrder, extra) {
    const balances = cardOrder.map((c) => ({ ...c, remaining: c.balance }));
    let months = 0, totalPaid = 0, totalInterest = 0;
    const timeline = [];

    while (balances.some((c) => c.remaining > 0) && months < 600) {
      months++;
      let extraLeft = extra;
      // Apply interest
      balances.forEach((c) => {
        if (c.remaining > 0) {
          const interest = c.remaining * (c.apr / 12 / 100);
          c.remaining += interest;
          totalInterest += interest;
        }
      });
      // Pay minimums
      balances.forEach((c) => {
        if (c.remaining > 0) {
          const pay = Math.min(c.monthlyPayment, c.remaining);
          c.remaining -= pay;
          totalPaid += pay;
        }
      });
      // Pay extra toward first card with balance
      for (const c of balances) {
        if (c.remaining > 0 && extraLeft > 0) {
          const pay = Math.min(extraLeft, c.remaining);
          c.remaining -= pay;
          totalPaid += pay;
          extraLeft -= pay;
        }
      }
      if (months % 6 === 0 || !balances.some((c) => c.remaining > 0)) {
        timeline.push({ month: months, totalRemaining: balances.reduce((s, c) => s + Math.max(0, c.remaining), 0) });
      }
    }
    return { months, totalPaid, totalInterest, timeline };
  }

  // Avalanche: highest interest first
  const avalancheOrder = [...cards].sort((a, b) => b.apr - a.apr);
  const avalanche = simulate(avalancheOrder, extraBudget);

  // Snowball: lowest balance first
  const snowballOrder = [...cards].sort((a, b) => a.balance - b.balance);
  const snowball = simulate(snowballOrder, extraBudget);

  // Hybrid: score = interest_rate * 0.6 + (1/balance) * 0.4 (normalized)
  const maxRate = Math.max(...cards.map((c) => c.apr)) || 1;
  const maxBal = Math.max(...cards.map((c) => c.balance)) || 1;
  const hybridOrder = [...cards].sort((a, b) => {
    const scoreA = (a.apr / maxRate) * 0.6 + (1 - a.balance / maxBal) * 0.4;
    const scoreB = (b.apr / maxRate) * 0.6 + (1 - b.balance / maxBal) * 0.4;
    return scoreB - scoreA;
  });
  const hybrid = simulate(hybridOrder, extraBudget);

  // Minimum-only baseline (no extra payments)
  const baseline = simulate([...cards], 0);

  return { avalanche, snowball, hybrid, baseline, extraBudget, totalDebt: cards.reduce((s, c) => s + c.balance, 0) };
}

// ═══════════════════════════════════════════════════════════════════════════
// MODEL 5: Savings Reallocation Simulator
// Models what happens if you redirect specific savings into debt payments
// ═══════════════════════════════════════════════════════════════════════════
function modelSavingsReallocation(transactions, cards, subscriptions, bills) {
  if (!cards.length) return null;
  const expenses = transactions.filter((t) => t.amount < 0);
  const totalExp = expenses.reduce((s, t) => s + Math.abs(t.amount), 0);
  const months = new Set(transactions.map((t) => getMonthKey(t.date)).filter(Boolean)).size || 1;
  const monthlyExpenses = totalExp / months;

  // Scenario A: Cut subscriptions by 50%
  const subSavings = subscriptions.reduce((s, sub) => s + sub.avgAmount, 0) * 0.5;

  // Scenario B: Reduce dining/takeout by 40%
  const diningCat = modelCategoryBreakdown(transactions).categories.find((c) => c.name === "Dining & Takeout");
  const diningSavings = diningCat ? (diningCat.total / months) * 0.4 : 0;

  // Scenario C: Eliminate small impulse purchases (<$15) by 60%
  const smallTxns = expenses.filter((t) => Math.abs(t.amount) < 15);
  const impulseSavings = (smallTxns.reduce((s, t) => s + Math.abs(t.amount), 0) / months) * 0.6;

  const totalPotentialSavings = subSavings + diningSavings + impulseSavings;

  // Simulate debt payoff with extra savings applied
  function simWithExtra(extra) {
    if (!cards.length) return { months: 0 };
    const sorted = [...cards].sort((a, b) => b.apr - a.apr);
    const balances = sorted.map((c) => ({ ...c, remaining: c.balance }));
    let mo = 0, totalInt = 0;
    while (balances.some((c) => c.remaining > 0) && mo < 600) {
      mo++;
      let extraLeft = extra;
      balances.forEach((c) => {
        if (c.remaining > 0) { const i = c.remaining * (c.apr / 12 / 100); c.remaining += i; totalInt += i; }
      });
      balances.forEach((c) => {
        if (c.remaining > 0) { const p = Math.min(c.monthlyPayment, c.remaining); c.remaining -= p; }
      });
      for (const c of balances) {
        if (c.remaining > 0 && extraLeft > 0) { const p = Math.min(extraLeft, c.remaining); c.remaining -= p; extraLeft -= p; }
      }
    }
    return { months: mo, totalInterest: totalInt };
  }

  const currentPayoff = simWithExtra(0);
  const withSavingsPayoff = simWithExtra(totalPotentialSavings);

  return {
    scenarios: [
      { name: "Cut subscriptions 50%", monthlySavings: subSavings },
      { name: "Reduce dining/takeout 40%", monthlySavings: diningSavings },
      { name: "Curb impulse buys (<$15) 60%", monthlySavings: impulseSavings },
    ],
    totalPotentialSavings,
    monthlyExpenses,
    currentPayoffMonths: currentPayoff.months,
    newPayoffMonths: withSavingsPayoff.months,
    interestSaved: currentPayoff.totalInterest - withSavingsPayoff.totalInterest,
    monthsSaved: currentPayoff.months - withSavingsPayoff.months,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MODEL 6: Cash Flow Stress Test
// Tests if current spending rate is sustainable and projects future balance
// ═══════════════════════════════════════════════════════════════════════════
function modelCashFlowProjection(transactions) {
  const monthData = {};
  transactions.forEach((t) => {
    const mK = getMonthKey(t.date);
    if (!mK) return;
    if (!monthData[mK]) monthData[mK] = { income: 0, expenses: 0 };
    if (t.amount >= 0) monthData[mK].income += t.amount;
    else monthData[mK].expenses += Math.abs(t.amount);
  });

  const months = Object.entries(monthData).sort(([a], [b]) => a.localeCompare(b));
  const avgIncome = months.reduce((s, [, v]) => s + v.income, 0) / (months.length || 1);
  const avgExpenses = months.reduce((s, [, v]) => s + v.expenses, 0) / (months.length || 1);
  const netMonthly = avgIncome - avgExpenses;
  const burnRate = avgIncome > 0 ? avgExpenses / avgIncome : Infinity;

  // Project 6 months forward
  const projection = [];
  let balance = netMonthly; // assume starting from current month's net
  for (let i = 1; i <= 6; i++) {
    balance += netMonthly;
    projection.push({ month: i, balance });
  }

  return {
    avgIncome,
    avgExpenses,
    netMonthly,
    burnRate,
    isDeficit: netMonthly < 0,
    monthlyDeficit: netMonthly < 0 ? Math.abs(netMonthly) : 0,
    projection,
    sustainabilityScore: Math.min(100, Math.max(0, ((avgIncome - avgExpenses) / avgIncome) * 100 * 2)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MASTER INSIGHT GENERATOR
// Runs all models and produces the 3 behavioral + 3 debt recommendations
// ═══════════════════════════════════════════════════════════════════════════
function generateInsights(transactions, cards, subscriptions, bills) {
  const catModel = modelCategoryBreakdown(transactions);
  const temporalModel = modelTemporalPatterns(transactions);
  const merchantModel = modelMerchantHabits(transactions);
  const debtModel = modelDebtStrategies(cards, 0);
  const savingsModel = modelSavingsReallocation(transactions, cards, subscriptions, bills);
  const cashFlowModel = modelCashFlowProjection(transactions);

  // ── BEHAVIORAL INSIGHT 1: Biggest discretionary category to cut ──
  const discretionary = catModel.categories.filter((c) =>
    ["Dining & Takeout", "Entertainment & Subscriptions", "Shopping", "Other"].includes(c.name)
  );
  const topDiscretionary = discretionary[0];
  const months = new Set(transactions.map((t) => getMonthKey(t.date)).filter(Boolean)).size || 1;

  const behavioral1 = topDiscretionary
    ? {
        title: `Reduce ${topDiscretionary.name} spending`,
        icon: "🍽️",
        metric: fmt(topDiscretionary.total / months) + "/mo",
        metricLabel: `${(topDiscretionary.pctOfExpenses * 100).toFixed(0)}% of expenses`,
        description: `${topDiscretionary.name} is your largest discretionary category at ${fmt(topDiscretionary.total / months)}/mo across ${topDiscretionary.count} transactions. A 30% reduction would save ${fmt((topDiscretionary.total / months) * 0.3)}/mo.`,
        savingsPotential: (topDiscretionary.total / months) * 0.3,
        evidence: topDiscretionary,
        severity: topDiscretionary.pctOfExpenses > 0.25 ? "high" : topDiscretionary.pctOfExpenses > 0.15 ? "medium" : "low",
      }
    : null;

  // ── BEHAVIORAL INSIGHT 2: Peak spending day / impulse pattern ──
  const behavioral2 = {
    title: `${temporalModel.peakDay.day} spending spikes`,
    icon: "📅",
    metric: fmt(temporalModel.peakDay.total),
    metricLabel: `${temporalModel.peakDay.count} transactions on ${temporalModel.peakDay.day}s`,
    description: `You spend ${fmt(temporalModel.peakDay.total)} on ${temporalModel.peakDay.day}s — ${((temporalModel.peakDay.total / (temporalModel.dayData.reduce((s, d) => s + d.total, 0) || 1)) * 100).toFixed(0)}% of all spending on one day. ${temporalModel.peakDay.day}s average ${fmt(temporalModel.peakDay.avg)} per transaction vs ${fmt(temporalModel.calmDay.avg)} on ${temporalModel.calmDay.day}s. Setting a daily cap on ${temporalModel.peakDay.day}s could save ${fmt(temporalModel.peakDay.total * 0.25)}.`,
    savingsPotential: temporalModel.peakDay.total * 0.25,
    severity: temporalModel.peakDay.total / (temporalModel.avgDailyTotal || 1) > 1.5 ? "high" : "medium",
  };

  // ── BEHAVIORAL INSIGHT 3: Merchant habit & small purchase accumulation ──
  const topHabitMerchant = merchantModel.merchants.find(
    (m) => m.count >= 3 && m.avg < 50
  );
  const behavioral3 = {
    title: "Small purchase accumulation",
    icon: "🛒",
    metric: fmt(temporalModel.smallTxnTotal),
    metricLabel: `${temporalModel.smallTxnCount} purchases under $25`,
    description: topHabitMerchant
      ? `You have ${temporalModel.smallTxnCount} small purchases totaling ${fmt(temporalModel.smallTxnTotal)}. Your most frequent is "${topHabitMerchant.name}" (${topHabitMerchant.count}x, ${fmt(topHabitMerchant.total)}). Cutting these habitual visits by half saves ${fmt(topHabitMerchant.savingsIfHalved)}.`
      : `${temporalModel.smallTxnCount} purchases under $25 add up to ${fmt(temporalModel.smallTxnTotal)} — ${((temporalModel.impulseRatio) * 100).toFixed(0)}% of spending. A 48-hour rule on non-essential small purchases could cut this significantly.`,
    savingsPotential: topHabitMerchant ? topHabitMerchant.savingsIfHalved : temporalModel.smallTxnTotal * 0.3,
    severity: temporalModel.impulseRatio > 0.1 ? "medium" : "low",
    topMerchants: merchantModel.merchants.slice(0, 5),
  };

  // ── DEBT STRATEGY 1: Avalanche vs Snowball comparison ──
  const debt1 = debtModel
    ? {
        title: "Avalanche method (recommended)",
        icon: "⛰️",
        metric: debtModel.avalanche.months < 600 ? `${debtModel.avalanche.months} months` : "N/A",
        metricLabel: debtModel.avalanche.months < 600 ? `Saves ${fmt(debtModel.snowball.totalInterest - debtModel.avalanche.totalInterest)} vs snowball` : "Increase payments first",
        description: debtModel.avalanche.months < 600
          ? `Pay highest-rate card first with ${fmt(debtModel.extraBudget)}/mo extra. Total interest: ${fmt(debtModel.avalanche.totalInterest)} (avalanche) vs ${fmt(debtModel.snowball.totalInterest)} (snowball) vs ${fmt(debtModel.baseline.totalInterest)} (minimums only). Avalanche saves you ${debtModel.baseline.months - debtModel.avalanche.months} months over minimum payments.`
          : `With current payments, some cards never pay off. Increase minimum payments above the monthly interest charge before choosing a strategy.`,
        comparison: { avalanche: debtModel.avalanche, snowball: debtModel.snowball, hybrid: debtModel.hybrid, baseline: debtModel.baseline },
        severity: debtModel.baseline.months >= 600 ? "high" : "medium",
      }
    : null;

  // ── DEBT STRATEGY 2: Savings reallocation impact ──
  const debt2 = savingsModel
    ? {
        title: "Redirect savings to debt",
        icon: "🔄",
        metric: fmt(savingsModel.totalPotentialSavings) + "/mo",
        metricLabel: savingsModel.monthsSaved > 0 ? `${savingsModel.monthsSaved} months faster payoff` : "Calculate with debt entries",
        description: `By combining: ${savingsModel.scenarios.map((s) => `${s.name} (${fmt(s.monthlySavings)}/mo)`).join(", ")} — you free up ${fmt(savingsModel.totalPotentialSavings)}/mo. Applied to debt, this cuts payoff from ${savingsModel.currentPayoffMonths < 600 ? savingsModel.currentPayoffMonths + " months" : "never"} to ${savingsModel.newPayoffMonths < 600 ? savingsModel.newPayoffMonths + " months" : "still insufficient"}, saving ${fmt(savingsModel.interestSaved)} in interest.`,
        scenarios: savingsModel.scenarios,
        severity: savingsModel.totalPotentialSavings > 100 ? "high" : "medium",
      }
    : null;

  // ── DEBT STRATEGY 3: Cash flow sustainability warning ──
  const debt3 = {
    title: cashFlowModel.isDeficit ? "Cash flow deficit alert" : "Cash flow optimization",
    icon: cashFlowModel.isDeficit ? "🚨" : "📈",
    metric: fmt(Math.abs(cashFlowModel.netMonthly)) + "/mo",
    metricLabel: cashFlowModel.isDeficit ? "Monthly shortfall" : "Monthly surplus",
    description: cashFlowModel.isDeficit
      ? `You're spending ${fmt(cashFlowModel.monthlyDeficit)}/mo more than you earn (burn rate: ${(cashFlowModel.burnRate * 100).toFixed(0)}% of income). At this rate, debt will grow even with payments. Priority: cut expenses by at least ${fmt(cashFlowModel.monthlyDeficit)} before accelerating debt payoff.`
      : `You have a ${fmt(cashFlowModel.netMonthly)}/mo surplus (spending ${(cashFlowModel.burnRate * 100).toFixed(0)}% of income). Directing this surplus to debt would significantly accelerate payoff. Your sustainability score is ${cashFlowModel.sustainabilityScore.toFixed(0)}/100.`,
    cashFlow: cashFlowModel,
    severity: cashFlowModel.isDeficit ? "high" : cashFlowModel.burnRate > 0.9 ? "medium" : "low",
  };

  return {
    behavioral: [behavioral1, behavioral2, behavioral3].filter(Boolean),
    debt: [debt1, debt2, debt3].filter(Boolean),
    models: { catModel, temporalModel, merchantModel, debtModel, savingsModel, cashFlowModel },
  };
}
const Card = ({ children, className = "", style = {} }) => (
  <div className={`rounded-2xl border border-gray-200 bg-white shadow-sm ${className}`} style={style}>{children}</div>
);

const Badge = ({ children, color = "emerald" }) => {
  const c = {
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    red: "bg-red-50 text-red-700 border-red-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    purple: "bg-purple-50 text-purple-700 border-purple-200",
    gray: "bg-gray-50 text-gray-600 border-gray-200",
  };
  return <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full border ${c[color]}`}>{children}</span>;
};

const StatCard = ({ label, value, color, sub }) => (
  <Card className="p-4">
    <div className="text-xs text-gray-500 mb-1">{label}</div>
    <div style={{ fontFamily: "'Fraunces', serif", fontSize: "1.2rem", fontWeight: 600, color }}>{value}</div>
    {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
  </Card>
);

// ─── Main App ───────────────────────────────────────────────────────────────
export default function FinancialPlanner() {
  const [tab, setTab] = useState("upload");
  const [transactions, setTransactions] = useState([]);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [cards, setCards] = useState([]);
  const [cardForm, setCardForm] = useState({ name: "", balance: "", interest: "", payment: "" });
  const [budgetView, setBudgetView] = useState("monthly");
  const [parseLog, setParseLog] = useState([]);
  const [expandedPeriods, setExpandedPeriods] = useState(new Set());

  const { subscriptions, bills } = useMemo(() => detectRecurring(transactions), [transactions]);
  const budget = useMemo(() => buildBudget(transactions), [transactions]);
  const debtPlan = useMemo(() => debtPayoffPlan(cards), [cards]);
  const insights = useMemo(
    () => (transactions.length > 0 ? generateInsights(transactions, cards, subscriptions, bills) : null),
    [transactions, cards, subscriptions, bills]
  );
  const totalSubMonthly = subscriptions.reduce((s, sub) => s + sub.avgAmount, 0);
  const totalBillMonthly = bills.reduce((s, b) => s + b.avgAmount, 0);

  const handleFileUpload = useCallback((e) => {
    Array.from(e.target.files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target.result;
        const { transactions: parsed, headerInfo } = parseCSV(text);
        const expenseCount = parsed.filter((t) => t.amount < 0).length;
        const incomeCount = parsed.filter((t) => t.amount > 0).length;

        setParseLog((prev) => [...prev, {
          file: file.name,
          total: parsed.length,
          expenses: expenseCount,
          income: incomeCount,
          headerInfo,
          sampleTxns: parsed.slice(0, 3),
        }]);

        setTransactions((prev) => [...prev, ...parsed]);
        setUploadedFiles((prev) => [...prev, { name: file.name, count: parsed.length, expenses: expenseCount }]);
      };
      reader.readAsText(file);
    });
    e.target.value = "";
  }, []);

  const clearAll = () => { setTransactions([]); setUploadedFiles([]); setParseLog([]); };

  const addCard = () => {
    if (!cardForm.name || !cardForm.balance) return;
    setCards((p) => [...p, {
      id: Date.now(), name: cardForm.name,
      balance: parseFloat(cardForm.balance) || 0,
      apr: parseFloat(cardForm.interest) || 0,
      monthlyPayment: parseFloat(cardForm.payment) || 0,
    }]);
    setCardForm({ name: "", balance: "", interest: "", payment: "" });
  };

  const removeCard = (id) => setCards((p) => p.filter((c) => c.id !== id));
  const hasData = transactions.length > 0;
  const expenseCount = transactions.filter((t) => t.amount < 0).length;
  const monthCount = Object.keys(budget.monthly).length;

  const tabs = [
    { id: "upload", label: "Import", icon: "↑" },
    { id: "subscriptions", label: "Subscriptions", icon: "⟳", count: subscriptions.length },
    { id: "bills", label: "Fixed Bills", icon: "◉", count: bills.length },
    { id: "budget", label: "Budget", icon: "◫" },
    { id: "insights", label: "Insights", icon: "✦" },
    { id: "debt", label: "Debt Payoff", icon: "↓" },
  ];

  return (
    <div style={{ fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif", background: "linear-gradient(160deg, #f8faf9 0%, #f0f4f8 50%, #f5f0f6 100%)", minHeight: "100vh" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&display=swap" rel="stylesheet" />

      {/* Header */}
      <header className="px-6 py-5 flex items-center justify-between" style={{ borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold" style={{ background: "linear-gradient(135deg, #1a7a5c, #2d9d78)" }}>₿</div>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: "1.35rem", fontWeight: 600, color: "#1a1a1a", letterSpacing: "-0.02em" }}>Mint&nbsp;Lens</h1>
        </div>
        {hasData && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
            {transactions.length} transactions · {expenseCount} expenses · {uploadedFiles.length} file{uploadedFiles.length !== 1 ? "s" : ""} · {monthCount} month{monthCount !== 1 ? "s" : ""}
          </div>
        )}
      </header>

      <div className="flex" style={{ minHeight: "calc(100vh - 65px)" }}>
        {/* Sidebar */}
        <nav className="flex flex-col gap-1 p-3" style={{ width: 210, borderRight: "1px solid rgba(0,0,0,0.06)" }}>
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition-all"
              style={{ fontSize: "0.85rem", fontWeight: tab === t.id ? 600 : 400, background: tab === t.id ? "white" : "transparent", color: tab === t.id ? "#1a7a5c" : "#6b7280", boxShadow: tab === t.id ? "0 1px 4px rgba(0,0,0,0.06)" : "none" }}>
              <span style={{ fontSize: "1rem", opacity: 0.8 }}>{t.icon}</span>
              <span className="flex-1">{t.label}</span>
              {t.count > 0 && <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: tab === t.id ? "#d1fae5" : "#f3f4f6", color: tab === t.id ? "#065f46" : "#6b7280" }}>{t.count}</span>}
            </button>
          ))}
        </nav>

        {/* Main Content */}
        <main className="flex-1 p-6 overflow-auto" style={{ maxHeight: "calc(100vh - 65px)" }}>

          {/* ── UPLOAD ──────────────────────────────────────── */}
          {tab === "upload" && (
            <div className="max-w-2xl mx-auto space-y-6">
              <div>
                <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: "1.6rem", fontWeight: 600, color: "#1a1a1a", marginBottom: 4 }}>Import your data</h2>
                <p className="text-sm text-gray-500">Upload multiple months of bank statements so recurring charges can be identified. Add credit card details for debt payoff guidance.</p>
              </div>

              <Card className="p-6">
                <h3 className="text-sm font-semibold text-gray-800 mb-1">Bank Statements (CSV)</h3>
                <p className="text-xs text-gray-500 mb-4">Upload multiple CSV files — ideally 3+ months. The parser auto-detects headers, skips summary rows, and handles quoted amounts with commas.</p>
                <label className="flex flex-col items-center justify-center gap-2 p-8 border-2 border-dashed rounded-xl cursor-pointer transition-colors hover:border-emerald-400 hover:bg-emerald-50/30" style={{ borderColor: uploadedFiles.length ? "#34d399" : "#d1d5db" }}>
                  <input type="file" accept=".csv" multiple onChange={handleFileUpload} className="hidden" />
                  <span style={{ fontSize: "2rem" }}>{uploadedFiles.length ? "+" : "⬆"}</span>
                  <span className="text-sm font-medium text-gray-700">{uploadedFiles.length ? "Click to add more CSVs" : "Click to upload CSV files"}</span>
                  <span className="text-xs text-gray-400">Select multiple files at once or upload in batches</span>
                </label>

                {uploadedFiles.length > 0 && (
                  <div className="mt-4 space-y-2">
                    {uploadedFiles.map((f, i) => (
                      <div key={i} className="flex items-center justify-between px-3 py-2 rounded-lg bg-emerald-50 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="text-emerald-600">✓</span>
                          <span className="font-medium text-gray-700">{f.name}</span>
                        </div>
                        <div className="flex gap-2">
                          <Badge color="emerald">{f.count} rows</Badge>
                          <Badge color="gray">{f.expenses} expenses</Badge>
                        </div>
                      </div>
                    ))}
                    <button onClick={clearAll} className="text-xs text-red-500 hover:text-red-700 mt-1">Clear all uploads</button>
                  </div>
                )}

                {parseLog.length > 0 && (
                  <details className="mt-3">
                    <summary className="text-xs text-gray-400 cursor-pointer">Parse details (click to expand)</summary>
                    <div className="mt-2 space-y-3 text-xs text-gray-500 bg-gray-50 rounded-lg p-3 font-mono">
                      {parseLog.map((log, i) => (
                        <div key={i}>
                          <div className="font-semibold text-gray-700 font-sans">{log.file}</div>
                          <div>Columns: {log.headerInfo}</div>
                          <div>Parsed: {log.total} total, {log.expenses} expenses, {log.income} income</div>
                          {log.sampleTxns.length > 0 && (
                            <div className="mt-1 pl-2 border-l-2 border-gray-200">
                              {log.sampleTxns.map((t, j) => (
                                <div key={j} className="text-gray-500">{t.date} | {t.description.substring(0, 50)} | {fmt(t.amount)}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                      <div className="pt-2 border-t border-gray-200 font-sans">
                        <div className="font-medium text-gray-700">Detection Results:</div>
                        <div>{subscriptions.length} subscriptions, {bills.length} fixed bills across {monthCount} months</div>
                      </div>
                    </div>
                  </details>
                )}
              </Card>

              <Card className="p-6">
                <h3 className="text-sm font-semibold text-gray-800 mb-1">Credit Card Debts</h3>
                <p className="text-xs text-gray-500 mb-4">Add each card with its current balance, purchase APR (found on your statement, e.g. 24.99%), and current monthly payment.</p>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  {[
                    { key: "name", label: "Card Name", placeholder: "e.g. Chase Sapphire" },
                    { key: "balance", label: "Balance ($)", placeholder: "5000" },
                    { key: "interest", label: "Purchase APR %", placeholder: "24.99" },
                    { key: "payment", label: "Monthly Payment ($)", placeholder: "200" },
                  ].map((f) => (
                    <div key={f.key}>
                      <label className="block text-xs font-medium text-gray-600 mb-1">{f.label}</label>
                      <input type={f.key === "name" ? "text" : "number"} step="any" placeholder={f.placeholder} value={cardForm[f.key]}
                        onChange={(e) => setCardForm((p) => ({ ...p, [f.key]: e.target.value }))}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-300" />
                    </div>
                  ))}
                </div>
                <button onClick={addCard} className="px-4 py-2 text-sm font-medium rounded-lg text-white" style={{ background: "#1a7a5c" }}>+ Add Card</button>
                {cards.length > 0 && (
                  <div className="mt-4 space-y-2">
                    {cards.map((c) => (
                      <div key={c.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-50 text-sm">
                        <div>
                          <span className="font-medium text-gray-800">{c.name}</span>
                          <span className="mx-2 text-gray-300">·</span><span className="text-gray-600">{fmt(c.balance)}</span>
                          <span className="mx-2 text-gray-300">·</span><span className="text-gray-500">{c.apr}% APR</span>
                          <span className="mx-2 text-gray-300">·</span><span className="text-gray-500">{fmt(c.monthlyPayment)}/mo</span>
                        </div>
                        <button onClick={() => removeCard(c.id)} className="text-red-400 hover:text-red-600 text-xs font-medium">Remove</button>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              {(hasData || cards.length > 0) && (
                <div className="text-center pt-2">
                  <button onClick={() => setTab(hasData ? "subscriptions" : "debt")} className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-transform hover:scale-105" style={{ background: "linear-gradient(135deg, #1a7a5c, #2d9d78)" }}>
                    Continue to Analysis →
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── SUBSCRIPTIONS ──────────────────────────────── */}
          {tab === "subscriptions" && (
            <div className="max-w-3xl mx-auto space-y-5">
              <div className="flex items-end justify-between">
                <div>
                  <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: "1.6rem", fontWeight: 600, color: "#1a1a1a", marginBottom: 4 }}>Subscriptions</h2>
                  <p className="text-sm text-gray-500">Recurring charges detected by matching payees across multiple months.</p>
                </div>
                {subscriptions.length > 0 && (
                  <div className="text-right">
                    <div className="text-xs text-gray-500">Est. monthly total</div>
                    <div style={{ fontFamily: "'Fraunces', serif", fontSize: "1.3rem", fontWeight: 600, color: "#dc2626" }}>{fmt(totalSubMonthly)}</div>
                  </div>
                )}
              </div>
              {!hasData ? (
                <Card className="p-10 text-center text-gray-400 text-sm">Upload bank statements first to detect subscriptions.</Card>
              ) : subscriptions.length === 0 ? (
                <Card className="p-10 text-center">
                  <span style={{ fontSize: "2rem" }}>🔍</span>
                  <p className="text-sm text-gray-600 mt-2">No subscriptions detected yet.</p>
                  <p className="text-xs text-gray-400 mt-1">This requires the same payee in at least 2 different months. Upload more monthly statements. Currently: {monthCount} month{monthCount !== 1 ? "s" : ""}, {expenseCount} expenses.</p>
                </Card>
              ) : (
                <div className="space-y-3">
                  {subscriptions.map((sub, i) => (
                    <Card key={i} className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold" style={{ background: `hsl(${(i * 47 + 200) % 360}, 40%, 94%)`, color: `hsl(${(i * 47 + 200) % 360}, 50%, 40%)` }}>
                            {sub.payee[0]?.toUpperCase() || "?"}
                          </div>
                          <div>
                            <div className="text-sm font-semibold text-gray-800 capitalize">{sub.payee}</div>
                            <div className="text-xs text-gray-500">{sub.monthCount} months · {sub.isConsistentAmount ? "Fixed amount" : "Varying amount"} · {sub.transactions.length} charges</div>
                            {sub.allDescs.length > 0 && <div className="text-xs text-gray-400 italic mt-0.5 truncate max-w-md">{sub.allDescs[0].substring(0, 60)}</div>}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-semibold text-red-600">~{fmt(sub.avgAmount)}/mo</div>
                          <Badge color="purple">Subscription</Badge>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1 mt-2 pl-14">
                        {sub.months.map((m) => <span key={m} className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{m}</span>)}
                      </div>
                    </Card>
                  ))}
                  <Card className="p-4" style={{ background: "linear-gradient(135deg, #fef3c7, #fde68a)" }}>
                    <div className="flex items-start gap-3">
                      <span className="text-xl">💡</span>
                      <div>
                        <div className="text-sm font-semibold text-amber-900">Savings Opportunity</div>
                        <p className="text-xs text-amber-800 mt-1">You're spending roughly <strong>{fmt(totalSubMonthly)}</strong>/month ({fmt(totalSubMonthly * 12)}/year) on subscriptions. Review each and cancel what you don't actively use.</p>
                      </div>
                    </div>
                  </Card>
                </div>
              )}
            </div>
          )}

          {/* ── FIXED BILLS ────────────────────────────────── */}
          {tab === "bills" && (
            <div className="max-w-3xl mx-auto space-y-5">
              <div className="flex items-end justify-between">
                <div>
                  <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: "1.6rem", fontWeight: 600, color: "#1a1a1a", marginBottom: 4 }}>Fixed Monthly Bills</h2>
                  <p className="text-sm text-gray-500">Recurring expenses like housing, utilities, insurance, and loans.</p>
                </div>
                {bills.length > 0 && (
                  <div className="text-right">
                    <div className="text-xs text-gray-500">Est. monthly total</div>
                    <div style={{ fontFamily: "'Fraunces', serif", fontSize: "1.3rem", fontWeight: 600, color: "#1a7a5c" }}>{fmt(totalBillMonthly)}</div>
                  </div>
                )}
              </div>
              {!hasData ? (
                <Card className="p-10 text-center text-gray-400 text-sm">Upload bank statements first to detect fixed bills.</Card>
              ) : bills.length === 0 ? (
                <Card className="p-10 text-center">
                  <span style={{ fontSize: "2rem" }}>📋</span>
                  <p className="text-sm text-gray-600 mt-2">No fixed bills detected yet.</p>
                  <p className="text-xs text-gray-400 mt-1">Upload more months for better matching. Currently: {monthCount} month{monthCount !== 1 ? "s" : ""}.</p>
                </Card>
              ) : (
                <div className="space-y-3">
                  {bills.map((bill, i) => (
                    <Card key={i} className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg" style={{ background: "#ecfdf5", color: "#065f46" }}>
                            {bill.avgAmount > 500 ? "🏠" : bill.avgAmount > 100 ? "📄" : "⚡"}
                          </div>
                          <div>
                            <div className="text-sm font-semibold text-gray-800 capitalize">{bill.payee}</div>
                            <div className="text-xs text-gray-500">{bill.monthCount} months · {bill.isConsistentAmount ? "Consistent" : "Varies"} · {bill.transactions.length} charges</div>
                            {bill.allDescs.length > 0 && <div className="text-xs text-gray-400 italic mt-0.5 truncate max-w-md">{bill.allDescs[0].substring(0, 60)}</div>}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-semibold text-gray-800">~{fmt(bill.avgAmount)}/mo</div>
                          <Badge color="blue">Fixed Bill</Badge>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1 mt-2 pl-14">
                        {bill.months.map((m) => <span key={m} className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{m}</span>)}
                      </div>
                    </Card>
                  ))}
                  <Card className="p-4" style={{ background: "linear-gradient(135deg, #ecfdf5, #d1fae5)" }}>
                    <div className="flex items-start gap-3">
                      <span className="text-xl">📊</span>
                      <div>
                        <div className="text-sm font-semibold text-emerald-900">Budget Foundation</div>
                        <p className="text-xs text-emerald-800 mt-1">Fixed obligations: <strong>{fmt(totalBillMonthly)}</strong>/mo. With subscriptions ({fmt(totalSubMonthly)}), committed spending is <strong>{fmt(totalBillMonthly + totalSubMonthly)}</strong>/mo before discretionary.</p>
                      </div>
                    </div>
                  </Card>
                </div>
              )}
            </div>
          )}

          {/* ── BUDGET ─────────────────────────────────────── */}
          {tab === "budget" && (
            <div className="max-w-4xl mx-auto space-y-5">
              <div className="flex items-end justify-between">
                <div>
                  <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: "1.6rem", fontWeight: 600, color: "#1a1a1a", marginBottom: 4 }}>Budget Overview</h2>
                  <p className="text-sm text-gray-500">Income vs. expenses by period. Click any row to see top expenses.</p>
                </div>
                <div className="flex rounded-lg overflow-hidden border border-gray-200">
                  {["monthly", "weekly"].map((v) => (
                    <button key={v} onClick={() => { setBudgetView(v); setExpandedPeriods(new Set()); }} className="px-4 py-1.5 text-xs font-medium capitalize transition-colors"
                      style={{ background: budgetView === v ? "#1a7a5c" : "white", color: budgetView === v ? "white" : "#6b7280" }}>{v}</button>
                  ))}
                </div>
              </div>
              {!hasData ? (
                <Card className="p-10 text-center text-gray-400 text-sm">Upload bank statements to view your budget.</Card>
              ) : (() => {
                const data = budgetView === "monthly" ? budget.monthly : budget.weekly;
                const entries = Object.entries(data).sort(([a], [b]) => a.localeCompare(b));
                const totalIncome = entries.reduce((s, [, v]) => s + v.income, 0);
                const totalExpenses = entries.reduce((s, [, v]) => s + v.expenses, 0);
                const net = totalIncome - totalExpenses;
                const committed = totalBillMonthly + totalSubMonthly;
                const togglePeriod = (period) => {
                  setExpandedPeriods((prev) => {
                    const next = new Set(prev);
                    if (next.has(period)) next.delete(period);
                    else next.add(period);
                    return next;
                  });
                };
                return (<>
                  <div className="grid grid-cols-4 gap-3">
                    <StatCard label="Total Income" value={fmt(totalIncome)} color="#059669" />
                    <StatCard label="Total Expenses" value={fmt(totalExpenses)} color="#dc2626" />
                    <StatCard label="Net" value={fmt(net)} color={net >= 0 ? "#059669" : "#dc2626"} />
                    <StatCard label="Committed/mo" value={fmt(committed)} color="#7c3aed" sub={`Bills ${fmt(totalBillMonthly)} + Subs ${fmt(totalSubMonthly)}`} />
                  </div>
                  <Card className="overflow-hidden">
                    <table className="w-full text-sm">
                      <thead><tr style={{ background: "#f9fafb" }}>
                        <th className="text-left px-4 py-3 font-medium text-gray-600 text-xs uppercase tracking-wide">Period</th>
                        <th className="text-right px-4 py-3 font-medium text-gray-600 text-xs uppercase tracking-wide">Income</th>
                        <th className="text-right px-4 py-3 font-medium text-gray-600 text-xs uppercase tracking-wide">Expenses</th>
                        <th className="text-right px-4 py-3 font-medium text-gray-600 text-xs uppercase tracking-wide">Net</th>
                        <th className="px-4 py-3 font-medium text-gray-600 text-xs uppercase tracking-wide" style={{ width: "28%" }}>Balance</th>
                      </tr></thead>
                      <tbody>
                        {entries.map(([period, v]) => {
                          const n = v.income - v.expenses;
                          const mx = Math.max(...entries.map(([, e]) => Math.max(e.income, e.expenses))) || 1;
                          const isExpanded = expandedPeriods.has(period);
                          const topExpenses = isExpanded ? getTopExpenses(v.transactions, 10) : [];
                          return (
                            <React.Fragment key={period}>
                              <tr
                                className="border-t border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer"
                                onClick={() => togglePeriod(period)}
                              >
                                <td className="px-4 py-3 font-medium text-gray-800">
                                  <span className="inline-block w-4 text-gray-400 text-xs mr-1" style={{ transition: "transform 0.2s", transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
                                  {period}
                                </td>
                                <td className="px-4 py-3 text-right text-emerald-700">{fmt(v.income)}</td>
                                <td className="px-4 py-3 text-right text-red-600">{fmt(v.expenses)}</td>
                                <td className="px-4 py-3 text-right font-semibold" style={{ color: n >= 0 ? "#059669" : "#dc2626" }}>{fmt(n)}</td>
                                <td className="px-4 py-3">
                                  <div className="flex flex-col gap-1">
                                    <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${(v.income / mx) * 100}%`, background: "#34d399" }} /></div>
                                    <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${(v.expenses / mx) * 100}%`, background: "#f87171" }} /></div>
                                  </div>
                                </td>
                              </tr>
                              {isExpanded && (
                                <tr>
                                  <td colSpan={5} className="px-0 py-0">
                                    <div style={{ background: "#f8fafc", borderTop: "1px solid #e5e7eb", borderBottom: "1px solid #e5e7eb" }}>
                                      <div className="px-6 py-3">
                                        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Top 10 Expenses — {period}</div>
                                        <div className="space-y-1">
                                          {topExpenses.map((t, idx) => {
                                            const maxExp = Math.abs(topExpenses[0]?.amount) || 1;
                                            const barW = (Math.abs(t.amount) / maxExp) * 100;
                                            return (
                                              <div key={idx} className="flex items-center gap-3 py-1.5 group">
                                                <span className="text-xs text-gray-400 w-5 text-right font-medium">{idx + 1}</span>
                                                <span className="text-xs text-gray-500 w-20 flex-shrink-0">{t.date}</span>
                                                <div className="flex-1 min-w-0">
                                                  <div className="flex items-center gap-2">
                                                    <span className="text-xs text-gray-700 truncate max-w-xs">{t.description}</span>
                                                  </div>
                                                  <div className="h-1 rounded-full bg-gray-200 mt-1 overflow-hidden" style={{ maxWidth: "300px" }}>
                                                    <div className="h-full rounded-full" style={{ width: `${barW}%`, background: "linear-gradient(90deg, #ef4444, #f87171)" }} />
                                                  </div>
                                                </div>
                                                <span className="text-xs font-semibold text-red-600 w-20 text-right flex-shrink-0">{fmt(Math.abs(t.amount))}</span>
                                              </div>
                                            );
                                          })}
                                          {topExpenses.length === 0 && (
                                            <div className="text-xs text-gray-400 py-2">No expenses in this period.</div>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </Card>
                </>);
              })()}
            </div>
          )}

          {/* ── INSIGHTS ───────────────────────────────────── */}
          {tab === "insights" && (
            <div className="max-w-4xl mx-auto space-y-6">
              <div>
                <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: "1.6rem", fontWeight: 600, color: "#1a1a1a", marginBottom: 4 }}>Smart Insights</h2>
                <p className="text-sm text-gray-500">Model-driven analysis of your spending patterns and debt situation with actionable recommendations.</p>
              </div>

              {!hasData ? (
                <Card className="p-10 text-center text-gray-400 text-sm">Upload bank statements to generate insights.</Card>
              ) : !insights ? (
                <Card className="p-10 text-center text-gray-400 text-sm">Analyzing your data...</Card>
              ) : (
                <>
                  {/* ── Cash Flow Health Bar ── */}
                  {insights.models.cashFlowModel && (() => {
                    const cf = insights.models.cashFlowModel;
                    const score = cf.sustainabilityScore;
                    const barColor = score > 60 ? "#059669" : score > 30 ? "#d97706" : "#dc2626";
                    return (
                      <Card className="p-5">
                        <div className="flex items-center justify-between mb-2">
                          <div className="text-sm font-semibold text-gray-800">Financial Health Score</div>
                          <div style={{ fontFamily: "'Fraunces', serif", fontSize: "1.4rem", fontWeight: 700, color: barColor }}>{score.toFixed(0)}<span className="text-sm font-normal text-gray-400">/100</span></div>
                        </div>
                        <div className="h-3 rounded-full bg-gray-100 overflow-hidden mb-3">
                          <div className="h-full rounded-full transition-all" style={{ width: `${score}%`, background: `linear-gradient(90deg, ${barColor}, ${barColor}88)` }} />
                        </div>
                        <div className="grid grid-cols-3 gap-4 text-center">
                          <div><div className="text-xs text-gray-500">Avg Income</div><div className="text-sm font-semibold text-emerald-700">{fmt(cf.avgIncome)}/mo</div></div>
                          <div><div className="text-xs text-gray-500">Avg Expenses</div><div className="text-sm font-semibold text-red-600">{fmt(cf.avgExpenses)}/mo</div></div>
                          <div><div className="text-xs text-gray-500">Burn Rate</div><div className="text-sm font-semibold" style={{ color: barColor }}>{(cf.burnRate * 100).toFixed(0)}%</div></div>
                        </div>
                      </Card>
                    );
                  })()}

                  {/* ── Section: Behavioral Adjustments ── */}
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center text-sm" style={{ background: "#fef3c7", color: "#92400e" }}>🧠</div>
                      <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: "1.15rem", fontWeight: 600, color: "#1a1a1a" }}>Behavioral Adjustments</h3>
                    </div>
                    <div className="space-y-3">
                      {insights.behavioral.map((insight, i) => {
                        const severityColor = { high: "#dc2626", medium: "#d97706", low: "#059669" }[insight.severity];
                        return (
                          <Card key={i} className="p-5">
                            <div className="flex items-start gap-4">
                              <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl flex-shrink-0" style={{ background: "#fefce8" }}>{insight.icon}</div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-start justify-between gap-3 mb-1">
                                  <div className="text-sm font-semibold text-gray-800">{insight.title}</div>
                                  <div className="text-right flex-shrink-0">
                                    <div style={{ fontFamily: "'Fraunces', serif", fontSize: "1.1rem", fontWeight: 600, color: severityColor }}>{insight.metric}</div>
                                    <div className="text-xs text-gray-500">{insight.metricLabel}</div>
                                  </div>
                                </div>
                                <p className="text-xs text-gray-600 leading-relaxed mb-3">{insight.description}</p>

                                {/* Savings potential bar */}
                                {insight.savingsPotential > 0 && (
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-gray-500 flex-shrink-0">Savings potential:</span>
                                    <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden" style={{ maxWidth: 200 }}>
                                      <div className="h-full rounded-full" style={{ width: `${Math.min((insight.savingsPotential / 500) * 100, 100)}%`, background: "linear-gradient(90deg, #059669, #34d399)" }} />
                                    </div>
                                    <span className="text-xs font-semibold text-emerald-700 flex-shrink-0">{fmt(insight.savingsPotential)}/mo</span>
                                  </div>
                                )}

                                {/* Top merchants detail for behavioral 3 */}
                                {insight.topMerchants && (
                                  <div className="mt-3 pt-3 border-t border-gray-100">
                                    <div className="text-xs font-medium text-gray-500 mb-1.5">Most frequent merchants:</div>
                                    <div className="flex flex-wrap gap-1.5">
                                      {insight.topMerchants.map((m, j) => (
                                        <span key={j} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-50 text-xs text-gray-600">
                                          <span className="font-medium capitalize">{m.name}</span>
                                          <span className="text-gray-400">·</span>
                                          <span>{m.count}x</span>
                                          <span className="text-gray-400">·</span>
                                          <span className="text-red-600">{fmt(m.total)}</span>
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </Card>
                        );
                      })}
                    </div>
                  </div>

                  {/* ── Spending by Category Chart ── */}
                  {insights.models.catModel && (() => {
                    const cats = insights.models.catModel.categories;
                    const maxCat = cats[0]?.total || 1;
                    const catColors = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280"];
                    return (
                      <Card className="p-5">
                        <div className="text-sm font-semibold text-gray-800 mb-3">Spending by Category</div>
                        <div className="space-y-2">
                          {cats.map((cat, i) => (
                            <div key={i} className="flex items-center gap-3">
                              <span className="text-xs text-gray-600 w-44 truncate flex-shrink-0">{cat.name}</span>
                              <div className="flex-1 h-4 rounded bg-gray-100 overflow-hidden">
                                <div className="h-full rounded" style={{ width: `${(cat.total / maxCat) * 100}%`, background: catColors[i % catColors.length], opacity: 0.8 }} />
                              </div>
                              <span className="text-xs font-semibold text-gray-700 w-20 text-right flex-shrink-0">{fmt(cat.total)}</span>
                              <span className="text-xs text-gray-400 w-10 text-right flex-shrink-0">{(cat.pctOfExpenses * 100).toFixed(0)}%</span>
                            </div>
                          ))}
                        </div>
                      </Card>
                    );
                  })()}

                  {/* ── Day of Week Heatmap ── */}
                  {insights.models.temporalModel && (() => {
                    const days = insights.models.temporalModel.dayData;
                    const maxDay = Math.max(...days.map((d) => d.total)) || 1;
                    return (
                      <Card className="p-5">
                        <div className="text-sm font-semibold text-gray-800 mb-3">Spending by Day of Week</div>
                        <div className="flex gap-2">
                          {days.map((d, i) => {
                            const intensity = d.total / maxDay;
                            const bg = intensity > 0.7 ? "#fecaca" : intensity > 0.4 ? "#fef3c7" : intensity > 0 ? "#dcfce7" : "#f3f4f6";
                            const textColor = intensity > 0.7 ? "#991b1b" : intensity > 0.4 ? "#92400e" : intensity > 0 ? "#166534" : "#9ca3af";
                            return (
                              <div key={i} className="flex-1 rounded-xl p-3 text-center" style={{ background: bg }}>
                                <div className="text-xs font-semibold" style={{ color: textColor }}>{d.day}</div>
                                <div className="text-sm font-bold mt-1" style={{ color: textColor }}>{fmt(d.total)}</div>
                                <div className="text-xs mt-0.5" style={{ color: textColor, opacity: 0.7 }}>{d.count} txns</div>
                              </div>
                            );
                          })}
                        </div>
                      </Card>
                    );
                  })()}

                  {/* ── Section: Debt Payment Strategies ── */}
                  <div>
                    <div className="flex items-center gap-2 mb-3 mt-2">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center text-sm" style={{ background: "#fee2e2", color: "#991b1b" }}>💳</div>
                      <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: "1.15rem", fontWeight: 600, color: "#1a1a1a" }}>Debt Payment Strategies</h3>
                    </div>
                    {cards.length === 0 ? (
                      <Card className="p-6 text-center text-gray-400 text-sm">Add credit card debts on the Import tab to see debt strategies.</Card>
                    ) : (
                      <div className="space-y-3">
                        {insights.debt.map((insight, i) => {
                          const severityColor = { high: "#dc2626", medium: "#d97706", low: "#059669" }[insight.severity];
                          return (
                            <Card key={i} className="p-5">
                              <div className="flex items-start gap-4">
                                <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl flex-shrink-0" style={{ background: "#fef2f2" }}>{insight.icon}</div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start justify-between gap-3 mb-1">
                                    <div className="text-sm font-semibold text-gray-800">{insight.title}</div>
                                    <div className="text-right flex-shrink-0">
                                      <div style={{ fontFamily: "'Fraunces', serif", fontSize: "1.1rem", fontWeight: 600, color: severityColor }}>{insight.metric}</div>
                                      <div className="text-xs text-gray-500">{insight.metricLabel}</div>
                                    </div>
                                  </div>
                                  <p className="text-xs text-gray-600 leading-relaxed mb-3">{insight.description}</p>

                                  {/* Strategy comparison table */}
                                  {insight.comparison && (
                                    <div className="mt-3 pt-3 border-t border-gray-100">
                                      <div className="text-xs font-medium text-gray-500 mb-2">Strategy Comparison:</div>
                                      <div className="grid grid-cols-4 gap-2">
                                        {[
                                          { name: "Min. Only", data: insight.comparison.baseline, color: "#9ca3af" },
                                          { name: "Avalanche", data: insight.comparison.avalanche, color: "#059669" },
                                          { name: "Snowball", data: insight.comparison.snowball, color: "#3b82f6" },
                                          { name: "Hybrid", data: insight.comparison.hybrid, color: "#8b5cf6" },
                                        ].map((s, j) => (
                                          <div key={j} className="rounded-lg p-2.5 text-center" style={{ background: s.color + "10", border: `1px solid ${s.color}30` }}>
                                            <div className="text-xs font-semibold" style={{ color: s.color }}>{s.name}</div>
                                            <div className="text-sm font-bold text-gray-800 mt-1">{s.data.months < 600 ? `${s.data.months}mo` : "Never"}</div>
                                            <div className="text-xs text-gray-500">{s.data.months < 600 ? fmt(s.data.totalInterest) : "∞"} int.</div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  {/* Savings scenarios */}
                                  {insight.scenarios && (
                                    <div className="mt-3 pt-3 border-t border-gray-100">
                                      <div className="text-xs font-medium text-gray-500 mb-2">Reallocation breakdown:</div>
                                      <div className="space-y-1.5">
                                        {insight.scenarios.map((s, j) => (
                                          <div key={j} className="flex items-center gap-2">
                                            <div className="flex-1 text-xs text-gray-600">{s.name}</div>
                                            <div className="w-24 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                                              <div className="h-full rounded-full bg-emerald-400" style={{ width: `${Math.min((s.monthlySavings / 200) * 100, 100)}%` }} />
                                            </div>
                                            <div className="text-xs font-semibold text-emerald-700 w-16 text-right">{fmt(s.monthlySavings)}</div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  {/* Cash flow projection */}
                                  {insight.cashFlow && (
                                    <div className="mt-3 pt-3 border-t border-gray-100">
                                      <div className="text-xs font-medium text-gray-500 mb-2">6-month projection at current rate:</div>
                                      <div className="flex items-end gap-1" style={{ height: 50 }}>
                                        {insight.cashFlow.projection.map((p, j) => {
                                          const maxAbs = Math.max(...insight.cashFlow.projection.map((pp) => Math.abs(pp.balance))) || 1;
                                          const h = (Math.abs(p.balance) / maxAbs) * 100;
                                          return (
                                            <div key={j} className="flex-1 flex flex-col items-center justify-end h-full">
                                              <div className="w-full rounded-t" style={{
                                                height: `${Math.max(h, 5)}%`,
                                                background: p.balance >= 0 ? "#34d399" : "#f87171",
                                              }} />
                                              <div className="text-xs text-gray-400 mt-1">M{p.month}</div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </Card>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Combined savings summary */}
                  {(() => {
                    const totalBehavioralSavings = insights.behavioral.reduce((s, b) => s + (b.savingsPotential || 0), 0);
                    return totalBehavioralSavings > 0 && (
                      <Card className="p-5" style={{ background: "linear-gradient(135deg, #ecfdf5, #d1fae5)" }}>
                        <div className="flex items-start gap-3">
                          <span className="text-2xl">🎯</span>
                          <div>
                            <div className="text-sm font-semibold text-emerald-900">Combined Savings Potential</div>
                            <p className="text-xs text-emerald-800 mt-1">
                              Implementing all three behavioral changes could save up to <strong>{fmt(totalBehavioralSavings)}/month</strong> ({fmt(totalBehavioralSavings * 12)}/year).
                              {cards.length > 0 && ` Redirecting this to debt would accelerate your payoff significantly.`}
                            </p>
                          </div>
                        </div>
                      </Card>
                    );
                  })()}

                  <p className="text-xs text-gray-400 text-center">These insights are generated from statistical models on your transaction data. They provide educational guidance, not financial advice.</p>
                </>
              )}
            </div>
          )}

          {/* ── DEBT PAYOFF ─────────────────────────────────── */}
          {tab === "debt" && (
            <div className="max-w-3xl mx-auto space-y-5">
              <div>
                <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: "1.6rem", fontWeight: 600, color: "#1a1a1a", marginBottom: 4 }}>Debt Payoff Plan</h2>
                <p className="text-sm text-gray-500">Avalanche strategy — target highest-interest debt first.</p>
              </div>
              {cards.length === 0 ? (
                <Card className="p-10 text-center text-gray-400 text-sm">Add credit card debts on the Import tab to generate a payoff plan.</Card>
              ) : (<>
                <div className="grid grid-cols-3 gap-4">
                  <StatCard label="Total Debt" value={fmt(cards.reduce((s, c) => s + c.balance, 0))} color="#dc2626" />
                  <StatCard label="Current Payments" value={fmt(cards.reduce((s, c) => s + c.monthlyPayment, 0)) + "/mo"} color="#6b7280" />
                  <StatCard label="Suggested Extra" value={fmt(cards.reduce((s, c) => s + c.monthlyPayment, 0) * 0.2) + "/mo"} color="#059669" />
                </div>
                <div className="space-y-3">
                  {debtPlan.map((card, i) => (
                    <Card key={card.id} className="p-5">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold" style={{ background: i === 0 ? "#dc2626" : "#9ca3af" }}>#{card.priority}</div>
                          <div>
                            <div className="text-sm font-semibold text-gray-800">{card.name}</div>
                            <div className="text-xs text-gray-500">{card.apr}% APR</div>
                          </div>
                        </div>
                        {i === 0 && <Badge color="red">Priority — Attack First</Badge>}
                      </div>
                      <div className="grid grid-cols-4 gap-3 text-center rounded-xl p-3" style={{ background: "#f9fafb" }}>
                        {[
                          { label: "Balance", val: fmt(card.balance) },
                          { label: "Suggested Payment", val: fmt(card.suggestedPayment) + "/mo" },
                          { label: "Payoff Time", val: card.monthsToPayoff >= 600 ? "Never*" : `${card.monthsToPayoff} months` },
                          { label: "Est. Total Interest", val: card.monthsToPayoff >= 600 ? "∞" : fmt(card.totalInterest) },
                        ].map((d, j) => (
                          <div key={j}><div className="text-xs text-gray-500">{d.label}</div><div className="text-sm font-semibold text-gray-800 mt-0.5">{d.val}</div></div>
                        ))}
                      </div>
                      {card.monthsToPayoff < 600 && (
                        <div className="mt-3">
                          <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{ width: `${Math.min((card.monthlyPayment / card.suggestedPayment) * 100, 100)}%`, background: i === 0 ? "linear-gradient(90deg, #dc2626, #f87171)" : "linear-gradient(90deg, #9ca3af, #d1d5db)" }} />
                          </div>
                          <div className="flex justify-between text-xs text-gray-400 mt-1">
                            <span>Current: {fmt(card.monthlyPayment)}</span>
                            <span>Target: {fmt(card.suggestedPayment)}</span>
                          </div>
                        </div>
                      )}
                    </Card>
                  ))}
                </div>
                <Card className="p-5" style={{ background: "linear-gradient(135deg, #ecfdf5, #d1fae5)" }}>
                  <h3 className="text-sm font-semibold text-emerald-900 mb-2">💡 Your Payoff Strategy</h3>
                  <div className="space-y-2 text-xs text-emerald-800 leading-relaxed">
                    <p><strong>Avalanche Method:</strong> Pay minimums on every card, then direct all extra toward <strong>{debtPlan[0]?.name}</strong> (highest interest). Once gone, roll that payment into the next card.</p>
                    <p><strong>Why this works:</strong> Minimizes total interest. Even small extra payments dramatically shorten your timeline.</p>
                    {totalSubMonthly > 0 && <p><strong>Quick Win:</strong> ~{fmt(totalSubMonthly)}/mo on subscriptions. Cancel unused ones to fund extra debt payments.</p>}
                    {totalBillMonthly > 0 && <p><strong>Review Fixed Bills:</strong> ~{fmt(totalBillMonthly)}/mo committed. Shopping insurance or negotiating rates could free up cash.</p>}
                    <p><strong>Watch for:</strong> "Never" payoff time means your payment doesn't cover interest — increase it or negotiate a lower rate.</p>
                    {debtPlan.some((c) => c.monthsToPayoff >= 600) && <p style={{ color: "#991b1b", fontWeight: 600 }}>⚠ One or more cards will never be paid off at current levels. Consider balance transfers, consolidation, or a credit counselor.</p>}
                  </div>
                </Card>
                <p className="text-xs text-gray-400 text-center">Educational guidance only, not financial advice. Consult a certified financial advisor.</p>
              </>)}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
