/* StrategyOption deposit page.

   The clone has no server, so a deposit here credits the account in this
   browser and records a transaction. The copy says so: nothing claims to be a
   real payment, and the M-Pesa option is labelled simulated. */
(function () {
  "use strict";

  var S = window.StrategyOption;
  if (!S) return;
  if (!S.requireAuth()) return;

  var method = "Demo credit";
  var busy = false;

  var els = {
    amount: document.getElementById("amount"),
    deposit: document.getElementById("deposit"),
    warning: document.getElementById("warning"),
    status: document.getElementById("status"),
    transactions: document.getElementById("transactions"),
  };

  function me() { return S.currentUser(); }
  function amount() { return Number(els.amount.value); }

  function refreshBalance() {
    document.querySelectorAll("[data-balance]").forEach(function (el) {
      el.textContent = S.money(S.balance());
    });
    document.querySelectorAll("[data-context]").forEach(function (el) {
      el.textContent = S.mode() === "real" ? "Real Account" : "Demo Account";
    });
  }

  function renderTransactions() {
    var u = me();
    var list = S.db.transactions.filter(function (t) { return t.userId === u.id; })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });
    els.transactions.textContent = "";
    if (!list.length) {
      var empty = document.createElement("p");
      empty.className = "text-xs text-subtle";
      empty.textContent = "Nothing yet.";
      els.transactions.appendChild(empty);
      return;
    }
    list.forEach(function (t) {
      var credit = t.amount >= 0;
      var row = document.createElement("div");
      row.className = "flex items-center justify-between gap-3 py-2.5 border-b border-white/[0.04] text-xs";
      var left = document.createElement("div");
      left.className = "min-w-0";
      var title = document.createElement("div");
      title.className = "font-semibold text-primary capitalize";
      title.textContent = t.type + " · " + (t.method || "");
      var meta = document.createElement("div");
      meta.className = "text-[10px] text-subtle";
      meta.textContent = S.timeAgo(t.createdAt) + " · " + (t.mode || "demo") + " · " + (t.status || "completed");
      left.appendChild(title);
      left.appendChild(meta);
      var value = document.createElement("div");
      value.className = "font-semibold tabular-nums shrink-0";
      value.textContent = (credit ? "+" : "\u2212") + S.money(Math.abs(t.amount)).slice(1);
      value.style.color = credit ? "#22c55e" : "#f43f5e";
      row.appendChild(left);
      row.appendChild(value);
      els.transactions.appendChild(row);
    });
  }

  document.querySelectorAll("[data-method]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      method = btn.getAttribute("data-method");
      document.querySelectorAll("[data-method]").forEach(function (b) {
        var active = b === btn;
        b.classList.toggle("border-[#FF4D2E]", active);
        b.classList.toggle("bg-[#FF4D2E]", active);
        b.classList.toggle("text-white", active);
        b.classList.toggle("border-line", !active);
        b.classList.toggle("bg-field", !active);
        b.classList.toggle("text-muted", !active);
      });
    });
  });

  document.querySelectorAll("[data-amount]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      els.amount.value = btn.getAttribute("data-amount");
      els.warning.classList.add("hidden");
    });
  });

  els.amount.addEventListener("input", function () {
    els.warning.classList.toggle("hidden", !(amount() > 0 && amount() < 1));
  });

  els.deposit.addEventListener("click", function () {
    if (busy) return;
    var value = amount();
    if (!isFinite(value) || value < 1) {
      els.warning.classList.remove("hidden");
      return;
    }
    els.warning.classList.add("hidden");
    busy = true;
    els.deposit.disabled = true;
    els.deposit.style.opacity = "0.6";
    els.status.textContent = method.indexOf("M-Pesa") === 0
      ? "Waiting for the simulated STK push…"
      : "Crediting your account…";

    var wait = method.indexOf("M-Pesa") === 0 ? 1200 : 350;
    setTimeout(function () {
      var u = me();
      var now = Date.now();
      S.db.transactions.push({
        id: "t_" + now.toString(36),
        userId: u.id,
        type: "deposit",
        amount: value,
        mode: S.mode(),
        method: method,
        status: "completed",
        createdAt: now,
      });
      S.adjustBalance(value);
      S.save();
      refreshBalance();
      renderTransactions();
      els.status.textContent = "Deposited " + S.money(value) + " to the " + S.mode() + " account.";
      S.toast("Deposited " + S.money(value), "success");
      busy = false;
      els.deposit.disabled = false;
      els.deposit.style.opacity = "1";
    }, wait);
  });

  refreshBalance();
  renderTransactions();
})();
