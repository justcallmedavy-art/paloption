/**
 * Serve-time transforms for the mirrored client bundle.
 *
 * The mirrored app is compiled, minified Next.js output that we do not own.
 * Two kinds of change happen here, both at the point we serve the bytes rather
 * than by editing `site/` on disk, so that `npm run mirror` stays re-runnable
 * and the mirrored artifact stays a faithful copy of what the site actually
 * ships:
 *
 *   1. The brand re-colour (see palette.mjs). The upstream palette is violet +
 *      pink; we serve it as ember + blue. Because it is applied on the way out,
 *      a fresh `npm run mirror` that restores the original violet is recoloured
 *      again automatically — the fork survives a re-mirror.
 *   2. Three defects in the deposit flow, described below.
 *   3. The trade panel starting a martingale bot on the first Even/Odd click,
 *      described below.
 *
 * Set PATCH_CLIENT=0 to serve the bundle untouched (used to A/B a fix).
 * Set RECOLOR=0 to serve the original violet/pink palette.
 *
 * Every edit is anchored on an exact string and self-validating: if an anchor
 * stops matching — because the upstream bundle changed — the edit is skipped and
 * reported, never guessed at. A skipped edit degrades to the original
 * behaviour; it cannot corrupt the chunk.
 */
import { recolor, RECOLORABLE_EXTS } from "./palette.mjs";

/* ------------------------------------------------------------------ *
 * 1. TRC20 request storm
 *
 * Cause, read straight out of the chunk: each address effect is
 *
 *   useEffect(() => {
 *     "trc20" !== method || address || loading || (async () => {
 *       setLoading(true);
 *       try { ... fetch my-address ... } finally { setLoading(false); }
 *     })();
 *   }, [method, address, loading]);
 *
 * The loading flag is both the re-entrancy guard *and* a dependency. When the
 * request does not yield an address — a provider error, a 429, a network blip —
 * `address` stays "" and `loading` flipping true -> false changes a dependency,
 * so the effect re-runs and fires again. It never terminates: we measured 50+
 * requests in 12 seconds from a single modal open.
 *
 * Fix: drop the loading flag from the dependency array. The effect then runs
 * once per mount and once per method change, the `address` guard still prevents
 * a re-fetch once an address exists, and a failure no longer self-triggers.
 * ------------------------------------------------------------------ */
const TRC20_MARKER = "/api/auth/trc20/my-address";

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fixTrc20Dependencies(source) {
  const applied = [];
  const skipped = [];
  let out = source;
  let index = -1;

  while ((index = out.indexOf(TRC20_MARKER, index + 1)) !== -1) {
    const depStart = out.indexOf("},[", index);
    if (depStart === -1) break;
    const depEnd = out.indexOf("]", depStart);

    const deps = out.slice(depStart + 3, depEnd).split(",").map((d) => d.trim());
    const effectBody = out.slice(index, depStart);

    // The effect body reads the loading *value* (`... || loading || ...`), sets
    // it true when the fetch starts and clears it in `finally`. The dependency
    // array holds the value, not its setter, so pair the two through the
    // component's own `useState` declaration before trusting the anchor.
    const last = deps[deps.length - 1];
    const cleared = (effectBody.match(/finally\{(\w+)\(!1\)/) || [])[1];
    const leading = out.slice(Math.max(0, index - 300), index);
    const sets = [...leading.matchAll(/([A-Za-z_$][\w$]*)\(!0\)/g)];
    const set = sets.length ? sets[sets.length - 1][1] : null;
    const declared = (out.match(new RegExp(`\\[${escapeRegExp(last)},(\\w+)\\]=\\(0,\\w\\.useState\\)\\(!1\\)`)) || [])[1];
    // The guard (`... || method !== "trc20" || address || loading || ...`) sits
    // before the fetch, so it is in the leading text, not the effect body.
    const guarded = new RegExp(`\\|\\|${escapeRegExp(last)}\\|\\|`).test(leading);

    if (!guarded || !declared || declared !== set || declared !== cleared) {
      skipped.push(
        `trc20 effect at ${index}: expected the last dependency ${last} to be a loading flag ` +
          `(guarded=${guarded}, useState=${declared}, set=${set}, cleared=${cleared}) of [${deps.join(", ")}]`
      );
      continue;
    }

    out = `${out.slice(0, depStart + 3)}${deps.slice(0, -1).join(",")}${out.slice(depEnd)}`;
    applied.push(`trc20 effect at ${index}: dependencies [${deps.join(", ")}] -> [${deps.slice(0, -1).join(", ")}]`);
  }

  return { source: out, applied, skipped };
}

/* ------------------------------------------------------------------ *
 * 2. The exchange-rate fallback is invisible
 *
 * Each rate effect is `if (e.ok) { ... setRate(t.rate) }` inside a try/catch,
 * and the rate state is initialised to a hardcoded 130. A non-OK response
 * therefore takes no branch at all: the modal quietly keeps rendering
 * "≈ KES 1,300" from that literal, with no indication the conversion is stale.
 * (This is what was hiding the 401 we were returning — see PAYMENTS.md.)
 *
 * Fix: add the missing `else`, which surfaces the state in the modal's existing
 * error banner. The numeric default stays as a last resort, but it is no longer
 * silent. `errorSetter` is the identifier that component uses for its banner;
 * if a bundle changes those symbols we skip rather than break the modal (a
 * wrong identifier throws inside the enclosing try, i.e. today's behaviour).
 * ------------------------------------------------------------------ */
const RATE_FALLBACK_TEXT =
  "Live USD/KES rate is unavailable, so the KES estimate shown is not live.";

const RATE_EDITS = [
  { chunk: "219b97e8e5e970d5.js", rateSetter: "T", errorSetter: "A" },
  { chunk: "219b97e8e5e970d5.js", rateSetter: "k", errorSetter: "j" },
  { chunk: "219b97e8e5e970d5.js", rateSetter: "K", errorSetter: "C" },
  { chunk: "31fae89f7d7805b5.js", rateSetter: "eo", errorSetter: "V" },
];

/* ------------------------------------------------------------------ *
 * 3. The address error discards the API's message
 *
 * `else setError({type:"error", text:"Failed to load deposit address"})` throws
 * away the body of the failed response, so a configuration error reads the same
 * as a network blip. Fix: prefer the API's own `error` message.
 * ------------------------------------------------------------------ */
const ADDRESS_ERROR_EDITS = [
  { chunk: "219b97e8e5e970d5.js", setter: "A" },
  { chunk: "219b97e8e5e970d5.js", setter: "C" },
];

/**
 * The mobile TRC20 panel is worse than the desktop one: it has no error branch
 * at all, so `if (ok) {...}` with an empty `catch {}` means a failed address
 * request leaves its spinner turning forever with no explanation. Add the
 * missing branch.
 *
 * (A third TRC20 site in 219b is left alone: its component has no error state
 * to write to — the nearest banner belongs to a component 75kB away — so
 * manufacturing one would mean rewriting that component. Reported as a gap.)
 */
const ADDRESS_MISSING_BRANCH_EDITS = [
  { chunk: "31fae89f7d7805b5.js", addressSetter: "eg", loadingSetter: "ew", bannerSetter: "V" },
];

const ADDRESS_ERROR_TEXT = "Failed to load deposit address";

function applyBannerEdits(source, filename) {
  const applied = [];
  const skipped = [];

  for (const { chunk, rateSetter, errorSetter } of RATE_EDITS) {
    if (chunk !== filename) continue;
    const find = `if(e.ok){let t=await e.json();${rateSetter}(t.rate)}`;
    if (!source.includes(find)) {
      skipped.push(`rate fallback (${rateSetter}): anchor not found`);
      continue;
    }
    const replace = `${find}else{${errorSetter}({type:"error",text:${JSON.stringify(RATE_FALLBACK_TEXT)}})}`;
    source = source.replace(find, replace);
    applied.push(`rate fallback (${rateSetter} -> banner ${errorSetter})`);
  }

  for (const { chunk, setter } of ADDRESS_ERROR_EDITS) {
    if (chunk !== filename) continue;
    const find = `else ${setter}({type:"error",text:"${ADDRESS_ERROR_TEXT}"})`;
    if (!source.includes(find)) {
      skipped.push(`address error (${setter}): anchor not found`);
      continue;
    }
    const replace =
      `else{let _body=null;try{_body=await t.json()}catch{}` +
      `${setter}({type:"error",text:(_body&&_body.error)||"${ADDRESS_ERROR_TEXT}"})}`;
    source = source.replace(find, replace);
    applied.push(`address error (${setter}): surfaces the API message`);
  }

  for (const { chunk, addressSetter, loadingSetter, bannerSetter } of ADDRESS_MISSING_BRANCH_EDITS) {
    if (chunk !== filename) continue;
    const ok = `if(t.ok){let e=await t.json();e?.address&&${addressSetter}(e.address)}`;
    const find = `${ok}}catch{}finally{${loadingSetter}(!1)}`;
    if (!source.includes(find)) {
      skipped.push(`address sync (${addressSetter}): anchor not found`);
      continue;
    }
    // Note the brace budget: `ok` already closes the `if`, the brace after the
    // else-block closes the enclosing `try`, and `catch{}finally{}` follows. One
    // brace too many here closes the try early and the file no longer parses.
    const replace =
      `${ok}else{let _body=null;try{_body=await t.json()}catch{}` +
      `${bannerSetter}({type:"error",text:(_body&&_body.error)||"${ADDRESS_ERROR_TEXT}"})}` +
      `}catch{}finally{${loadingSetter}(!1)}`;
    source = source.replace(find, replace);
    applied.push(`address sync (${bannerSetter}): failed lookups now report instead of spinning`);
  }

  return { source, applied, skipped };
}

/* ------------------------------------------------------------------ *
 * 4. The Even/Odd buttons started a bot instead of placing one trade
 *
 * The trade panel has two modes, and the Even/Odd buttons do something
 * different in each. In `auto` a click posts `auto_trading_start`, so the server
 * runs a martingale bot on the position: measured on this build, a single click
 * opened ten settled trades and doubled the stake 10 -> 20 -> 40 -> 80. In
 * `manual` the same click posts `manual_trade` and exactly one position opens.
 * The panel is initialised to `auto`:
 *
 *   [D,A]=(0,s.useState)("auto")      // desktop panel (eL)
 *   [eu,eh]=(0,s.useState)("auto")    // mobile panel (e5)
 *
 * Nothing on screen says the first click is a bot start. The buttons are
 * labelled with a payout — "Even 95.2% $19.52 Payout" — which reads as a single
 * bet, and the mode toggle sits above them unselected by the reader. So the
 * button traded on its own: the bot kept opening positions after the click,
 * unseen, until STOP, the MANUAL toggle or a target stopped it.
 *
 * Fix: initialise the mode to `manual`. One click then places one trade, and the
 * bot runs only after the user has deliberately chosen AUTO. Nothing else
 * changes: the toggle, the STOP state, the martingale engine and both modes stay
 * exactly as they are, so AUTO is still one click away.
 *
 * The anchor is a pattern, not a literal, because the minifier renames these
 * identifiers on every build. Each candidate must look like a trade panel — the
 * enclosing component destructures the trading hook, and the same state is
 * compared against both mode strings — otherwise it is left alone and reported.
 * ------------------------------------------------------------------ */
const TRADE_MODE_STATE =
  /\[([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\]=\(0,([A-Za-z_$][\w$]*)\.useState\)\("auto"\)/g;

function fixTradeModeDefault(source) {
  const applied = [];
  const skipped = [];
  let count = 0;

  const out = source.replace(TRADE_MODE_STATE, (match, state, setter, react, offset) => {
    // The hook destructure sits immediately above the state block ("…placeManualTrade:y}=eA(),[j,v]=…"),
    // so a window in front of the match identifies the component.
    const component = source.slice(Math.max(0, offset - 800), offset);
    const isTradePanel =
      component.includes("startAutoTrading") && component.includes("placeManualTrade");
    // The same state must be the one the direction handler switches on; a chunk
    // that renamed it or reused "auto" for something else is skipped.
    const isMode =
      source.includes(`"auto"===${state}`) && source.includes(`"manual"===${state}`);

    if (!isTradePanel || !isMode) {
      skipped.push(
        `trade mode at ${offset}: expected a trade panel state (hook=${isTradePanel}, ` +
          `compared against both modes=${isMode}) for "${state}"`
      );
      return match;
    }

    applied.push(
      `trade mode ${state}: default "auto" -> "manual" (the bot now needs an explicit AUTO)`
    );
    return `[${state},${setter}]=(0,${react}.useState)("manual")`;
  });

  count = applied.length;
  return { source: out, applied, skipped, count };
}

/* ------------------------------------------------------------------ *
 * 6. Signing out, and getting back in
 *
 * Sign-out in this client is entirely local: the auth provider removes the
 * `token` key and clears its own state, and no request is made. Nothing about
 * the account is touched — which is correct, and is also why a sign-out can
 * never be the reason a later sign-in fails.
 *
 * What made it LOOK otherwise is the error the sign-in page shows when the API
 * host is unreachable. `fetch` rejects with the browser's own words, and the
 * page prints them verbatim:
 *
 *   catch(e){setError(e.message||"Login failed")}   ->  "Failed to fetch"
 *
 * Measured on 2026-10-18: the deployed frontend was pointed at a temporary
 * tunnel that had since died, so every sign-in attempt after a sign-out showed
 * "Failed to fetch" — indistinguishable, to the person reading it, from a wrong
 * password or a deleted account. The accounts were in fact all still there.
 *
 * Two edits, both in the sign-in page:
 *
 *   - an unreachable API is reported as unreachable, and says explicitly that
 *     nobody's credentials were checked and nothing was changed. The server's
 *     own message ("Invalid email or password") is still shown verbatim, since
 *     that is a different, real answer;
 *   - the address that was used is remembered in localStorage and pre-filled
 *     next time, so a sign-out never leaves the visitor guessing which address
 *     they registered with.
 * ------------------------------------------------------------------ */

const LAST_EMAIL_KEY = "strategyoption:last-email";

/** The banner text for a fetch that never reached a server. */
export const UNREACHABLE_SIGN_IN_MESSAGE =
  "Can't reach the StrategyOption server, so this sign-in was not checked and nothing was changed. " +
  "Your account and balance are safe. Try again in a moment.";

/** Chunks the mirror carries the sign-in page in, so a lost anchor is loud. */
export const SIGN_IN_CHUNKS = new Set(["5595d28ad44d9db8.js"]);

/**
 * The sign-in component's first three state hooks — email, password, then the
 * password's visibility flag — of which only the EMAIL declaration is matched.
 *
 * The other two are a lookahead, deliberately. Matching all three and rewriting
 * them replaced the password state with the email state: `[b,v]=useState("")`
 * and `[w,j]=useState(!1)` disappeared, the password input rendered `value:b`
 * against an identifier that no longer existed, and the page died with
 * `ReferenceError: w is not defined` before anything could be typed. The
 * lookahead makes the two following declarations a CONDITION for the edit
 * rather than part of its replacement.
 */
const SIGN_IN_STATE =
  /\[(\w+),(\w+)\]=\(0,(\w+)\.useState\)\(""\)(?=,\[\w+,\w+\]=\(0,\3\.useState\)\(""\),\[\w+,\w+\]=\(0,\3\.useState\)\(!1\))/;

/** `let t=await A(email,password);if(t.requires2FA&&t.tempToken)` */
const SIGN_IN_SUBMIT = /try\{let (\w+)=await (\w+)\((\w+),(\w+)\);if\(\1\.requires2FA&&\1\.tempToken\)/;

/** `catch(e){setError(e.message||"Login failed")}` */
const SIGN_IN_CATCH = /catch\((\w+)\)\{(\w+)\((\1\.message\|\|"Login failed")\)\}/;

export function patchSignInRecovery(source, filename = "") {
  const applied = [];
  const skipped = [];

  // Only the page that really has the sign-in form is touched: it must carry the
  // 2FA help text and the login submit idiom, not merely three state hooks.
  const looksLikeSignIn =
    source.includes("access your authenticator") && SIGN_IN_SUBMIT.test(source);
  if (!looksLikeSignIn) {
    if (SIGN_IN_CHUNKS.has(filename)) {
      skipped.push(
        `${filename}: carries the sign-in page in the mirror, but it no longer looks like it (form or submit anchor changed)`
      );
    }
    return { source, applied, skipped, count: 0 };
  }

  let out = source;

  const catchMatch = SIGN_IN_CATCH.exec(out);
  if (catchMatch) {
    const [whole, err, setter, original] = catchMatch;
    // The server's own words survive; only the browser's untranslated network
    // complaint is replaced.
    const replacement =
      `catch(${err}){var _m=(${err}&&${err}.message)||"";` +
      `${setter}(/failed to fetch|networkerror|load failed|network request failed|fetch failed|err_connection/i.test(_m)` +
      `?${JSON.stringify(UNREACHABLE_SIGN_IN_MESSAGE)}:(${err}&&${err}.message)||"Login failed")}`;
    out = out.replace(whole, replacement);
    applied.push(`sign-in: an unreachable API reports itself instead of "${original}"`);
  } else {
    skipped.push("sign-in: the error handler anchor was not found");
  }

  const stateMatch = SIGN_IN_STATE.exec(out);
  if (stateMatch) {
    const [whole, email, emailSet] = stateMatch;
    // Re-entering the address is the one thing a sign-out should not cost.
    const prefilled =
      `[${email},${emailSet}]=(0,${stateMatch[3]}.useState)((function(){try{return localStorage.getItem(${JSON.stringify(
        LAST_EMAIL_KEY
      )})||""}catch(_){return ""}})())`;
    out = out.replace(whole, prefilled);
    applied.push("sign-in: the last address used is pre-filled");
  } else {
    skipped.push("sign-in: the email field's state anchor was not found");
  }

  const submitMatch = SIGN_IN_SUBMIT.exec(out);
  if (submitMatch) {
    const [whole, result, loginFn, email] = submitMatch;
    const replacement = `try{let ${result}=await ${loginFn}(${email},${submitMatch[4]});try{localStorage.setItem(${JSON.stringify(
      LAST_EMAIL_KEY
    )},${email})}catch(_){}if(${result}.requires2FA&&${result}.tempToken)`;
    out = out.replace(whole, replacement);
    applied.push("sign-in: a successful sign-in remembers the address");
  } else {
    skipped.push("sign-in: the submit anchor was not found");
  }

  return { source: out, applied, skipped, count: applied.length };
}

/** Chunk files this module knows how to fix. */
export const PATCHABLE_CHUNKS = new Set([
  "219b97e8e5e970d5.js",
  "31fae89f7d7805b5.js",
  "5595d28ad44d9db8.js",
]);

export function isPatchableChunk(filename) {
  return process.env.PATCH_CLIENT !== "0" && PATCHABLE_CHUNKS.has(filename);
}

/**
 * Whether a served file should be run through the brand re-colour. Independent
 * of PATCH_CLIENT: that flag means "do not alter the bundle's behaviour", and
 * the palette swap changes no behaviour, so `PATCH_CLIENT=0` alone keeps the
 * new colours. Use `RECOLOR=0` for an untouched violet/pink copy.
 */
export function isRecolorable(extension) {
  return process.env.RECOLOR !== "0" && RECOLORABLE_EXTS.has(extension);
}

/** Raster brand marks, handled by icon-recolor.mjs rather than the text pass. */
export const RECOLORABLE_IMAGE_EXTS = new Set([".png", ".ico"]);

export function isRecolorableImage(extension) {
  return process.env.RECOLOR !== "0" && RECOLORABLE_IMAGE_EXTS.has(extension);
}

export function patchClientChunk(filename, source) {
  let result = fixTrc20Dependencies(source);
  const banners = applyBannerEdits(result.source, filename);
  const mode = fixTradeModeDefault(banners.source);
  const socket = patchSocketResilience(mode.source, filename);
  const deposit = patchDepositOutcome(socket.source, filename);
  const signIn = patchSignInRecovery(deposit.source, filename);
  return {
    source: signIn.source,
    applied: [...result.applied, ...banners.applied, ...mode.applied, ...socket.applied, ...deposit.applied, ...signIn.applied],
    skipped: [...result.skipped, ...banners.skipped, ...mode.skipped, ...socket.skipped, ...deposit.skipped, ...signIn.skipped],
  };
}

/** Exported for the tests: the trade-mode pass on its own. */
export { fixTradeModeDefault };

/* ------------------------------------------------------------------ *
 * 3. API and WebSocket base URL
 *
 * The mirrored bundle resolves both from one module — id 74728 — which is
 * inlined into every chunk that talks to the server:
 *
 *   let t="";
 *   e.s(["getApiUrl",0,()=>t,
 *        "getWsUrl",0,()=>{let e=t.replace(/^http/,"ws");return `${e}/ws`}])
 *
 * With `t` empty, every request is same-origin and the socket is `/ws` on the
 * page's own host. That is right for the combined server, which serves the
 * client and the API from one origin, and wrong the moment the frontend is on
 * Vercel and the API is on a host of its own.
 *
 * The replacement keeps same-origin as the default and adds two ways to point
 * it elsewhere, in precedence order:
 *
 *   1. `globalThis.__STRATEGYOPTION_API_URL__`, read at call time, so a page can
 *      override the base without rebuilding anything;
 *   2. the base baked in here, from STRATEGYOPTION_API_URL (VITE_API_URL is accepted
 *      as an alias, since that is the name the deployment asks for).
 *
 * getWsUrl derives the socket from the same base, so an https base becomes wss
 * — and, on an https page, a base that would produce a plain `ws://` to a
 * non-loopback host is upgraded rather than silently sending the token in the
 * clear.
 */

const API_BASE_FROM =
  'let t="";e.s(["getApiUrl",0,()=>t,"getWsUrl",0,()=>{let e=t.replace(/^http/,"ws");return`${e}/ws`}])';

const apiBaseTo = (base) =>
  'let t=' +
  JSON.stringify(base || "") +
  ';let U=()=>globalThis.__STRATEGYOPTION_API_URL__||t;' +
  'e.s(["getApiUrl",0,()=>U(),"getWsUrl",0,()=>{let e=U().replace(/^http/,"ws");' +
  '"https:"===location.protocol&&"ws:"===e.substr(0,3)&&0>e.indexOf("ws://localhost")&&0>e.indexOf("ws://127.0.0.1")&&(e="wss:"+e.substr(3));' +
  'return`${e}/ws`}])';

/**
 * Rewrites the client's URL module. Safe on any chunk: one that does not carry
 * the module is returned untouched and reports zero edits.
 */
export function patchApiBase(source, base) {
  if (!source.includes(API_BASE_FROM)) return { source, count: 0 };
  let count = 0;
  const replaced = source.split(API_BASE_FROM).join(apiBaseTo(base));
  count = source.split(API_BASE_FROM).length - 1;
  return { source: replaced, count };
}

/** The base to bake in, from the environment. Empty means same-origin. */
export function apiBaseFromEnv(env = process.env) {
  return (env.STRATEGYOPTION_API_URL || env.VITE_API_URL || "").trim().replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ *
 * 3b. A visible payment-environment label
 *
 * The wallet cannot tell a sandbox deposit from a real one once it is credited:
 * both are dollars in the same balance. The deposit row now records which
 * environment created it (`deposits.environment`), but a database column is not
 * something a visitor sees. This puts the same fact on every static page, so a
 * deployment that is wired to Safaricom's sandbox says so on screen instead of
 * leaving it to whoever reads the boot log.
 *
 * It is applied at snapshot time, from `STRATEGYOPTION_PAYMENTS_ENV`, and only
 * when that variable names an environment: a build that does not say gets no
 * banner rather than a guessed one. The label is fixed, non-interactive and
 * small, so it cannot be mistaken for part of the cashier.
 */
export const PAYMENTS_ENV_LABEL_ID = "strategyoption-payments-environment";

export function paymentsEnvironmentBanner(environment) {
  const env = String(environment || "").trim().toLowerCase();
  if (env !== "sandbox" && env !== "production") return null;
  const live = env === "production";
  const text = live ? "M-Pesa LIVE — real money" : "M-Pesa sandbox — no real money moves";
  const background = live ? "#b91c1c" : "#7c2d12";
  return (
    `<div id="${PAYMENTS_ENV_LABEL_ID}" role="status" style="` +
    "position:fixed;left:12px;bottom:12px;z-index:2147483647;pointer-events:none;" +
    "font:600 12px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:5px 10px;border-radius:999px;" +
    `background:${background};color:#fff;opacity:.92;box-shadow:0 1px 4px rgba(0,0,0,.35)"` +
    `>${text}</div>`
  );
}

/**
 * Adds the label before `</body>` in a page. Idempotent, and honest about why it
 * did nothing: a caller that named an environment should be able to tell a page
 * that was labelled from one that was skipped.
 */
export function injectPaymentsEnvironmentBanner(html, environment) {
  const banner = paymentsEnvironmentBanner(environment);
  if (!banner) return { html, injected: false, reason: "no payment environment named" };
  if (html.includes(`id="${PAYMENTS_ENV_LABEL_ID}"`)) return { html, injected: false, reason: "already labelled" };
  const at = html.lastIndexOf("</body>");
  if (at === -1) return { html, injected: false, reason: "no </body> to attach the label to" };
  return { html: html.slice(0, at) + banner + html.slice(at), injected: true, reason: null };
}

/* ------------------------------------------------------------------ *
 * 4. An error message that can actually be reached
 *
 * Every failed auth request in the mirror is written like this:
 *
 *   if(!i.ok)throw Error((await i.json()).error||"Registration failed")
 *
 * The fallback after `||` can never run for the one case that matters. When no
 * API is behind the frontend — a static host answering POST /api/auth/register
 * with an HTML 404 — `i.json()` throws BEFORE the `||` is evaluated, so the
 * sentence the author wrote is unreachable and the visitor gets the browser's
 * own parser complaint instead:
 *
 *   Unexpected token 'T', "The page c"... is not valid JSON
 *
 * Nothing in that string is actionable, and it is what a frontend deployed
 * without its backend shows anyone who tries to sign up or sign in. This pass
 * makes the fallback reachable: read the body defensively, keep the server's
 * own `error` field when the body IS JSON, and otherwise report the status
 * rather than the parser's objection.
 *
 * Twelve occurrences across the three auth chunks carry this idiom — login,
 * 2FA verification, demo sign-in and registration.
 */
const AUTH_ERROR_IDIOM = /(\w+)\.ok\)throw Error\(\(await \1\.json\(\)\)\.error\|\|"([^"]*)"\)/g;

/**
 * The replacement keeps the original sentence as the prefix, so a legitimate
 * refusal still reads exactly as before ("Login failed"), and appends the
 * status only when the body could not be read at all.
 */
const authErrorTo = (ident, message) =>
  [
    `${ident}.ok)throw Error(await(async()=>{`,
    `try{let _r=await ${ident}.json();return _r&&_r.error||${JSON.stringify(message)}}`,
    `catch(_e){return ${JSON.stringify(message)}+": the service did not answer (HTTP "+${ident}.status+")."}`,
    `})())`,
  ].join("");

/** Chunks the mirror currently carries this idiom in. */
export const AUTH_ERROR_CHUNKS = new Set([
  "35132007189b6b68.js",
  "373e15cf050e0fc3.js",
  "5856812966db7242.js",
]);

/**
 * Rewrites every unreachable auth error message in a chunk.
 *
 * Safe on any chunk: one without the idiom is returned untouched and reports
 * zero edits — except for the chunks known to carry it, where finding none
 * means the bundle changed shape and is reported rather than passed over
 * silently, because the whole point is that this fix cannot quietly stop
 * applying.
 */
export function fixUnparseableErrorMessages(source, filename = "") {
  const applied = [];
  const skipped = [];
  let count = 0;

  const out = source.replace(AUTH_ERROR_IDIOM, (match, ident, message) => {
    count += 1;
    applied.push(`"${message}": an unparseable body now reports the status instead of the parser`);
    return authErrorTo(ident, message);
  });

  if (!count && AUTH_ERROR_CHUNKS.has(filename)) {
    skipped.push(`${filename}: carries this idiom in the mirror, but none was found in this bundle`);
  }

  return { source: out, applied, skipped, count };
}

/* ------------------------------------------------------------------ *
 * 5. A trading socket that notices it has died
 *
 * The mirror opens one socket and, when it closes, comes back on a fixed
 * three-second timer:
 *
 *   s.onclose=()=>{…,t.current=setTimeout(()=>{b()},3e3)}
 *
 * On a laptop that is adequate. On a host with a cold start it is three
 * problems:
 *
 *   * Three seconds, forever, with no backoff. A sleeping instance, a redeploy
 *     or a host that is simply down produces an attempt every three seconds per
 *     open tab, for as long as the tab lives — and every tab returns in lockstep.
 *   * Nothing notices a dead link. There is no heartbeat anywhere in the bundle,
 *     so a half-open connection — a NAT entry that expired, a proxy that dropped
 *     the flow without a close frame — leaves the UI reporting "connected" over
 *     a price that has stopped moving, and no event fires to correct it.
 *   * Nothing keeps the path warm, and an idle connection through a load
 *     balancer is the first thing reaped silently.
 *
 * So the two handlers that already own this socket gain:
 *
 *   - a heartbeat: {type:"ping"} every 20s, answered by the server with
 *     {type:"pong"} (tools/server.mjs), so the connection is never idle and the
 *     answer is evidence the far end is still there;
 *   - a watchdog: no frame of any kind for 45s means the socket is dead whatever
 *     its readyState claims, so it is closed — which lands in the app's own
 *     onclose, keeps its "Disconnected. Retrying…" UI truthful, and reuses its
 *     reconnect path rather than inventing a second one;
 *   - backoff with jitter: 1s, 2s, 4s, 8s, 16s, then 30s, each plus up to a
 *     second of jitter. The counter resets on any frame actually received,
 *     which is the only evidence that a connection works — so a host that
 *     accepts a connection and then dies without a frame is backed off rather
 *     than hammered.
 *
 * The server also pings at the protocol level, so a client built before this
 * patch is still kept warm and still reaped when it dies.
 */

/**
 * How long to wait before the next reconnect, after `attempt` consecutive
 * failures. Exported because the tests check this arithmetic directly, and
 * injected into the browser through its own source text by the patch below, so
 * the function under test and the function that runs cannot drift apart.
 */
export function wsRetryDelay(attempt, random = Math.random) {
  const capped = Math.min(Math.max(1, Math.floor(attempt) || 1), 6);
  const backoff = Math.min(30_000, 1_000 * 2 ** (capped - 1));
  return backoff + Math.floor(random() * 1_000);
}

/** The injected copy of `wsRetryDelay`, defined once per page. */
const RETRY_DELAY_SRC =
  `(globalThis.__strategyOptionRetryDelay||(globalThis.__strategyOptionRetryDelay=${wsRetryDelay.toString()}))`;

/**
 * The heartbeat and its watchdog. Written against the chunk's own socket
 * variable `s`, and deliberately defensive: a socket that throws while being
 * pinged must not take the app down, so every step is inside one try/catch.
 */
const HEARTBEAT_SRC =
  'globalThis.__strategyOptionWsSeen=Date.now(),' +
  's.__strategyOptionBeat=setInterval(()=>{try{' +
  'if(Date.now()-(globalThis.__strategyOptionWsSeen||0)>45e3){s.close();return}' +
  's.readyState===WebSocket.OPEN&&s.send(JSON.stringify({type:"ping"}))' +
  '}catch(_){}},2e4)';

/** The retry, after counting one more failure. */
const RETRY_DELAY_CALL =
  '(globalThis.__strategyOptionWsAttempt=(globalThis.__strategyOptionWsAttempt||0)+1,' +
  `${RETRY_DELAY_SRC}(globalThis.__strategyOptionWsAttempt))`;

/**
 * The three edits, each anchored on a string that occurs exactly once in the
 * trading chunk. `note` is what gets reported when an anchor is applied, or
 * when it stops matching — never silently.
 */
const SOCKET_EDITS = [
  {
    from: 'l.current=!0,n.current=!1;let e=localStorage.getItem("token");',
    to: `l.current=!0,n.current=!1,${HEARTBEAT_SRC};let e=localStorage.getItem("token");`,
    note: "trading socket: a heartbeat every 20s and a 45s watchdog on open",
  },
  {
    from: 's.onmessage=e=>{try{let t=JSON.parse(e.data);',
    to: 's.onmessage=e=>{globalThis.__strategyOptionWsSeen=Date.now(),globalThis.__strategyOptionWsAttempt=0;try{let t=JSON.parse(e.data);',
    note: "trading socket: an inbound frame records liveness and clears the backoff",
  },
  {
    from: 't.current=setTimeout(()=>{b()},3e3)',
    to: `s.__strategyOptionBeat&&clearInterval(s.__strategyOptionBeat),t.current=setTimeout(()=>{b()},${RETRY_DELAY_CALL})`,
    note: "trading socket: the fixed 3s retry becomes exponential backoff with jitter",
  },
];

/** Chunks the mirror carries the trading socket in, so a lost anchor is loud. */
export const SOCKET_CHUNKS = new Set(["219b97e8e5e970d5.js"]);

/* ------------------------------------------------------------------ *
 * 6. What happened to the deposit
 *
 * The M-Pesa handler opens a "Processing Payment" screen and never asks again:
 *
 *   if(s.ok) z(!0), c("");
 *
 * `z` shows the spinner, `c` clears the error box, and the response body — which
 * carries the deposit's reference — is thrown away. Nothing polls for the
 * outcome and the socket carries no deposit message, so the spinner spins until
 * the visitor closes it. For a deposit that SUCCEEDS the credit arrives through
 * the balance update, but one that FAILS leaves the visitor looking at
 * "Check your phone and enter M-Pesa PIN" forever, with no indication that the
 * prompt was cancelled and no money moved.
 *
 * Measured against the live sandbox on 2026-10-17: three real pushes, all
 * accepted, callbacks at t+6s to t+26s with result 1032/1037, deposit rows
 * correctly `failed` and the ledger untouched — and the browser still on the
 * spinner minutes later.
 *
 * The replacement keeps the deposit's reference from the response and polls the
 * deposit-status route the server already exposes, then reports the outcome in a
 * toast over the page. It reads the API's own `failure_reason`, never invents
 * one, and stops at a terminal status. If the poll gives up it says so rather
 * than pretending the payment is still in flight — and it moves no money in any
 * direction: crediting stays where it belongs, in `settleDeposit`.
 */
const DEPOSIT_PUSH_ANCHOR = 'if(s.ok)z(!0),c("");';

/*
 * The outcome is reported in a toast appended to `document.body` rather than by
 * rewriting the processing screen's own text.
 *
 * That is not a style choice. The first version of this patch set the text of
 * the "Processing Payment" heading and its paragraphs, and measured in the
 * browser it did not survive: the page re-renders about once a second (the
 * socket pushes a new price and balance), React reconciles that subtree against
 * its own virtual DOM, and the spinner's original text came straight back — the
 * poll had run, the deposit was `failed`, and the screen still said "Check your
 * phone and enter M-Pesa PIN". A node React does not own is not reconciled away.
 */
const DEPOSIT_POLL_SRC =
  "(function(){var _ref=_d.deposit&&_d.deposit.reference;if(!_ref)return;" +
  "var _id=\"strategyoption-deposit-outcome\";var _n=0;" +
  'function _show(_dep,_giveUp){try{if(document.getElementById(_id))return;' +
  'var _ok=_dep.status==="completed";var _sandbox=_dep.environment==="sandbox";' +
  // A prompt the customer cancelled is not a failure. It is what happens when
  // somebody opens the prompt and declines it, or lets it lapse in the sandbox,
  // and it is the ordinary outcome of a test against a number the sandbox
  // simulator cannot reach. Reporting it in the same red banner as a real
  // failure — with the provider's sentence, a hint, the sandbox note and a
  // reference — is noise on every single attempt, which is what was reported on
  // 2026-10-18. It gets one calm line, no button, and it leaves on its own.
  'var _cancelled=!_ok&&!_giveUp&&Number(_dep.mpesa_result_code)===1032;' +
  'var _title=_giveUp?"M-Pesa deposit still pending":(_ok?"M-Pesa deposit confirmed":(_cancelled?"M-Pesa deposit cancelled":"M-Pesa deposit failed"));' +
  'var _body=_giveUp?"No result arrived within six minutes. Open Transactions for the final status; nothing was credited unless it appears there."' +
  ':(_cancelled?"You cancelled the prompt, so nothing was charged."' +
  ':((_dep.failure_reason||"The payment was not completed.")+" No money was taken from your account."'+ 
  // The provider's own sentence stays first; the hint is what to do next, and
  // is absent whenever the server has none for that result code.
  '+(_dep.failure_hint?(" "+_dep.failure_hint):"")));' +
  'var _box=document.createElement("div");_box.id=_id;_box.setAttribute("role","status");' +
  '_box.setAttribute("data-deposit-reference",_ref);_box.setAttribute("data-deposit-status",_dep.status);' +
  '_box.setAttribute("data-deposit-cancelled",_cancelled?"1":"0");' +
  '_box.style.cssText="position:fixed;left:50%;transform:translateX(-50%);bottom:54px;z-index:2147483646;"+' +
  '"max-width:min(92vw,420px);font:500 13px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;padding:12px 14px;"+' +
  '"border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.4);color:#fff;background:"+(_ok?"#15803d":(_cancelled?"#334155":"#b91c1c"));' +
  'var _h=document.createElement("strong");_h.textContent=_title;_h.style.cssText="display:block;font-weight:700;margin-bottom:4px";' +
  'var _p=document.createElement("p");_p.textContent=_body;_p.style.cssText="margin:0 0 6px;opacity:.95";' +
  '_box.appendChild(_h);_box.appendChild(_p);' +
  // The number, the sandbox note, the reference and a Dismiss button belong to a
  // failure somebody has to act on. A cancellation needs none of them, and it
  // removes itself after six seconds so it cannot be left sitting on the page.
  'if(_cancelled){setTimeout(function(){try{_box.remove()}catch(_){}},6e3)}' +
  'else{var _sm=document.createElement("p");_sm.style.cssText="margin:0;opacity:.8;font-size:12px";' +
  '_sm.textContent=(_sandbox?"Sandbox deposit — no real money was involved. ":"")+"Reference "+_ref+(_dep.msisdn_masked?(" · sent to "+_dep.msisdn_masked):"")+(_ok&&_dep.provider_reference?(" · receipt "+_dep.provider_reference):"");' +
  'var _b=document.createElement("button");_b.textContent="Dismiss";_b.style.cssText="margin-top:8px;padding:4px 10px;"+' +
  '"border-radius:8px;border:1px solid rgba(255,255,255,.4);background:transparent;color:#fff;font:inherit;cursor:pointer";' +
  '_b.onclick=function(){_box.remove()};_box.appendChild(_sm);_box.appendChild(_b);}' +
  'document.body.appendChild(_box)}catch(_e){}}' +
  "var _t=setInterval(async function(){if(++_n>72){clearInterval(_t);" +
  'var _last={status:"pending",environment:null,failure_reason:null};_show(_last,true);return}' +
  "try{var _b=await fetch(`\${(0,r.getApiUrl)()}/api/auth/deposits/`+encodeURIComponent(_ref)," +
  "{headers:{Authorization:\"Bearer \"+localStorage.getItem(\"token\")}});" +
  "var _j=await _b.json().catch(function(){return{}});var _dep=_j&&_j.deposit;" +
  'if(!_dep||!_dep.status||_dep.status==="pending")return;clearInterval(_t);_show(_dep,false)}' +
  'catch(_e){}},5000)})()';

const DEPOSIT_OUTCOME_EDIT = {
  from: DEPOSIT_PUSH_ANCHOR,
  to:
    "if(s.ok){var _d=await s.json().catch(function(){return{}});z(!0);c(\"\");" +
    DEPOSIT_POLL_SRC +
    "}",
  note: "the M-Pesa deposit screen reports the final status instead of spinning forever",
};

/** Chunks the mirror carries the M-Pesa deposit handler in, so a lost anchor is loud. */
export const DEPOSIT_CHUNKS = new Set(["219b97e8e5e970d5.js"]);

export function patchDepositOutcome(source, filename = "") {
  const applied = [];
  const skipped = [];

  const occurrences = source.split(DEPOSIT_OUTCOME_EDIT.from).length - 1;
  if (occurrences === 1) {
    return {
      source: source.replace(DEPOSIT_OUTCOME_EDIT.from, DEPOSIT_OUTCOME_EDIT.to),
      applied: [DEPOSIT_OUTCOME_EDIT.note],
      skipped,
      count: 1,
    };
  }

  if (occurrences > 1) {
    skipped.push(`${DEPOSIT_OUTCOME_EDIT.note}: its anchor matched ${occurrences} times, expected exactly once`);
    return { source, applied, skipped, count: 0 };
  }

  if (DEPOSIT_CHUNKS.has(filename)) {
    skipped.push(
      `${filename}: carries the M-Pesa deposit handler in the mirror, but its anchor was not found in this bundle`
    );
  }
  return { source, applied, skipped, count: 0 };
}

/**
 * Gives the trading socket a heartbeat, a watchdog and a backoff. Safe on any
 * chunk: one that does not carry the socket is returned untouched with nothing
 * reported, while the chunk that does carry it reports every anchor that has
 * stopped matching.
 */
export function patchSocketResilience(source, filename = "") {
  const applied = [];
  const skipped = [];
  let out = source;

  for (const edit of SOCKET_EDITS) {
    const occurrences = out.split(edit.from).length - 1;
    if (occurrences !== 1) {
      skipped.push(`${edit.note}: its anchor matched ${occurrences} times, expected exactly once`);
      continue;
    }
    out = out.replace(edit.from, edit.to);
    applied.push(edit.note);
  }

  if (applied.length) return { source: out, applied, skipped, count: applied.length };

  // Nothing applied. Only the chunk that really carries the trading socket is
  // worth a word: for any other chunk this pass simply has no subject, and
  // three "anchor missing" warnings on every boot would train the reader to
  // ignore the one that matters.
  if (SOCKET_CHUNKS.has(filename)) {
    skipped.push(
      `${filename}: carries the trading socket in the mirror, but none of its anchors were found in this bundle`
    );
    return { source, applied, skipped, count: 0 };
  }

  return { source, applied: [], skipped: [], count: 0 };
}
