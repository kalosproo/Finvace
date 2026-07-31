import React, { useState, useEffect, useMemo, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported } from "firebase/analytics";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { doc, getFirestore, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { LogIn, LogOut, Plus, RefreshCw, Trash2, TrendingUp, TrendingDown, X } from "lucide-react";

const firebaseConfig = {
  apiKey: "AIzaSyAwaV8adaZSHfXtgRvYWNlx1DZFgH4ywrk",
  authDomain: "finvace.firebaseapp.com",
  projectId: "finvace",
  storageBucket: "finvace.firebasestorage.app",
  messagingSenderId: "1054835049063",
  appId: "1:1054835049063:web:1a9081ae52735cc2914ac2",
  measurementId: "G-3EDYR3BEST",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

if (typeof window !== "undefined") {
  isSupported().then((supported) => {
    if (supported) getAnalytics(app);
  });
}

export async function fetchMutualFundNAV(schemeCode) {
  const cleanCode = String(schemeCode || "").trim();
  if (!cleanCode) throw new Error("missing scheme code");
  if (!/^\d{6}$/.test(cleanCode)) throw new Error("invalid scheme code");

  const response = await fetch(`https://api.mfapi.in/mf/${cleanCode}/latest`);
  if (!response.ok) throw new Error(`NAV lookup failed (${response.status})`);

  const payload = await response.json();
  if (payload.status && payload.status !== "SUCCESS") throw new Error("scheme code does not exist");

  const nav = Number.parseFloat(payload?.data?.[0]?.nav);
  if (Number.isNaN(nav)) throw new Error("NAV is missing");

  return nav;
}

async function searchMutualFunds(query) {
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  const response = await fetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(cleanQuery)}`);
  if (!response.ok) throw new Error(`Fund search failed (${response.status})`);

  const results = await response.json();
  if (!Array.isArray(results)) return [];
  return results.slice(0, 6);
}

const ASSET_CLASSES = ["Equity", "Crypto", "Mutual Fund"];
const CLASS_OPACITY = { Equity: 0.95, Crypto: 0.55, "Mutual Fund": 0.3 };

const SEED_JOURNAL = [
  { id: "j1", date: "2026-07-15", instrument: "RIVER/USDT", direction: "Long", pnl: 39.57, outcome: "WIN", notes: "" },
  { id: "j2", date: "2026-07-18", instrument: "ADA/USDT", direction: "Short", pnl: 179.88, outcome: "WIN", notes: "" },
];

const uid = () => Math.random().toString(36).slice(2, 10);

const fmt = (n) => {
  const neg = n < 0;
  const v = Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  return (neg ? "-₹" : "₹") + v;
};
const fmtPct = (n) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";

const localPortfolio = {
  load() {
    const holdings = JSON.parse(window.localStorage.getItem("finvace:holdings") || "[]");
    const journal = JSON.parse(window.localStorage.getItem("finvace:journal") || JSON.stringify(SEED_JOURNAL));
    return { holdings, journal };
  },
  save(holdings, journal) {
    window.localStorage.setItem("finvace:holdings", JSON.stringify(holdings));
    window.localStorage.setItem("finvace:journal", JSON.stringify(journal));
  },
};

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wider" style={{ color: "#6E6D67" }}>{label}</span>
      {children}
    </div>
  );
}

const inputStyle = {
  background: "#161617",
  border: "1px solid #2A2A2D",
  color: "#F2F1EC",
  borderRadius: "8px",
  padding: "8px 10px",
  fontSize: "14px",
  outline: "none",
  fontFamily: "'DM Sans', sans-serif",
};

export default function PortfolioTracker() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshingNAV, setRefreshingNAV] = useState(false);
  const refreshPricesRef = useRef(async () => {});
  const [user, setUser] = useState(null);
  const [holdings, setHoldings] = useState([]);
  const [journal, setJournal] = useState([]);
  const [tab, setTab] = useState("holdings");
  const [addingHolding, setAddingHolding] = useState(false);
  const [addingJournal, setAddingJournal] = useState(false);
  const [notice, setNotice] = useState("");
  const [navErrors, setNavErrors] = useState([]);
  const [fundSearchQuery, setFundSearchQuery] = useState("");
  const [fundSearchResults, setFundSearchResults] = useState([]);
  const [fundSearchNotice, setFundSearchNotice] = useState("");
  const [searchingFunds, setSearchingFunds] = useState(false);
  const [selectedFund, setSelectedFund] = useState(null);

  const [hForm, setHForm] = useState({ assetClass: "Equity", name: "", ticker: "", quantity: "", avgPrice: "", currentPrice: "" });
  const [jForm, setJForm] = useState({ date: new Date().toISOString().slice(0, 10), instrument: "", direction: "Long", pnl: "", outcome: "WIN", notes: "" });

  useEffect(() => {
    let stopPortfolioSync;
    const stopAuthSync = onAuthStateChanged(auth, (account) => {
      setUser(account);
      setNotice("");
      if (stopPortfolioSync) stopPortfolioSync();

      if (!account) {
        const saved = localPortfolio.load();
        setHoldings(saved.holdings);
        setJournal(saved.journal);
        setLoading(false);
        return;
      }

      setLoading(true);
      const portfolioRef = doc(db, "users", account.uid, "portfolio", "state");
      stopPortfolioSync = onSnapshot(portfolioRef, async (snap) => {
        if (!snap.exists()) {
          await setDoc(portfolioRef, { holdings: [], journal: SEED_JOURNAL, updatedAt: serverTimestamp() });
          return;
        }
        const data = snap.data();
        setHoldings(Array.isArray(data.holdings) ? data.holdings : []);
        setJournal(Array.isArray(data.journal) ? data.journal : SEED_JOURNAL);
        setLoading(false);
      }, () => {
        setNotice("Couldn't sync with Firestore. Check your Firebase rules and project setup.");
        setLoading(false);
      });
    });

    return () => {
      if (stopPortfolioSync) stopPortfolioSync();
      stopAuthSync();
    };
  }, []);

  const savePortfolio = async (nextHoldings, nextJournal) => {
    setHoldings(nextHoldings);
    setJournal(nextJournal);
    setSaving(true);
    try {
      if (user) {
        await setDoc(doc(db, "users", user.uid, "portfolio", "state"), {
          holdings: nextHoldings,
          journal: nextJournal,
          updatedAt: serverTimestamp(),
        }, { merge: true });
      } else {
        localPortfolio.save(nextHoldings, nextJournal);
      }
      setNotice(user ? "Saved to Finvace cloud." : "Saved on this device. Sign in with Google to sync.");
    } catch (e) {
      setNotice("Couldn't save — try again.");
    } finally {
      setSaving(false);
    }
  };

  const signInWithGoogle = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e) {
      setNotice("Google login failed. Enable Google provider in Firebase Authentication.");
    }
  };

  const enriched = useMemo(() => holdings.map((h) => {
    const invested = h.quantity * h.avgPrice;
    const value = h.quantity * h.currentPrice;
    const pnl = value - invested;
    const pnlPct = invested ? (pnl / invested) * 100 : 0;
    return { ...h, invested, value, pnl, pnlPct };
  }), [holdings]);

  const totalValue = enriched.reduce((s, h) => s + h.value, 0);
  const totalInvested = enriched.reduce((s, h) => s + h.invested, 0);
  const totalPnl = totalValue - totalInvested;
  const totalPnlPct = totalInvested ? (totalPnl / totalInvested) * 100 : 0;

  const byClass = ASSET_CLASSES.map((c) => {
    const items = enriched.filter((h) => h.assetClass === c);
    const value = items.reduce((s, h) => s + h.value, 0);
    return { assetClass: c, items, value, pct: totalValue ? (value / totalValue) * 100 : 0 };
  }).filter((g) => g.items.length > 0);

  const wins = journal.filter((j) => j.outcome === "WIN").length;
  const totalTrades = journal.length;
  const winRate = totalTrades ? (wins / totalTrades) * 100 : 0;
  const journalPnl = journal.reduce((s, j) => s + Number(j.pnl), 0);

  const refreshPrices = async ({ silent = false } = {}) => {
    const mutualFunds = holdings.filter((holding) => holding.assetClass === "Mutual Fund");
    if (mutualFunds.length === 0) {
      if (!silent) setNotice("Add a mutual fund holding to refresh prices.");
      setNavErrors([]);
      return;
    }

    setRefreshingNAV(true);
    setNavErrors([]);
    const results = await Promise.allSettled(mutualFunds.map(async (holding) => {
      const nav = await fetchMutualFundNAV(holding.ticker);
      return { id: holding.id, nav };
    }));

    const navById = new Map();
    const errors = [];
    results.forEach((result, index) => {
      const holding = mutualFunds[index];
      if (result.status === "fulfilled") {
        navById.set(result.value.id, result.value.nav);
      } else {
        errors.push(`${holding.name}: ${result.reason?.message || "couldn't refresh NAV"}`);
      }
    });

    if (navById.size > 0) {
      const next = holdings.map((holding) => (
        navById.has(holding.id) ? { ...holding, currentPrice: navById.get(holding.id) } : holding
      ));
      await savePortfolio(next, journal);
    }

    setNavErrors(errors);
    if (!silent || errors.length > 0) {
      setNotice(`${navById.size} mutual fund NAV${navById.size === 1 ? "" : "s"} refreshed${errors.length ? ` · ${errors.length} issue${errors.length === 1 ? "" : "s"}` : ""}.`);
    }
    setRefreshingNAV(false);
  };

  refreshPricesRef.current = refreshPrices;

  useEffect(() => {
    if (loading) return undefined;

    refreshPricesRef.current({ silent: true });
    const intervalId = window.setInterval(() => {
      refreshPricesRef.current({ silent: true });
    }, 5 * 60 * 1000);

    return () => window.clearInterval(intervalId);
  }, [loading]);

  useEffect(() => {
    if (hForm.assetClass !== "Mutual Fund" || selectedFund) return undefined;

    const query = fundSearchQuery.trim();
    if (query.length < 2) {
      setFundSearchResults([]);
      setFundSearchNotice("");
      return undefined;
    }

    let cancelled = false;
    const debounceId = window.setTimeout(async () => {
      setSearchingFunds(true);
      setFundSearchNotice("");
      try {
        const results = await searchMutualFunds(query);
        if (cancelled) return;
        setFundSearchResults(results);
        if (results.length === 0) setFundSearchNotice("No matching funds found.");
      } catch (e) {
        if (cancelled) return;
        setFundSearchResults([]);
        setFundSearchNotice(e.message || "Fund search failed.");
      } finally {
        if (!cancelled) setSearchingFunds(false);
      }
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(debounceId);
    };
  }, [fundSearchQuery, hForm.assetClass, selectedFund]);

  const selectMutualFund = async (fund) => {
    const nextFund = { schemeCode: String(fund.schemeCode), schemeName: fund.schemeName };
    setSelectedFund(nextFund);
    setFundSearchQuery("");
    setFundSearchResults([]);
    setFundSearchNotice("");
    setHForm((form) => ({ ...form, name: nextFund.schemeName, ticker: nextFund.schemeCode }));

    try {
      const nav = await fetchMutualFundNAV(nextFund.schemeCode);
      setHForm((form) => ({ ...form, currentPrice: String(nav) }));
    } catch (e) {
      setFundSearchNotice(`${nextFund.schemeName}: ${e.message || "couldn't fetch latest NAV"}`);
    }
  };



  const submitHolding = () => {
    const qty = parseFloat(hForm.quantity);
    const avg = parseFloat(hForm.avgPrice);
    const cur = parseFloat(hForm.currentPrice);
    if (!hForm.name.trim() || !qty || !avg || !cur) { setNotice("Fill in name, quantity, avg price and current price."); return; }
    const ticker = hForm.assetClass === "Mutual Fund" ? hForm.ticker.trim() : hForm.ticker.trim().toUpperCase();
    const next = [...holdings, { id: uid(), assetClass: hForm.assetClass, name: hForm.name.trim(), ticker, quantity: qty, avgPrice: avg, currentPrice: cur }];
    savePortfolio(next, journal);
    setHForm({ assetClass: "Equity", name: "", ticker: "", quantity: "", avgPrice: "", currentPrice: "" });
    setSelectedFund(null);
    setFundSearchQuery("");
    setFundSearchResults([]);
    setAddingHolding(false);
  };

  const deleteHolding = (id) => savePortfolio(holdings.filter((h) => h.id !== id), journal);

  const submitJournal = () => {
    const pnl = parseFloat(jForm.pnl);
    if (!jForm.instrument.trim() || isNaN(pnl)) { setNotice("Fill in instrument and P&L."); return; }
    const next = [{ id: uid(), date: jForm.date, instrument: jForm.instrument.trim().toUpperCase(), direction: jForm.direction, pnl, outcome: jForm.outcome, notes: jForm.notes.trim() }, ...journal];
    savePortfolio(holdings, next);
    setJForm({ date: new Date().toISOString().slice(0, 10), instrument: "", direction: "Long", pnl: "", outcome: "WIN", notes: "" });
    setAddingJournal(false);
  };

  const deleteJournal = (id) => savePortfolio(holdings, journal.filter((j) => j.id !== id));

  if (loading) {
    return (
      <div style={{ background: "#0B0B0C", minHeight: "100vh" }} className="flex items-center justify-center">
        <span style={{ color: "#6E6D67", fontFamily: "'DM Sans', sans-serif" }} className="text-sm">Loading Finvace…</span>
      </div>
    );
  }

  return (
    <div className="pf-root" style={{ background: "#0B0B0C", minHeight: "100vh", color: "#F2F1EC" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        .pf-root, .pf-root * { font-family: 'DM Sans', sans-serif; box-sizing: border-box; }
        .pf-display { font-family: 'Fraunces', serif; font-optical-sizing: auto; }
        .pf-mono { font-family: 'JetBrains Mono', monospace; font-variant-numeric: tabular-nums; }
        .pf-row:hover .pf-delete { opacity: 1; }
        .pf-delete { opacity: 0; transition: opacity 150ms ease; }
        .pf-tab { transition: color 150ms ease, border-color 150ms ease; }
        .pf-input:focus { border-color: #C9A876 !important; }
        ::selection { background: #C9A876; color: #0B0B0C; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
      `}</style>

      <div className="max-w-3xl mx-auto px-5 py-10 sm:px-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <img src="/logo.svg" alt="Finvace logo" className="h-9 w-9 rounded-xl" />
            <span className="text-xs uppercase tracking-widest" style={{ color: "#6E6D67", letterSpacing: "0.15em" }}>Finvace</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs pf-mono hidden sm:inline" style={{ color: "#6E6D67" }}>{new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</span>
            {user ? (
              <button onClick={() => signOut(auth)} className="flex items-center gap-2 text-xs px-3 py-2 rounded-full" style={{ border: "1px solid #2A2A2D", color: "#F2F1EC" }}>
                <LogOut size={14} /> {user.displayName || "Sign out"}
              </button>
            ) : (
              <button onClick={signInWithGoogle} className="flex items-center gap-2 text-xs px-3 py-2 rounded-full" style={{ background: "#F2F1EC", color: "#0B0B0C", fontWeight: 700 }}>
                <LogIn size={14} /> Google login
              </button>
            )}
          </div>
        </div>

        {/* Hero */}
        <div className="mb-8">
          <div className="text-sm mb-2" style={{ color: "#8C8B86" }}>{user ? "Cloud-synced portfolio dashboard" : "Track locally or sign in to sync with Firestore"}{saving ? " · saving…" : ""}</div>
          <div className="pf-display" style={{ fontSize: "44px", fontWeight: 500, lineHeight: 1.05 }}>{fmt(totalValue)}</div>
          <div className="flex items-center gap-2 mt-3">
            {totalPnl >= 0 ? <TrendingUp size={15} color="#8FAF8A" /> : <TrendingDown size={15} color="#C97B6B" />}
            <span className="pf-mono text-sm" style={{ color: totalPnl >= 0 ? "#8FAF8A" : "#C97B6B" }}>
              {fmt(totalPnl)} · {fmtPct(totalPnlPct)}
            </span>
            <span className="text-sm" style={{ color: "#6E6D67" }}>overall</span>
          </div>
        </div>

        {/* Allocation ruler — signature element */}
        {totalValue > 0 && (
          <div className="mb-10">
            <div className="flex w-full h-2 rounded-full overflow-hidden" style={{ background: "#161617" }}>
              {byClass.map((g) => (
                <div key={g.assetClass} style={{ width: `${g.pct}%`, background: `rgba(201,168,118,${CLASS_OPACITY[g.assetClass]})` }} />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3">
              {byClass.map((g) => (
                <div key={g.assetClass} className="flex items-center gap-2">
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: `rgba(201,168,118,${CLASS_OPACITY[g.assetClass]})`, display: "inline-block" }} />
                  <span className="text-xs" style={{ color: "#A3A29C" }}>{g.assetClass}</span>
                  <span className="text-xs pf-mono" style={{ color: "#6E6D67" }}>{g.pct.toFixed(0)}%</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {notice && (
          <div className="flex items-center justify-between mb-4 px-3 py-2 rounded-lg text-sm" style={{ background: "rgba(201,123,107,0.1)", color: "#C97B6B" }}>
            <span>{notice}</span>
            <button onClick={() => setNotice("")}><X size={14} /></button>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-6 mb-6" style={{ borderBottom: "1px solid #232326" }}>
          {[["holdings", "Holdings"], ["journal", "Journal"], ["allocation", "Allocation"]].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="pf-tab text-sm pb-3"
              style={{
                color: tab === key ? "#F2F1EC" : "#6E6D67",
                borderBottom: tab === key ? "2px solid #C9A876" : "2px solid transparent",
                marginBottom: "-1px",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Holdings */}
        {tab === "holdings" && (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
              <div className="text-xs" style={{ color: "#6E6D67" }}>Mutual fund NAVs auto-refresh from mfapi.in every 5 minutes.</div>
              <button
                onClick={() => refreshPrices()}
                disabled={refreshingNAV}
                className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg"
                style={{ border: "1px solid #2A2A2D", color: refreshingNAV ? "#6E6D67" : "#C9A876", opacity: refreshingNAV ? 0.75 : 1 }}
              >
                <RefreshCw size={15} className={refreshingNAV ? "animate-spin" : ""} /> {refreshingNAV ? "Refreshing prices…" : "Refresh prices"}
              </button>
            </div>
            {navErrors.length > 0 && (
              <div className="mb-5 rounded-lg px-3 py-3 text-sm" style={{ background: "rgba(201,123,107,0.1)", color: "#C97B6B", border: "1px solid rgba(201,123,107,0.22)" }}>
                <div className="font-medium mb-1">Some NAVs were not updated:</div>
                <ul className="list-disc pl-5">
                  {navErrors.map((error) => <li key={error}>{error}</li>)}
                </ul>
              </div>
            )}
            {byClass.length === 0 && (
              <div className="text-sm mb-6" style={{ color: "#6E6D67" }}>No holdings yet. Add your first Finvace asset below — equities, crypto, or a mutual fund.</div>
            )}
            {byClass.map((g) => (
              <div key={g.assetClass} className="mb-8">
                <div className="flex items-baseline justify-between mb-3">
                  <span className="text-xs uppercase tracking-wider" style={{ color: "#8C8B86", letterSpacing: "0.1em" }}>{g.assetClass}</span>
                  <span className="text-xs pf-mono" style={{ color: "#6E6D67" }}>{fmt(g.value)}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {g.items.map((h) => (
                    <div key={h.id} className="pf-row flex items-center justify-between gap-3 px-3 py-3 rounded-lg" style={{ background: "#131314", border: "1px solid #1F1F22" }}>
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-medium truncate">{h.name}</span>
                        <span className="text-xs pf-mono" style={{ color: "#6E6D67" }}>{h.ticker || "—"} · {h.quantity} @ {fmt(h.avgPrice)}</span>
                      </div>
                      <div className="flex items-center gap-4 shrink-0">
                        <div className="text-right">
                          <div className="text-sm pf-mono">{fmt(h.value)}</div>
                          <div className="text-xs pf-mono" style={{ color: "#6E6D67" }}>Invested {fmt(h.invested)}</div>
                          <div className="text-xs pf-mono" style={{ color: h.pnl >= 0 ? "#8FAF8A" : "#C97B6B" }}>{fmt(h.pnl)} ({fmtPct(h.pnlPct)})</div>
                        </div>
                        <button className="pf-delete" onClick={() => deleteHolding(h.id)}><Trash2 size={14} color="#6E6D67" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {addingHolding ? (
              <div className="p-4 rounded-lg flex flex-col gap-3" style={{ background: "#131314", border: "1px solid #1F1F22" }}>
                <div className="flex flex-wrap gap-3">
                  <Field label="Class">
                    <select className="pf-input" style={inputStyle} value={hForm.assetClass} onChange={(e) => { setHForm({ ...hForm, assetClass: e.target.value, name: "", ticker: "", currentPrice: "" }); setSelectedFund(null); setFundSearchQuery(""); setFundSearchResults([]); }}>
                      {ASSET_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </Field>
                  {hForm.assetClass !== "Mutual Fund" && (
                    <>
                      <Field label="Name">
                        <input className="pf-input" style={{ ...inputStyle, width: 160 }} value={hForm.name} onChange={(e) => setHForm({ ...hForm, name: e.target.value })} placeholder="HDFC Bank" />
                      </Field>
                      <Field label="Ticker">
                        <input className="pf-input" style={{ ...inputStyle, width: 130 }} value={hForm.ticker} onChange={(e) => setHForm({ ...hForm, ticker: e.target.value })} placeholder="HDFCBANK" />
                      </Field>
                    </>
                  )}
                </div>
                {hForm.assetClass === "Mutual Fund" && (
                  <div className="rounded-lg p-3" style={{ background: "#101011", border: "1px solid #232326" }}>
                    {selectedFund ? (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs px-3 py-2 rounded-full" style={{ background: "rgba(201,168,118,0.12)", color: "#C9A876", border: "1px solid rgba(201,168,118,0.22)" }}>
                          Selected: <span className="pf-mono">{selectedFund.schemeCode}</span> · {selectedFund.schemeName}
                        </div>
                        <button onClick={() => { setSelectedFund(null); setHForm({ ...hForm, name: "", ticker: "", currentPrice: "" }); setFundSearchQuery(""); }} className="text-xs" style={{ color: "#C9A876" }}>change</button>
                      </div>
                    ) : (
                      <>
                        <Field label="Search mutual fund">
                          <input className="pf-input" style={{ ...inputStyle, width: "100%" }} value={fundSearchQuery} onChange={(e) => setFundSearchQuery(e.target.value)} placeholder="Type at least 2 characters, e.g. Parag Parikh Flexi Cap" />
                        </Field>
                        {searchingFunds && <div className="text-xs mt-2" style={{ color: "#6E6D67" }}>Searching funds…</div>}
                        {fundSearchNotice && <div className="text-xs mt-2" style={{ color: "#C97B6B" }}>{fundSearchNotice}</div>}
                        {fundSearchResults.length > 0 && (
                          <div className="flex flex-col gap-2 mt-3">
                            {fundSearchResults.slice(0, 8).map((fund) => (
                              <button key={fund.schemeCode} onClick={() => selectMutualFund(fund)} className="text-left text-xs p-2 rounded-lg" style={{ background: "#161617", color: "#A3A29C", border: "1px solid #2A2A2D" }}>
                                <span className="pf-mono" style={{ color: "#C9A876" }}>{fund.schemeCode}</span> · {fund.schemeName}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap gap-3">
                  <Field label="Quantity">
                    <input className="pf-input" style={{ ...inputStyle, width: 100 }} type="number" value={hForm.quantity} onChange={(e) => setHForm({ ...hForm, quantity: e.target.value })} />
                  </Field>
                  <Field label="Avg buy price ₹">
                    <input className="pf-input" style={{ ...inputStyle, width: 110 }} type="number" value={hForm.avgPrice} onChange={(e) => setHForm({ ...hForm, avgPrice: e.target.value })} />
                  </Field>
                  <Field label="Current price ₹">
                    <input className="pf-input" style={{ ...inputStyle, width: 110 }} type="number" value={hForm.currentPrice} onChange={(e) => setHForm({ ...hForm, currentPrice: e.target.value })} />
                  </Field>
                </div>
                <div className="flex gap-2 mt-1">
                  <button onClick={submitHolding} className="text-sm px-3 py-2 rounded-lg" style={{ background: "#C9A876", color: "#0B0B0C", fontWeight: 600 }}>Add holding</button>
                  <button onClick={() => { setAddingHolding(false); setSelectedFund(null); setFundSearchQuery(""); setFundSearchResults([]); }} className="text-sm px-3 py-2 rounded-lg" style={{ color: "#8C8B86" }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setAddingHolding(true)} className="flex items-center gap-2 text-sm mt-2" style={{ color: "#C9A876" }}>
                <Plus size={15} /> Add holding
              </button>
            )}
          </div>
        )}

        {/* Journal */}
        {tab === "journal" && (
          <div>
            <div className="flex gap-8 mb-6">
              <div>
                <div className="text-xs" style={{ color: "#6E6D67" }}>Trades</div>
                <div className="pf-mono text-lg">{totalTrades}</div>
              </div>
              <div>
                <div className="text-xs" style={{ color: "#6E6D67" }}>Win rate</div>
                <div className="pf-mono text-lg">{winRate.toFixed(0)}%</div>
              </div>
              <div>
                <div className="text-xs" style={{ color: "#6E6D67" }}>Net P&L</div>
                <div className="pf-mono text-lg" style={{ color: journalPnl >= 0 ? "#8FAF8A" : "#C97B6B" }}>{fmt(journalPnl)}</div>
              </div>
            </div>

            {journal.length === 0 && <div className="text-sm mb-6" style={{ color: "#6E6D67" }}>No trades logged yet.</div>}

            <div className="flex flex-col gap-2 mb-4">
              {journal.map((j) => (
                <div key={j.id} className="pf-row flex items-center justify-between gap-3 px-3 py-3 rounded-lg" style={{ background: "#131314", border: "1px solid #1F1F22" }}>
                  <div className="flex flex-col min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm pf-mono font-medium">{j.instrument}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full" style={{ border: "1px solid #2A2A2D", color: "#8C8B86" }}>{j.direction}</span>
                    </div>
                    <span className="text-xs pf-mono" style={{ color: "#6E6D67" }}>{j.date}{j.notes ? ` · ${j.notes}` : ""}</span>
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <span className="text-xs px-2 py-1 rounded-full" style={{ background: j.outcome === "WIN" ? "rgba(143,175,138,0.12)" : "rgba(201,123,107,0.12)", color: j.outcome === "WIN" ? "#8FAF8A" : "#C97B6B" }}>{j.outcome}</span>
                    <span className="text-sm pf-mono" style={{ color: j.pnl >= 0 ? "#8FAF8A" : "#C97B6B" }}>{fmt(j.pnl)}</span>
                    <button className="pf-delete" onClick={() => deleteJournal(j.id)}><Trash2 size={14} color="#6E6D67" /></button>
                  </div>
                </div>
              ))}
            </div>

            {addingJournal ? (
              <div className="p-4 rounded-lg flex flex-col gap-3" style={{ background: "#131314", border: "1px solid #1F1F22" }}>
                <div className="flex flex-wrap gap-3">
                  <Field label="Date">
                    <input className="pf-input" style={{ ...inputStyle, width: 140 }} type="date" value={jForm.date} onChange={(e) => setJForm({ ...jForm, date: e.target.value })} />
                  </Field>
                  <Field label="Instrument">
                    <input className="pf-input" style={{ ...inputStyle, width: 130 }} value={jForm.instrument} onChange={(e) => setJForm({ ...jForm, instrument: e.target.value })} placeholder="BTC/USDT" />
                  </Field>
                  <Field label="Direction">
                    <select className="pf-input" style={inputStyle} value={jForm.direction} onChange={(e) => setJForm({ ...jForm, direction: e.target.value })}>
                      <option>Long</option><option>Short</option>
                    </select>
                  </Field>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Field label="P&L ₹">
                    <input className="pf-input" style={{ ...inputStyle, width: 110 }} type="number" value={jForm.pnl} onChange={(e) => setJForm({ ...jForm, pnl: e.target.value })} />
                  </Field>
                  <Field label="Outcome">
                    <select className="pf-input" style={inputStyle} value={jForm.outcome} onChange={(e) => setJForm({ ...jForm, outcome: e.target.value })}>
                      <option>WIN</option><option>LOSS</option>
                    </select>
                  </Field>
                  <Field label="Notes">
                    <input className="pf-input" style={{ ...inputStyle, width: 200 }} value={jForm.notes} onChange={(e) => setJForm({ ...jForm, notes: e.target.value })} placeholder="optional" />
                  </Field>
                </div>
                <div className="flex gap-2 mt-1">
                  <button onClick={submitJournal} className="text-sm px-3 py-2 rounded-lg" style={{ background: "#C9A876", color: "#0B0B0C", fontWeight: 600 }}>Log trade</button>
                  <button onClick={() => setAddingJournal(false)} className="text-sm px-3 py-2 rounded-lg" style={{ color: "#8C8B86" }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setAddingJournal(true)} className="flex items-center gap-2 text-sm mt-2" style={{ color: "#C9A876" }}>
                <Plus size={15} /> Log trade
              </button>
            )}
          </div>
        )}

        {/* Allocation */}
        {tab === "allocation" && (
          <div className="flex flex-col gap-5">
            {totalValue === 0 && <div className="text-sm" style={{ color: "#6E6D67" }}>Add holdings to see your allocation breakdown.</div>}
            {byClass.map((g) => (
              <div key={g.assetClass}>
                <div className="flex items-baseline justify-between mb-2">
                  <span className="text-sm">{g.assetClass}</span>
                  <span className="text-sm pf-mono" style={{ color: "#8C8B86" }}>{fmt(g.value)} · {g.pct.toFixed(1)}%</span>
                </div>
                <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: "#161617" }}>
                  <div style={{ width: `${g.pct}%`, height: "100%", background: `rgba(201,168,118,${CLASS_OPACITY[g.assetClass]})` }} />
                </div>
              </div>
            ))}
            {totalInvested > 0 && (
              <div className="mt-4 pt-4 flex items-baseline justify-between" style={{ borderTop: "1px solid #232326" }}>
                <span className="text-sm" style={{ color: "#8C8B86" }}>Total invested</span>
                <span className="text-sm pf-mono">{fmt(totalInvested)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
