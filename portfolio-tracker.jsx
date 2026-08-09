import React, { useState, useEffect, useMemo, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported } from "firebase/analytics";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { doc, getFirestore, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { LogIn, LogOut, Plus, RefreshCw, Trash2, TrendingUp, TrendingDown, X } from "lucide-react";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
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

const todayISO = () => new Date().toISOString().slice(0, 10);
const toMfDate = (isoDate) => {
  const [year, month, day] = isoDate.split("-");
  return `${day}-${month}-${year}`;
};
const parseMfDate = (date) => {
  const [day, month, year] = String(date || "").split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};
const isTodayOrFuture = (isoDate) => !isoDate || isoDate >= todayISO();
const roundQuantity = (quantity, assetClass) => {
  const precision = assetClass === "Equity" ? 2 : 4;
  return Number(quantity.toFixed(precision));
};

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

async function fetchMutualFundHistoricalNAV(schemeCode, isoDate) {
  if (isTodayOrFuture(isoDate)) return fetchMutualFundNAV(schemeCode);

  const cleanCode = String(schemeCode || "").trim();
  if (!/^\d{6}$/.test(cleanCode)) throw new Error("invalid scheme code");

  const response = await fetch(`https://api.mfapi.in/mf/${cleanCode}`);
  if (!response.ok) throw new Error(`NAV history lookup failed (${response.status})`);

  const payload = await response.json();
  if (payload.status && payload.status !== "SUCCESS") throw new Error("scheme code does not exist");

  const target = parseMfDate(toMfDate(isoDate)).getTime();
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const match = entries.find((entry) => parseMfDate(entry.date).getTime() <= target);
  const nav = Number.parseFloat(match?.nav);
  if (Number.isNaN(nav)) throw new Error("historical NAV is missing");

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


async function resolveCryptoId(query) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) throw new Error("missing crypto ticker");

  const response = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(cleanQuery)}`);
  if (!response.ok) throw new Error(`crypto search failed (${response.status})`);

  const payload = await response.json();
  const queryLower = cleanQuery.toLowerCase();
  const coin = (payload?.coins || []).find((item) => item.symbol?.toLowerCase() === queryLower) || payload?.coins?.[0];
  if (!coin?.id) throw new Error("crypto asset not found");
  return coin.id;
}

async function fetchCryptoLatestPrice(query) {
  const cgId = await resolveCryptoId(query);
  const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(cgId)}&vs_currencies=inr`);
  if (!response.ok) throw new Error(`crypto price lookup failed (${response.status})`);

  const payload = await response.json();
  const price = Number(payload?.[cgId]?.inr);
  if (!Number.isFinite(price) || price <= 0) throw new Error("crypto price is missing");
  return { price, cgId };
}

async function fetchCryptoHistoricalPrice(query, isoDate) {
  if (isTodayOrFuture(isoDate)) return fetchCryptoLatestPrice(query);

  const cgId = await resolveCryptoId(query);
  const response = await fetch(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(cgId)}/history?date=${toMfDate(isoDate)}&localization=false`);
  if (!response.ok) throw new Error(`crypto history lookup failed (${response.status})`);

  const payload = await response.json();
  const price = Number(payload?.market_data?.current_price?.inr);
  if (!Number.isFinite(price) || price <= 0) throw new Error("historical crypto price is missing");
  return { price, cgId };
}

const twelveDataKey = () => import.meta.env?.VITE_TWELVE_DATA_API_KEY || import.meta.env?.VITE_TWELVEDATA_API_KEY || "";

async function fetchEquityPrice(ticker, isoDate = todayISO()) {
  const cleanTicker = String(ticker || "").trim().toUpperCase();
  const apiKey = twelveDataKey();
  if (!cleanTicker) throw new Error("missing equity ticker");
  if (!apiKey) throw new Error("Twelve Data API key is missing");

  const target = new Date(`${isoDate}T00:00:00Z`);
  const start = new Date(target);
  start.setUTCDate(start.getUTCDate() - 10);
  const params = new URLSearchParams({
    symbol: cleanTicker,
    interval: "1day",
    start_date: start.toISOString().slice(0, 10),
    end_date: isoDate,
    apikey: apiKey,
  });
  const response = await fetch(`https://api.twelvedata.com/time_series?${params.toString()}`);
  if (!response.ok) throw new Error(`equity price lookup failed (${response.status})`);

  const payload = await response.json();
  if (payload.status === "error") throw new Error(payload.message || "equity price lookup failed");

  const targetTime = target.getTime();
  const entry = (payload.values || [])
    .filter((value) => new Date(`${value.datetime}T00:00:00Z`).getTime() <= targetTime)
    .sort((a, b) => new Date(`${b.datetime}T00:00:00Z`) - new Date(`${a.datetime}T00:00:00Z`))[0];
  const price = Number.parseFloat(entry?.close);
  if (!Number.isFinite(price) || price <= 0) throw new Error("equity close price is missing");

  return price;
}

async function fetchLatestAssetPrice(assetClass, ticker) {
  if (assetClass === "Mutual Fund") return fetchMutualFundNAV(ticker);
  if (assetClass === "Crypto") return (await fetchCryptoLatestPrice(ticker)).price;
  return fetchEquityPrice(ticker, todayISO());
}

async function fetchInvestedAssetPrice(assetClass, ticker, isoDate) {
  if (assetClass === "Mutual Fund") return fetchMutualFundHistoricalNAV(ticker, isoDate);
  if (assetClass === "Crypto") return (await fetchCryptoHistoricalPrice(ticker, isoDate)).price;
  return fetchEquityPrice(ticker, isTodayOrFuture(isoDate) ? todayISO() : isoDate);
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
  const [lookingUpHoldingPrice, setLookingUpHoldingPrice] = useState(false);
  const [holdingPriceNote, setHoldingPriceNote] = useState("");
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

  const [hForm, setHForm] = useState({ assetClass: "Equity", name: "", ticker: "", amountInvested: "", dateInvested: todayISO(), currentPrice: "" });
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
    if (holdings.length === 0) {
      if (!silent) setNotice("Add a holding to refresh prices.");
      setNavErrors([]);
      return;
    }

    setRefreshingNAV(true);
    setNavErrors([]);
    const results = await Promise.allSettled(holdings.map(async (holding) => {
      const currentPrice = await fetchLatestAssetPrice(holding.assetClass, holding.cgId || holding.ticker);
      return { id: holding.id, currentPrice };
    }));

    const priceById = new Map();
    const errors = [];
    results.forEach((result, index) => {
      const holding = holdings[index];
      if (result.status === "fulfilled") {
        priceById.set(result.value.id, result.value.currentPrice);
      } else {
        errors.push(`${holding.name}: ${result.reason?.message || "couldn't refresh price"}`);
      }
    });

    if (priceById.size > 0) {
      const next = holdings.map((holding) => (
        priceById.has(holding.id) ? { ...holding, currentPrice: priceById.get(holding.id) } : holding
      ));
      await savePortfolio(next, journal);
    }

    setNavErrors(errors);
    if (!silent || errors.length > 0) {
      setNotice(`${priceById.size} price${priceById.size === 1 ? "" : "s"} refreshed${errors.length ? ` · ${errors.length} issue${errors.length === 1 ? "" : "s"}` : ""}.`);
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



  const submitHolding = async () => {
    const amountInvested = Number.parseFloat(hForm.amountInvested);
    const ticker = hForm.assetClass === "Mutual Fund" ? hForm.ticker.trim() : hForm.ticker.trim().toUpperCase();
    const investedDate = hForm.dateInvested || todayISO();
    if (!hForm.name.trim() || !ticker || !Number.isFinite(amountInvested) || amountInvested <= 0) {
      setNotice("Fill in asset details and a positive amount invested.");
      return;
    }

    setLookingUpHoldingPrice(true);
    setHoldingPriceNote("");
    try {
      let avgPrice;
      let currentPrice;
      let usedFallback = false;
      try {
        [avgPrice, currentPrice] = await Promise.all([
          fetchInvestedAssetPrice(hForm.assetClass, ticker, investedDate),
          fetchLatestAssetPrice(hForm.assetClass, ticker),
        ]);
      } catch (e) {
        currentPrice = await fetchLatestAssetPrice(hForm.assetClass, ticker);
        avgPrice = currentPrice;
        usedFallback = true;
      }

      const quantity = roundQuantity(amountInvested / avgPrice, hForm.assetClass);
      const next = [...holdings, { id: uid(), assetClass: hForm.assetClass, name: hForm.name.trim(), ticker, quantity, avgPrice, currentPrice }];
      await savePortfolio(next, journal);
      if (usedFallback) setNotice("Using today's price — historical data unavailable");
      setHForm({ assetClass: "Equity", name: "", ticker: "", amountInvested: "", dateInvested: todayISO(), currentPrice: "" });
      setSelectedFund(null);
      setFundSearchQuery("");
      setFundSearchResults([]);
      setAddingHolding(false);
    } catch (e) {
      setHoldingPriceNote(e.message || "Price lookup failed.");
    } finally {
      setLookingUpHoldingPrice(false);
    }
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
                    <select className="pf-input" style={inputStyle} value={hForm.assetClass} onChange={(e) => { setHForm({ ...hForm, assetClass: e.target.value, name: "", ticker: "", currentPrice: "" }); setHoldingPriceNote(""); setSelectedFund(null); setFundSearchQuery(""); setFundSearchResults([]); }}>
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
                        <button onClick={() => { setSelectedFund(null); setHForm({ ...hForm, name: "", ticker: "", currentPrice: "" }); setHoldingPriceNote(""); setFundSearchQuery(""); }} className="text-xs" style={{ color: "#C9A876" }}>change</button>
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
                  <Field label="Amount invested ₹">
                    <input className="pf-input" style={{ ...inputStyle, width: 150 }} type="number" min="0" step="0.01" value={hForm.amountInvested} onChange={(e) => setHForm({ ...hForm, amountInvested: e.target.value })} required />
                  </Field>
                  <Field label="Date invested">
                    <input className="pf-input" style={{ ...inputStyle, width: 150 }} type="date" value={hForm.dateInvested} onChange={(e) => setHForm({ ...hForm, dateInvested: e.target.value })} />
                  </Field>
                  <Field label="Current price ₹">
                    <input className="pf-input" style={{ ...inputStyle, width: 130, color: "#8C8B86" }} type="number" value={hForm.currentPrice} readOnly placeholder="auto" />
                  </Field>
                </div>
                {holdingPriceNote && <div className="text-xs" style={{ color: "#C9A876" }}>{holdingPriceNote}</div>}
                <div className="flex gap-2 mt-1">
                  <button onClick={submitHolding} disabled={lookingUpHoldingPrice} className="text-sm px-3 py-2 rounded-lg" style={{ background: "#C9A876", color: "#0B0B0C", fontWeight: 600, opacity: lookingUpHoldingPrice ? 0.7 : 1 }}>{lookingUpHoldingPrice ? "Looking up price…" : "Add holding"}</button>
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
