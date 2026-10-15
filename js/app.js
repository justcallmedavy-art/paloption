/* PalOption clone — shared core.
 *
 * Frontend clone of paloptions.com. The real client talks to
 * https://api.paloption.com (/api/auth/*, /ws). That backend is not part of the
 * clone, so this file provides a local, in-browser stand-in with the same shape.
 *
 * Everything here is simulation: accounts and balances live in localStorage,
 * prices are generated locally. No money moves and nothing leaves the browser.
 */
(function () {
  "use strict";

  var BRAND = "#FF4D2E";
  var BRAND_2 = "#2563EB";

  /* ------------------------------------------------------------------ *
   * Tiny storage helpers
   * ------------------------------------------------------------------ */
  var DB_KEY = "paloption-db";
  var SESSION_KEY = "paloption-session";
  var THEME_KEY = "theme-storage";

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage unavailable — state becomes session-only */
    }
  }

  var db = read(DB_KEY, null) || { users: [], positions: [], transactions: [] };
  function save() {
    write(DB_KEY, db);
  }

  /* ------------------------------------------------------------------ *
   * Theme  (mirrors the original's zustand `theme-storage` store)
   * ------------------------------------------------------------------ */
  var themeStore = read(THEME_KEY, { state: { isDarkTheme: true }, version: 0 });
  if (!themeStore.state) themeStore = { state: { isDarkTheme: true }, version: 0 };

  function isDark() {
    return themeStore.state.isDarkTheme !== false;
  }

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", isDark() ? "dark" : "light");
  }

  function toggleTheme() {
    themeStore.state.isDarkTheme = !isDark();
    write(THEME_KEY, themeStore);
    applyTheme();
    document.dispatchEvent(new CustomEvent("paloption:theme"));
  }

  applyTheme();

  /* ------------------------------------------------------------------ *
   * Auth
   * ------------------------------------------------------------------ */
  function hash(str) {
    // Not security — just avoids storing raw passwords in localStorage.
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
    return (h >>> 0).toString(16);
  }

  function session() {
    return read(SESSION_KEY, null);
  }

  function currentUser() {
    var s = session();
    if (!s) return null;
    return db.users.filter(function (u) { return u.id === s.userId; })[0] || null;
  }

  function setSession(userId, mode) {
    write(SESSION_KEY, { userId: userId, token: "demo-" + Math.random().toString(36).slice(2), mode: mode || "demo" });
  }

  function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  var api = {
    /** POST /api/auth/register */
    register: function (fullName, password, email, referral) {
      return delay(400).then(function () {
        if (!fullName || fullName.trim().length < 2) throw new Error("Please enter your full name");
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || "")) throw new Error("Please enter a valid email address");
        if (!password || password.length < 6) throw new Error("Password must be at least 6 characters");
        if (db.users.some(function (u) { return u.email.toLowerCase() === email.toLowerCase(); })) {
          throw new Error("An account with this email already exists");
        }
        var user = {
          id: "u_" + Date.now().toString(36),
          username: fullName.trim(),
          email: email.trim(),
          passwordHash: hash(password),
          referral: referral || null,
          twoFactorEnabled: false,
          balances: { demo: 10000, real: 0 },
          createdAt: Date.now(),
        };
        db.users.push(user);
        db.transactions.push({
          id: "t_" + Date.now().toString(36), userId: user.id, type: "deposit",
          amount: 10000, mode: "demo", method: "Demo balance", status: "completed", createdAt: Date.now(),
        });
        save();
        setSession(user.id, "demo");
        return { user: user };
      });
    },

    /** POST /api/auth/login */
    login: function (email, password) {
      return delay(400).then(function () {
        var user = db.users.filter(function (u) {
          return u.email.toLowerCase() === (email || "").toLowerCase();
        })[0];
        if (!user || user.passwordHash !== hash(password || "")) throw new Error("Invalid email or password");
        if (user.twoFactorEnabled) {
          var code = String(Math.floor(100000 + Math.random() * 900000));
          user._pendingCode = code;
          save();
          return { requires2FA: true, tempToken: "tmp_" + user.id, demoCode: code };
        }
        setSession(user.id, "demo");
        return { user: user };
      });
    },

    /** POST /api/auth/login/verify-2fa */
    verify2FA: function (tempToken, code) {
      return delay(300).then(function () {
        var user = db.users.filter(function (u) { return "tmp_" + u.id === tempToken; })[0];
        if (!user) throw new Error("Session expired, please sign in again");
        if (user._pendingCode !== code) throw new Error("Invalid verification code");
        delete user._pendingCode;
        save();
        setSession(user.id, "demo");
        return { user: user };
      });
    },

    /** POST /api/auth/demo — one-tap demo account */
    demo: function () {
      return delay(300).then(function () {
        var user = {
          id: "u_" + Date.now().toString(36),
          username: "Demo Trader",
          email: "demo+" + Date.now().toString(36) + "@example.com",
          passwordHash: hash("demo"),
          twoFactorEnabled: false,
          balances: { demo: 10000, real: 0 },
          createdAt: Date.now(),
        };
        db.users.push(user);
        save();
        setSession(user.id, "demo");
        return { user: user };
      });
    },

    /** POST /api/auth/switch-account */
    switchAccount: function (mode) {
      return delay(150).then(function () {
        var s = session();
        if (!s) throw new Error("Not signed in");
        s.mode = mode;
        write(SESSION_KEY, s);
        return { mode: mode };
      });
    },

    /** POST /api/auth/reset-demo */
    resetDemo: function () {
      return delay(200).then(function () {
        var u = currentUser();
        if (!u) throw new Error("Not signed in");
        u.balances.demo = 10000;
        db.positions = db.positions.filter(function (p) { return p.userId !== u.id; });
        save();
        return { balance: 10000 };
      });
    },

    logout: function () {
      try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    },
  };

  /* ------------------------------------------------------------------ *
   * Account helpers
   * ------------------------------------------------------------------ */
  function mode() {
    var s = session();
    return s && s.mode === "real" ? "real" : "demo";
  }

  function balance() {
    var u = currentUser();
    return u ? u.balances[mode()] || 0 : 0;
  }

  function adjustBalance(delta) {
    var u = currentUser();
    if (!u) return 0;
    u.balances[mode()] = Math.max(0, (u.balances[mode()] || 0) + delta);
    save();
    document.dispatchEvent(new CustomEvent("paloption:balance"));
    return u.balances[mode()];
  }

  function requireAuth() {
    if (!currentUser()) {
      location.replace("login.html?next=" + encodeURIComponent(location.pathname.split("/").pop() || "trade.html"));
      return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Market engine — stands in for the realtime WebSocket feed
   * ------------------------------------------------------------------ */
  var ASSETS = [
    { symbol: "BTC/USD", name: "Bitcoin / US Dollar", short: "BTC", color: "#f7931a", base: 43256.78, vol: 22, digits: 2 },
    { symbol: "ETH/USD", name: "Ethereum / US Dollar", short: "ETH", color: "#627eea", base: 2284.15, vol: 2.1, digits: 2 },
    { symbol: "SOL/USD", name: "Solana / US Dollar", short: "SOL", color: "#9945ff", base: 98.42, vol: 0.22, digits: 2 },
    { symbol: "XAU/USD", name: "Gold / US Dollar", short: "XAU", color: "#d4a017", base: 2024.3, vol: 0.9, digits: 2 },
    { symbol: "EUR/USD", name: "Euro / US Dollar", short: "EUR", color: "#0052b4", base: 1.08924, vol: 0.0005, digits: 4 },
    { symbol: "GBP/USD", name: "British Pound / US Dollar", short: "GBP", color: "#c8102e", base: 1.26542, vol: 0.0006, digits: 4 },
    { symbol: "AAPL", name: "Apple Inc.", short: "AAPL", color: "#555555", base: 178.32, vol: 0.35, digits: 2 },
    { symbol: "TSLA", name: "Tesla Inc.", short: "TSLA", color: "#e31937", base: 248.9, vol: 0.8, digits: 2 },
  ];

  var state = {};
  ASSETS.forEach(function (a) {
    state[a.symbol] = { price: a.base, open: a.base, series: [], tick: 0, digit: lastDigit(a.base) };
    for (var i = 0; i < 60; i++) state[a.symbol].series.push(80);
  });

  function lastDigit(price) {
    var s = price.toFixed(4).replace(".", "");
    return Number(s[s.length - 1]);
  }

  var subscribers = [];
  var running = false;

  function tick() {
    ASSETS.forEach(function (a) {
      var st = state[a.symbol];
      var drift = (a.base - st.price) * 0.01;
      st.price = Math.max(0.0001, st.price + (Math.random() - 0.5) * a.vol + drift);
      st.tick += 1;
      st.digit = lastDigit(st.price);
      var last = st.series[st.series.length - 1];
      st.series.push(Math.max(18, Math.min(142, last + (Math.random() - 0.5) * 9 + (80 - last) * 0.03)));
      if (st.series.length > 60) st.series.shift();
    });
    subscribers.forEach(function (fn) { try { fn(state, ASSETS); } catch (e) { /* isolate listeners */ } });
    if (window.PalOption.settle) window.PalOption.settle();
  }

  function start() {
    if (running) return;
    running = true;
    setInterval(tick, 900);
  }

  function subscribe(fn) {
    subscribers.push(fn);
    if (subscribers.length === 1) start();
    fn(state, ASSETS);
    return function () {
      subscribers = subscribers.filter(function (f) { return f !== fn; });
    };
  }

  /* ------------------------------------------------------------------ *
   * Formatting
   * ------------------------------------------------------------------ */
  var money = function (n, digits) {
    return "$" + Number(n).toLocaleString("en-US", {
      minimumFractionDigits: digits == null ? 2 : digits,
      maximumFractionDigits: digits == null ? 2 : digits,
    });
  };

  function timeAgo(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " min ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + " hour" + (h > 1 ? "s" : "") + " ago";
    return Math.floor(h / 24) + "d ago";
  }

  function toast(message, kind) {
    var el = document.createElement("div");
    var colour = kind === "error" ? "#f43f5e" : kind === "success" ? "#22c55e" : BRAND;
    el.style.cssText =
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;" +
      "background:" + colour + ";color:#fff;padding:12px 18px;border-radius:12px;" +
      "font:600 14px/1.4 'IBM Plex Sans',system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35);" +
      "max-width:min(92vw,420px);transition:opacity .3s";
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () {
      el.style.opacity = "0";
      setTimeout(function () { el.remove(); }, 300);
    }, 2600);
  }

  /* ------------------------------------------------------------------ *
   * Theme toggle wiring for every page
   * ------------------------------------------------------------------ */
  document.addEventListener("DOMContentLoaded", function () {
    applyTheme();
    document.querySelectorAll("#theme-toggle, [data-theme-toggle]").forEach(function (btn) {
      btn.addEventListener("click", toggleTheme);
    });

    // Reflect signed-in state in any nav that opts in.
    var u = currentUser();
    document.querySelectorAll("[data-auth-guest]").forEach(function (el) {
      el.hidden = !!u;
    });
    document.querySelectorAll("[data-auth-user]").forEach(function (el) {
      el.hidden = !u;
    });
    document.querySelectorAll("[data-user-name]").forEach(function (el) {
      if (u) el.textContent = u.username;
    });
    document.querySelectorAll("[data-balance]").forEach(function (el) {
      el.textContent = money(balance());
    });
    document.querySelectorAll("[data-context]").forEach(function (el) {
      el.textContent = mode() === "real" ? "Real Account" : "Demo Account";
    });
  });

  document.addEventListener("paloption:balance", function () {
    document.querySelectorAll("[data-balance]").forEach(function (el) {
      el.textContent = money(balance());
    });
  });

  window.PalOption = {
    BRAND: BRAND,
    BRAND_2: BRAND_2,
    api: api,
    db: db,
    save: save,
    ASSETS: ASSETS,
    state: state,
    subscribe: subscribe,
    tick,
    isDark: isDark,
    toggleTheme: toggleTheme,
    currentUser: currentUser,
    session: session,
    mode: mode,
    balance: balance,
    adjustBalance: adjustBalance,
    requireAuth: requireAuth,
    money: money,
    timeAgo: timeAgo,
    toast: toast,
    lastDigit: lastDigit,
  };
})();
