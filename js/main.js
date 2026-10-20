/* StrategyOption landing clone — client behaviour
   Keeps the SSR'd markup intact and layers on the interactions the original
   hydrates: theme toggle, live BTC/USD ticker + chart, and a trade feed. */

(function () {
  "use strict";

  /* ---------------- Theme toggle ---------------- */
  var root = document.documentElement;
  var toggle = document.getElementById("theme-toggle");
  var saved = null;
  try {
    saved = localStorage.getItem("strategyoption-theme");
  } catch (e) {
    saved = null;
  }
  if (saved) root.setAttribute("data-theme", saved);

  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem("strategyoption-theme", next);
      } catch (e) {
        /* storage unavailable — session-only toggle */
      }
    });
  }

  /* ---------------- Live BTC/USD feed ---------------- */
  var CHART_W = 500;
  var CHART_H = 160;
  var POINTS = 80;
  var price = 43256.78;
  var open = price;
  var series = [];

  for (var i = 0; i < POINTS; i++) series.push(80);

  function step() {
    // Random walk with a gentle pull back toward the middle of the viewBox.
    var drift = (80 - series[series.length - 1]) * 0.02;
    var next = series[series.length - 1] + (Math.random() - 0.5) * 9 + drift;
    next = Math.max(18, Math.min(142, next));
    series.push(next);
    if (series.length > POINTS) series.shift();

    price += (Math.random() - 0.5) * 12;
    return next;
  }

  function pathFrom(values) {
    var stepX = CHART_W / (POINTS - 1);
    var d = "M0," + values[0].toFixed(2);
    for (var i = 1; i < values.length; i++) {
      d += " L" + (i * stepX).toFixed(2) + "," + values[i].toFixed(2);
    }
    return d;
  }

  var line = document.getElementById("live-line");
  var area = document.getElementById("live-area");
  var dot = document.getElementById("live-dot");
  var pulse = document.getElementById("live-pulse");
  var priceEl = document.getElementById("live-price");
  var changeEl = document.getElementById("live-change");
  var badgeEl = document.getElementById("live-badge");
  var gradTop = document.getElementById("liveGradTop");

  function render() {
    step();
    var d = pathFrom(series);
    if (line) line.setAttribute("d", d);
    if (area) area.setAttribute("d", d + " L" + CHART_W + "," + CHART_H + " L0," + CHART_H + " Z");

    var y = series[series.length - 1];
    if (dot) dot.setAttribute("cy", y.toFixed(2));
    if (pulse) pulse.setAttribute("cy", y.toFixed(2));

    var change = ((price - open) / open) * 100;
    var positive = change >= 0;
    var colour = positive ? "#22c55e" : "#ef4444";

    if (priceEl) {
      priceEl.textContent = "$" + price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      priceEl.classList.toggle("text-emerald-500", positive);
      priceEl.classList.toggle("text-rose-500", !positive);
    }
    if (changeEl) {
      changeEl.textContent = (positive ? "+" : "") + change.toFixed(2) + "%";
      changeEl.classList.toggle("text-emerald-500", positive);
      changeEl.classList.toggle("text-rose-500", !positive);
    }
    if (badgeEl) {
      badgeEl.textContent = "$" + price.toFixed(2);
      badgeEl.style.color = colour;
    }
    if (line) line.setAttribute("stroke", colour);
    if (dot) dot.setAttribute("fill", colour);
    if (pulse) pulse.setAttribute("fill", colour);
    if (gradTop) gradTop.setAttribute("stop-color", colour);

    pushTrade(positive);
  }

  if (priceEl) setInterval(render, 900);

  /* ---------------- Live trades feed ---------------- */
  var feed = document.getElementById("live-trades");
  var trades = [];

  function pushTrade(won) {
    var stake = [10, 25, 50, 100, 200, 500][Math.floor(Math.random() * 6)];
    var payout = Math.round(stake * (1 + 0.75 + Math.random() * 0.2));
    var name = ["You", "Trader", "Guest"][Math.floor(Math.random() * 3)];
    trades.unshift({ name: name, stake: stake, payout: payout, won: won || Math.random() > 0.35 });
    if (trades.length > 6) trades.pop();
    if (!feed) return;

    feed.innerHTML = trades
      .map(function (t) {
        var colour = t.won ? "#22c55e" : "#ef4444";
        var amount = t.won ? "+$" + (t.payout - t.stake) : "-$" + t.stake;
        return (
          '<div class="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.04]">' +
          '<div class="flex items-center gap-2">' +
          '<div class="w-6 h-6 rounded-md bg-white/[0.06] flex items-center justify-center text-[9px] font-bold text-gray-300">' +
          t.name.slice(0, 2).toUpperCase() +
          "</div>" +
          '<div class="text-[11px] text-gray-400">' +
          t.name +
          ' <span class="text-gray-600">·</span> $' +
          t.stake +
          "</div>" +
          "</div>" +
          '<span class="text-[11px] font-bold tabular-nums" style="color:' +
          colour +
          '">' +
          amount +
          "</span>" +
          "</div>"
        );
      })
      .join("");
  }

  // Seed the panel so it is not empty before the first tick.
  for (var t = 0; t < 4; t++) pushTrade(t % 3 !== 0);
})();
