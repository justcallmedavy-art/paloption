/* StrategyOption trade page — chart, order panel and settlement.

   trade.html ships the markup but no behaviour: #asset-list, the chart and
   #order-buttons are empty until this file fills them. Prices come from the
   shared market engine in app.js (subscribe/tick), and window.StrategyOption
   .settle is what that engine calls after every tick so open positions can
   expire on time. */
(function () {
  "use strict";

  var S = window.StrategyOption;
  if (!S) return;
  if (!S.requireAuth()) return;

  var PAYOUT = 0.92;
  var MIN_STAKE = 0.1;
  var DURATIONS = [1, 5, 10, 15];
  var HELP = {
    rise_fall: "Predict if the price will rise or fall by expiry.",
    over_under: "Predict whether the last digit finishes above or below your pick.",
    even_odd: "Predict whether the last digit will be even or odd.",
    match_differ: "Predict whether the last digit matches your pick exactly.",
  };

  var view = { symbol: "BTC/USD", contract: "rise_fall", digit: 5, duration: 5 };

  function $(id) { return document.getElementById(id); }

  var els = {
    assetList: $("asset-list"),
    assetSearch: $("asset-search"),
    badge: $("asset-badge"),
    symbol: $("asset-symbol"),
    name: $("asset-name"),
    price: $("asset-price"),
    change: $("asset-change"),
    line: $("chart-line"),
    area: $("chart-area"),
    dot: $("chart-dot"),
    gradTop: $("chartGradTop"),
    lastDigit: $("last-digit"),
    openCount: $("open-count"),
    tabOpen: $("tab-open"),
    tabHistory: $("tab-history"),
    tabTx: $("tab-transactions"),
    contractTypes: $("contract-types"),
    contractHelp: $("contract-help"),
    digitPicker: $("digit-picker"),
    digitGrid: $("digit-grid"),
    stake: $("stake"),
    minWarning: $("min-warning"),
    durationGrid: $("duration-grid"),
    durationLabel: $("duration-label"),
    potential: $("potential"),
    payoutRate: $("payout-rate"),
    orderButtons: $("order-buttons"),
    userMenuBtn: $("user-menu-btn"),
    userMenu: $("user-menu"),
    logout: $("logout"),
    resetDemo: $("reset-demo"),
    accountSettings: $("toggle-2fa"),
  };

  if (!els.assetList || !els.orderButtons) return;

  function me() { return S.currentUser(); }
  function mine(list) {
    var u = me();
    return u ? list.filter(function (x) { return x.userId === u.id; }) : [];
  }
  function asset() {
    return S.ASSETS.filter(function (a) { return a.symbol === view.symbol; })[0];
  }
  function market() { return S.state[view.symbol]; }
  function priceText(n, digits) {
    var a = asset();
    return "$" + Number(n).toLocaleString("en-US", {
      minimumFractionDigits: digits == null ? (a ? a.digits : 2) : digits,
      maximumFractionDigits: digits == null ? (a ? a.digits : 2) : digits,
    });
  }
  function pct(n) { return (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }
  function colourFor(up) { return up ? "#22c55e" : "#f43f5e"; }

  function node(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  /* ------------------------------------------------------------------ *
   * header: balance, account, mode, user menu
   * ------------------------------------------------------------------ */
  function refreshHeader() {
    var u = me();
    document.querySelectorAll("[data-balance]").forEach(function (el) {
      el.textContent = S.money(S.balance());
    });
    document.querySelectorAll("[data-context]").forEach(function (el) {
      el.textContent = S.mode() === "real" ? "Real Account" : "Demo Account";
    });
    if (!u) return;
    document.querySelectorAll("[data-user-name]").forEach(function (el) { el.textContent = u.username; });
    document.querySelectorAll("[data-user-email]").forEach(function (el) { el.textContent = u.email; });
    document.querySelectorAll("[data-user-initial]").forEach(function (el) {
      el.textContent = (u.username || "?").trim().charAt(0).toUpperCase();
    });
    document.querySelectorAll("[data-mode]").forEach(function (btn) {
      var active = btn.getAttribute("data-mode") === S.mode();
      btn.style.background = active ? "#ff4d2e" : "";
      btn.classList.toggle("text-white", active);
      btn.classList.toggle("text-muted", !active);
    });
  }

  document.querySelectorAll("[data-mode]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var mode = btn.getAttribute("data-mode");
      if (mode === S.mode()) return;
      S.api.switchAccount(mode).then(function () {
        refreshHeader();
        renderOrderButtons();
        S.toast(mode === "real" ? "Switched to the real account" : "Switched to the demo account");
      });
    });
  });

  if (els.userMenuBtn && els.userMenu) {
    els.userMenuBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      els.userMenu.classList.toggle("hidden");
    });
    document.addEventListener("click", function () { els.userMenu.classList.add("hidden"); });
    els.userMenu.addEventListener("click", function (e) { e.stopPropagation(); });
  }

  if (els.logout) {
    els.logout.addEventListener("click", function () {
      S.api.logout();
      location.href = "login.html";
    });
  }

  if (els.resetDemo) {
    els.resetDemo.addEventListener("click", function () {
      S.api.resetDemo().then(function () {
        S.toast("Demo balance reset to $10,000", "success");
        refreshHeader();
        renderOpen();
        renderHistory();
      });
    });
  }

  if (els.accountSettings) {
    els.accountSettings.addEventListener("click", function () {
      S.toast("Account settings are not part of this static build");
    });
  }

  /* ------------------------------------------------------------------ *
   * asset list
   * ------------------------------------------------------------------ */
  function renderAssets(filter) {
    var q = (filter || "").trim().toLowerCase();
    els.assetList.textContent = "";
    S.ASSETS.forEach(function (a) {
      if (q && a.symbol.toLowerCase().indexOf(q) < 0 && a.name.toLowerCase().indexOf(q) < 0) return;
      var st = S.state[a.symbol];
      var up = st.price >= st.open;
      var row = node("button", "w-full flex items-center gap-3 px-3 py-2.5 text-left transition hover:bg-white/[0.03]" +
        (a.symbol === view.symbol ? " bg-white/[0.05]" : ""));
      var badge = node("span", "w-8 h-8 rounded-md flex items-center justify-center text-[11px] font-bold text-white shrink-0", a.short.charAt(0));
      badge.style.background = a.color;
      var body = node("span", "min-w-0 flex-1");
      body.appendChild(node("span", "block text-xs font-semibold text-primary truncate", a.symbol));
      body.appendChild(node("span", "block text-[10px] text-subtle truncate", a.name));
      var right = node("span", "text-right shrink-0");
      right.appendChild(node("span", "block text-xs font-semibold tabular-nums text-primary", priceText(st.price)));
      var delta = node("span", "block text-[10px] font-semibold tabular-nums", pct(((st.price - st.open) / st.open) * 100));
      delta.style.color = colourFor(up);
      right.appendChild(delta);
      row.appendChild(badge);
      row.appendChild(body);
      row.appendChild(right);
      row.addEventListener("click", function () { selectAsset(a.symbol); });
      els.assetList.appendChild(row);
    });
  }

  function selectAsset(symbol) {
    view.symbol = symbol;
    var a = asset();
    els.badge.textContent = a.short.charAt(0);
    els.badge.style.background = a.color;
    els.symbol.textContent = a.symbol;
    els.name.textContent = a.name;
    renderAssets(els.assetSearch ? els.assetSearch.value : "");
    drawPrice();
    drawChart();
    renderOrderButtons();
  }

  if (els.assetSearch) {
    els.assetSearch.addEventListener("input", function () {
      renderAssets(els.assetSearch.value);
    });
  }

  /* ------------------------------------------------------------------ *
   * chart + price header
   * ------------------------------------------------------------------ */
  function drawPrice() {
    var st = market();
    var up = st.price >= st.open;
    els.price.textContent = priceText(st.price);
    els.price.style.color = colourFor(up);
    els.change.textContent = pct(((st.price - st.open) / st.open) * 100);
    els.change.style.color = colourFor(up);
    els.lastDigit.textContent = "last digit: " + st.digit;
  }

  function drawChart() {
    var st = market();
    var series = st.series;
    if (!series || !series.length) return;
    var up = st.price >= st.open;
    var colour = colourFor(up);
    var points = series.map(function (v, i) {
      var x = (i / (series.length - 1)) * 500;
      var y = Math.max(6, Math.min(154, v));
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    // #chart-line is a <path>, so the shape goes in `d`; a `points` attribute
    // would be silently ignored and the line would stay at its markup value.
    els.line.setAttribute("d", "M" + points.join(" L"));
    els.line.setAttribute("stroke", colour);
    els.area.setAttribute("d", "M0," + points[0].split(",")[1] + " L" + points.join(" L") + " L500,160 L0,160 Z");
    els.dot.setAttribute("cx", points[points.length - 1].split(",")[0]);
    els.dot.setAttribute("cy", points[points.length - 1].split(",")[1]);
    els.dot.setAttribute("fill", colour);
    if (els.gradTop) els.gradTop.setAttribute("stop-color", colour);
    drawPrice();
  }

  /* ------------------------------------------------------------------ *
   * order panel
   * ------------------------------------------------------------------ */
  function sides() {
    if (view.contract === "rise_fall") {
      return [
        { dir: "rise", label: "Rise", colour: "#22c55e" },
        { dir: "fall", label: "Fall", colour: "#f43f5e" },
      ];
    }
    if (view.contract === "over_under") {
      return [
        { dir: "over", label: "Over " + view.digit, colour: "#22c55e" },
        { dir: "under", label: "Under " + view.digit, colour: "#f43f5e" },
      ];
    }
    if (view.contract === "even_odd") {
      return [
        { dir: "even", label: "Even", colour: "#22c55e" },
        { dir: "odd", label: "Odd", colour: "#f43f5e" },
      ];
    }
    return [
      { dir: "match", label: "Matches " + view.digit, colour: "#22c55e" },
      { dir: "differ", label: "Differs", colour: "#f43f5e" },
    ];
  }

  function renderOrderButtons() {
    els.orderButtons.textContent = "";
    sides().forEach(function (side) {
      var btn = node("button", "h-11 rounded-lg text-sm font-bold text-white transition");
      btn.style.background = side.colour;
      btn.textContent = side.label + " · " + S.money(stakeValue());
      btn.setAttribute("data-dir", side.dir);
      btn.addEventListener("click", function () { place(side.dir); });
      els.orderButtons.appendChild(btn);
    });
  }

  function stakeValue() {
    var n = Number(els.stake.value);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function renderPotential() {
    var stake = stakeValue();
    els.potential.textContent = S.money(stake * (1 + PAYOUT));
    els.payoutRate.textContent = Math.round(PAYOUT * 100) + "%";
    els.minWarning.classList.toggle("hidden", stake >= MIN_STAKE);
    renderOrderButtons();
  }

  document.querySelectorAll("[data-contract]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      view.contract = btn.getAttribute("data-contract");
      document.querySelectorAll("[data-contract]").forEach(function (b) {
        var active = b === btn;
        b.classList.toggle("border-[#FF4D2E]", active);
        b.classList.toggle("text-primary", active);
        b.classList.toggle("border-line", !active);
        b.classList.toggle("text-muted", !active);
      });
      els.contractHelp.textContent = HELP[view.contract];
      els.digitPicker.classList.toggle("hidden", view.contract === "rise_fall" || view.contract === "even_odd");
      renderOrderButtons();
    });
  });

  function renderDigits() {
    els.digitGrid.textContent = "";
    for (var d = 0; d < 10; d++) {
      (function (digit) {
        var btn = node("button", "h-9 rounded-md border text-xs font-bold transition " +
          (digit === view.digit ? "border-[#FF4D2E] bg-[#FF4D2E] text-white" : "border-line bg-field text-muted"));
        btn.textContent = String(digit);
        btn.addEventListener("click", function () {
          view.digit = digit;
          renderDigits();
          renderOrderButtons();
        });
        els.digitGrid.appendChild(btn);
      })(d);
    }
  }

  function renderDurations() {
    els.durationGrid.textContent = "";
    DURATIONS.forEach(function (ticks) {
      var active = ticks === view.duration;
      var btn = node("button", "flex-1 py-2 rounded-md border text-[11px] font-semibold transition " +
        (active ? "border-[#FF4D2E] bg-[#FF4D2E] text-white" : "border-line bg-field text-muted"));
      btn.textContent = ticks + " tick" + (ticks > 1 ? "s" : "");
      btn.addEventListener("click", function () {
        view.duration = ticks;
        els.durationLabel.textContent = ticks + " tick" + (ticks > 1 ? "s" : "");
        renderDurations();
      });
      els.durationGrid.appendChild(btn);
    });
  }

  document.querySelectorAll("[data-stake-step]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var next = Math.max(MIN_STAKE, stakeValue() + Number(btn.getAttribute("data-stake-step")));
      els.stake.value = String(Math.round(next * 100) / 100);
      renderPotential();
    });
  });

  document.querySelectorAll("[data-stake-set]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      els.stake.value = btn.getAttribute("data-stake-set");
      renderPotential();
    });
  });

  if (els.stake) {
    els.stake.addEventListener("input", renderPotential);
  }

  /* ------------------------------------------------------------------ *
   * placing and settling
   * ------------------------------------------------------------------ */
  function place(dir) {
    var u = me();
    if (!u) return;
    var stake = stakeValue();
    if (stake < MIN_STAKE) {
      els.minWarning.classList.remove("hidden");
      S.toast("Minimum stake amount is $0.10", "error");
      return;
    }
    if (stake > S.balance()) {
      S.toast("Not enough balance in this account", "error");
      return;
    }
    var st = market();
    var now = Date.now();
    S.db.positions.push({
      id: "p_" + now.toString(36),
      userId: u.id,
      symbol: view.symbol,
      contract: view.contract,
      dir: dir,
      digit: view.digit,
      stake: stake,
      entryPrice: st.price,
      entryDigit: st.digit,
      ticks: view.duration,
      remaining: view.duration,
      payout: PAYOUT,
      status: "open",
      createdAt: now,
    });
    S.db.transactions.push({
      id: "t_" + now.toString(36),
      userId: u.id,
      type: "trade",
      amount: -stake,
      mode: S.mode(),
      method: view.contract.replace(/_/g, " "),
      status: "completed",
      createdAt: now,
    });
    S.adjustBalance(-stake);
    S.save();
    renderOpen();
    renderTransactions();
    refreshHeader();
    S.toast(dir + " " + view.symbol + " — " + S.money(stake) + " at " + priceText(st.price), "success");
  }

  function didWin(p, price, digit) {
    if (p.contract === "rise_fall") return p.dir === "rise" ? price > p.entryPrice : price < p.entryPrice;
    if (p.contract === "over_under") return p.dir === "over" ? digit > p.digit : digit < p.digit;
    if (p.contract === "even_odd") return p.dir === "even" ? digit % 2 === 0 : digit % 2 === 1;
    return p.dir === "match" ? digit === p.digit : digit !== p.digit;
  }

  /* Called by app.js after every tick. */
  function settle() {
    var open = mine(S.db.positions).filter(function (p) { return p.status === "open"; });
    if (!open.length) return;
    var settled = 0;
    open.forEach(function (p) {
      p.remaining -= 1;
      if (p.remaining > 0) return;
      var st = S.state[p.symbol];
      var won = didWin(p, st.price, st.digit);
      var now = Date.now();
      p.status = "closed";
      p.result = won ? "won" : "lost";
      p.exitPrice = st.price;
      p.exitDigit = st.digit;
      p.closedAt = now;
      if (won) {
        var payout = p.stake * (1 + p.payout);
        S.db.transactions.push({
          id: "t_" + now.toString(36) + "_w",
          userId: p.userId,
          type: "payout",
          amount: payout,
          mode: S.mode(),
          method: "Payout",
          status: "completed",
          createdAt: now,
        });
        S.adjustBalance(payout);
        S.toast("Won " + S.money(payout) + " on " + p.symbol, "success");
      } else {
        S.toast("Lost " + S.money(p.stake) + " on " + p.symbol, "error");
      }
      settled += 1;
    });
    if (!settled && !open.some(function (p) { return p.remaining <= 0; })) {
      S.save();
    } else {
      S.save();
      renderHistory();
      renderTransactions();
      refreshHeader();
    }
    renderOpen();
  }

  S.settle = settle;

  /* ------------------------------------------------------------------ *
   * positions, history, transactions
   * ------------------------------------------------------------------ */
  function emptyRow(text) {
    return node("div", "px-1 py-6 text-center text-xs text-subtle", text);
  }

  function directionLabel(p) {
    var label = p.dir.charAt(0).toUpperCase() + p.dir.slice(1);
    if (p.contract === "over_under" || p.contract === "match_differ") label += " " + p.digit;
    return label;
  }

  function renderOpen() {
    var open = mine(S.db.positions).filter(function (p) { return p.status === "open"; });
    els.openCount.textContent = "(" + open.length + ")";
    els.tabOpen.textContent = "";
    if (!open.length) {
      els.tabOpen.appendChild(emptyRow("No open positions. Place a trade from the panel on the right."));
      return;
    }
    open.forEach(function (p) {
      var win = p.dir === "rise" || p.dir === "over" || p.dir === "even" || p.dir === "match";
      var row = node("div", "flex items-center justify-between gap-3 px-1 py-2.5 border-b border-white/[0.04] text-xs");
      var left = node("div", "min-w-0");
      left.appendChild(node("div", "font-semibold text-primary", p.symbol + " · " + directionLabel(p)));
      left.appendChild(node("div", "text-[10px] text-subtle", p.remaining + " of " + p.ticks + " ticks left · entry " + priceText(p.entryPrice)));
      var right = node("div", "text-right shrink-0");
      var stake = node("div", "font-semibold tabular-nums", S.money(p.stake));
      stake.style.color = win ? "#22c55e" : "#f43f5e";
      right.appendChild(stake);
      right.appendChild(node("div", "text-[10px] text-subtle", "potential " + S.money(p.stake * (1 + p.payout))));
      row.appendChild(left);
      row.appendChild(right);
      els.tabOpen.appendChild(row);
    });
  }

  function renderHistory() {
    var closed = mine(S.db.positions).filter(function (p) { return p.status === "closed"; })
      .sort(function (a, b) { return b.closedAt - a.closedAt; });
    els.tabHistory.textContent = "";
    if (!closed.length) {
      els.tabHistory.appendChild(emptyRow("No settled trades yet."));
      return;
    }
    closed.forEach(function (p) {
      var won = p.result === "won";
      var row = node("div", "flex items-center justify-between gap-3 px-1 py-2.5 border-b border-white/[0.04] text-xs");
      var left = node("div", "min-w-0");
      left.appendChild(node("div", "font-semibold text-primary", p.symbol + " · " + directionLabel(p)));
      left.appendChild(node("div", "text-[10px] text-subtle",
        S.timeAgo(p.closedAt) + " · entry " + priceText(p.entryPrice) + " → exit " + priceText(p.exitPrice)));
      var right = node("div", "text-right shrink-0");
      var amount = node("div", "font-semibold tabular-nums", (won ? "+" : "−") + S.money(won ? p.stake * p.payout : p.stake).slice(1));
      amount.style.color = won ? "#22c55e" : "#f43f5e";
      right.appendChild(amount);
      right.appendChild(node("div", "text-[10px] uppercase tracking-wide", won ? "won" : "lost"));
      row.appendChild(left);
      row.appendChild(right);
      els.tabHistory.appendChild(row);
    });
  }

  function renderTransactions() {
    var tx = mine(S.db.transactions).sort(function (a, b) { return b.createdAt - a.createdAt; });
    els.tabTx.textContent = "";
    if (!tx.length) {
      els.tabTx.appendChild(emptyRow("No transactions yet."));
      return;
    }
    tx.forEach(function (t) {
      var credit = t.amount >= 0;
      var row = node("div", "flex items-center justify-between gap-3 px-1 py-2.5 border-b border-white/[0.04] text-xs");
      var left = node("div", "min-w-0");
      left.appendChild(node("div", "font-semibold text-primary capitalize", t.type + " · " + (t.method || "")));
      left.appendChild(node("div", "text-[10px] text-subtle", S.timeAgo(t.createdAt) + " · " + (t.mode || "demo") + " · " + (t.status || "completed")));
      var amount = node("div", "font-semibold tabular-nums shrink-0", (credit ? "+" : "−") + S.money(Math.abs(t.amount)).slice(1));
      amount.style.color = credit ? "#22c55e" : "#f43f5e";
      row.appendChild(left);
      row.appendChild(amount);
      els.tabTx.appendChild(row);
    });
  }

  /* ------------------------------------------------------------------ *
   * tabs
   * ------------------------------------------------------------------ */
  var panels = { open: els.tabOpen, history: els.tabHistory, transactions: els.tabTx };
  document.querySelectorAll("[data-tab]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var which = btn.getAttribute("data-tab");
      document.querySelectorAll("[data-tab]").forEach(function (b) {
        var active = b === btn;
        b.classList.toggle("border-[#FF4D2E]", active);
        b.classList.toggle("text-primary", active);
        b.classList.toggle("border-transparent", !active);
        b.classList.toggle("text-muted", !active);
      });
      Object.keys(panels).forEach(function (key) {
        panels[key].classList.toggle("hidden", key !== which);
      });
    });
  });

  /* ------------------------------------------------------------------ *
   * start
   * ------------------------------------------------------------------ */
  refreshHeader();
  selectAsset(view.symbol);
  renderDigits();
  renderDurations();
  renderPotential();
  renderOpen();
  renderHistory();
  renderTransactions();

  S.subscribe(function () {
    drawChart();
    if (els.assetSearch && els.assetSearch.value) renderAssets(els.assetSearch.value);
  });
})();
