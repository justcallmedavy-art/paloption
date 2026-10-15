/* /login — credentials step, demo login, and the 6-digit 2FA step. */
(function () {
  "use strict";

  var credsStep = document.getElementById("step-credentials");
  var twofaStep = document.getElementById("step-2fa");
  var errorBox = document.getElementById("error");
  var error2fa = document.getElementById("error-2fa");
  var submit = document.getElementById("submit");
  var label = document.getElementById("submit-label");
  var spinner = document.getElementById("submit-spinner");
  var verify = document.getElementById("verify");
  var verifyLabel = document.getElementById("verify-label");
  var verifySpinner = document.getElementById("verify-spinner");
  var inputsWrap = document.getElementById("code-inputs");

  var next = new URLSearchParams(location.search).get("next") || "trade.html";
  var digits = ["", "", "", "", "", ""];
  var boxes = [];
  var tempToken = null;

  function showError(el, message) {
    el.textContent = message;
    el.classList.remove("hidden");
  }
  function clearError(el) {
    el.textContent = "";
    el.classList.add("hidden");
  }
  function busy(button, text, spin, on) {
    button.disabled = on;
    text.classList.toggle("hidden", on);
    spin.classList.toggle("hidden", !on);
  }

  document.querySelectorAll("[data-toggle-password]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var input = document.getElementById(btn.getAttribute("data-toggle-password"));
      input.type = input.type === "password" ? "text" : "password";
    });
  });

  /* ---------------- credentials ---------------- */
  document.getElementById("login-form").addEventListener("submit", function (event) {
    event.preventDefault();
    clearError(errorBox);
    var email = document.getElementById("email").value.trim();
    var password = document.getElementById("password").value;
    if (!email || !password) return showError(errorBox, "Please enter your email and password");

    busy(submit, label, spinner, true);
    PalOption.api
      .login(email, password)
      .then(function (result) {
        if (result.requires2FA) {
          tempToken = result.tempToken;
          credsStep.classList.add("hidden");
          twofaStep.classList.remove("hidden");
          // This build has no authenticator: surface the code so the step is testable.
          PalOption.toast("Demo verification code: " + result.demoCode, "success");
          boxes[0] && boxes[0].focus();
          return;
        }
        PalOption.toast("Welcome back, " + result.user.username, "success");
        setTimeout(function () { location.href = next; }, 400);
      })
      .catch(function (err) { showError(errorBox, err.message); })
      .finally(function () { busy(submit, label, spinner, false); });
  });

  /* ---------------- demo account ---------------- */
  document.getElementById("demo-login").addEventListener("click", function () {
    clearError(errorBox);
    PalOption.api.demo().then(function (result) {
      PalOption.toast("Demo account ready — $10,000 virtual balance", "success");
      setTimeout(function () { location.href = next; }, 400);
    }).catch(function (err) { showError(errorBox, err.message); });
  });

  /* ---------------- 2FA inputs ---------------- */
  for (var i = 0; i < 6; i++) {
    (function (index) {
      var input = document.createElement("input");
      input.type = "text";
      input.inputMode = "numeric";
      input.maxLength = 1;
      input.autocomplete = index === 0 ? "one-time-code" : "off";
      input.className =
        "w-11 h-13 sm:w-12 sm:h-14 bg-field border border-line rounded-xl text-center text-xl font-bold text-primary focus:outline-none focus:ring-2 focus:ring-[#FF4D2E]/40 transition";
      input.addEventListener("input", function () {
        digits[index] = this.value.replace(/\D/g, "").slice(0, 1);
        this.value = digits[index];
        if (digits[index] && index < 5) boxes[index + 1].focus();
      });
      input.addEventListener("keydown", function (event) {
        if (event.key === "Backspace" && !this.value && index > 0) {
          boxes[index - 1].focus();
          event.preventDefault();
        }
      });
      input.addEventListener("paste", function (event) {
        event.preventDefault();
        var text = (event.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
        if (text.length === 6) {
          digits = text.split("");
          boxes.forEach(function (b, n) { b.value = digits[n]; });
          boxes[5].focus();
        }
      });
      boxes.push(input);
      inputsWrap.appendChild(input);
    })(i);
  }

  document.getElementById("twofa-form").addEventListener("submit", function (event) {
    event.preventDefault();
    clearError(error2fa);
    var code = digits.join("");
    if (code.length !== 6) return showError(error2fa, "Please enter all 6 digits");

    busy(verify, verifyLabel, verifySpinner, true);
    PalOption.api
      .verify2FA(tempToken, code)
      .then(function () {
        PalOption.toast("Verified — signing you in", "success");
        setTimeout(function () { location.href = next; }, 400);
      })
      .catch(function (err) {
        showError(error2fa, err.message);
        digits = ["", "", "", "", "", ""];
        boxes.forEach(function (b) { b.value = ""; });
        boxes[0].focus();
      })
      .finally(function () { busy(verify, verifyLabel, verifySpinner, false); });
  });
})();
