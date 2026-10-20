/* /register — mirrors the original's validation order and strength meter. */
(function () {
  "use strict";

  var form = document.getElementById("register-form");
  var errorBox = document.getElementById("error");
  var submit = document.getElementById("submit");
  var label = document.getElementById("submit-label");
  var spinner = document.getElementById("submit-spinner");
  var password = document.getElementById("password");
  var confirm = document.getElementById("confirm");
  var bar = document.getElementById("strength-bar");
  var text = document.getElementById("strength-text");

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove("hidden");
  }

  function clearError() {
    errorBox.textContent = "";
    errorBox.classList.add("hidden");
  }

  /* Strength: 4 levels, same thresholds as the original (<6, <10, else). */
  function strength(value) {
    if (value.length === 0) return { level: 0, text: "", colour: "bg-rose-500", textColour: "text-rose-500" };
    if (value.length < 6) return { level: 1, text: "Weak", colour: "bg-rose-500", textColour: "text-rose-500" };
    if (value.length < 10) return { level: 2, text: "Fair", colour: "bg-amber-500", textColour: "text-amber-500" };
    return { level: 3, text: "Strong", colour: "bg-emerald-500", textColour: "text-emerald-500" };
  }

  password.addEventListener("input", function () {
    var s = strength(password.value);
    bar.className = "h-full transition-all " + s.colour;
    bar.style.width = (s.level / 3) * 100 + "%";
    text.textContent = s.text;
    text.className = "text-[10px] font-medium " + s.textColour;
  });

  /* Password reveal toggles */
  document.querySelectorAll("[data-toggle-password]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var input = document.getElementById(btn.getAttribute("data-toggle-password"));
      input.type = input.type === "password" ? "text" : "password";
    });
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    clearError();

    var fullName = document.getElementById("fullName").value.trim();
    var email = document.getElementById("email").value.trim();
    var pass = password.value;
    var passConfirm = confirm.value;

    if (!fullName) return showError("Please enter your full name");
    if (!email) return showError("Please enter your email address");
    if (pass !== passConfirm) return showError("Passwords do not match");
    if (pass.length < 6) return showError("Password must be at least 6 characters");
    if (!document.getElementById("terms").checked) return showError("Please accept the Terms and Privacy Policy");

    submit.disabled = true;
    label.classList.add("hidden");
    spinner.classList.remove("hidden");

    StrategyOption.api
      .register(fullName, pass, email)
      .then(function () {
        StrategyOption.toast("Account created — welcome to StrategyOption", "success");
        setTimeout(function () { location.href = "trade.html"; }, 500);
      })
      .catch(function (err) {
        showError(err.message);
      })
      .finally(function () {
        submit.disabled = false;
        label.classList.remove("hidden");
        spinner.classList.add("hidden");
      });
  });
})();
