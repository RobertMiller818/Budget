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
  const sorted = [...cards].sort((a, b) => b.monthlyInterestRate - a.monthlyInterestRate);
  const totalMin = sorted.reduce((s, c) => s + c.monthlyPayment, 0);
  const extra = totalMin * 0.2;
  return sorted.map((card, i) => {
    let bal = card.balance, mo = 0;
    const rate = card.monthlyInterestRate / 100;
    const pay = card.monthlyPayment + (i === 0 ? extra : 0);
    if (pay <= 0) return { ...card, suggestedPayment: pay, monthsToPayoff: 600, totalInterest: Infinity, priority: i + 1 };
    while (bal > 0 && mo < 600) { bal = bal * (1 + rate) - pay; mo++; if (bal < 0) bal = 0; }
    return { ...card, suggestedPayment: pay, monthsToPayoff: mo, totalInterest: pay * mo - card.balance, priority: i + 1 };
  });
}

// ─── UI Components ──────────────────────────────────────────────────────────
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
      monthlyInterestRate: parseFloat(cardForm.interest) || 0,
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
                <p className="text-xs text-gray-500 mb-4">Add each card with its current balance, monthly interest rate (e.g. 1.5 for 1.5%/mo), and current monthly payment.</p>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  {[
                    { key: "name", label: "Card Name", placeholder: "e.g. Chase Sapphire" },
                    { key: "balance", label: "Balance ($)", placeholder: "5000" },
                    { key: "interest", label: "Monthly Interest %", placeholder: "1.5" },
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
                          <span className="mx-2 text-gray-300">·</span><span className="text-gray-500">{c.monthlyInterestRate}%/mo</span>
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
                            <div className="text-xs text-gray-500">{card.monthlyInterestRate}% monthly interest</div>
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
