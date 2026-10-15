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

/** Chunk files this module knows how to fix. */
export const PATCHABLE_CHUNKS = new Set([
  "219b97e8e5e970d5.js",
  "31fae89f7d7805b5.js",
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
  return {
    source: socket.source,
    applied: [...result.applied, ...banners.applied, ...mode.applied, ...socket.applied],
    skipped: [...result.skipped, ...banners.skipped, ...mode.skipped, ...socket.skipped],
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
 *   1. `globalThis.__PALOPTION_API_URL__`, read at call time, so a page can
 *      override the base without rebuilding anything;
 *   2. the base baked in here, from PALOPTION_API_URL (VITE_API_URL is accepted
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
  ';let U=()=>globalThis.__PALOPTION_API_URL__||t;' +
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
  return (env.PALOPTION_API_URL || env.VITE_API_URL || "").trim().replace(/\/+$/, "");
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
  `(globalThis.__palOptionRetryDelay||(globalThis.__palOptionRetryDelay=${wsRetryDelay.toString()}))`;

/**
 * The heartbeat and its watchdog. Written against the chunk's own socket
 * variable `s`, and deliberately defensive: a socket that throws while being
 * pinged must not take the app down, so every step is inside one try/catch.
 */
const HEARTBEAT_SRC =
  'globalThis.__palOptionWsSeen=Date.now(),' +
  's.__palOptionBeat=setInterval(()=>{try{' +
  'if(Date.now()-(globalThis.__palOptionWsSeen||0)>45e3){s.close();return}' +
  's.readyState===WebSocket.OPEN&&s.send(JSON.stringify({type:"ping"}))' +
  '}catch(_){}},2e4)';

/** The retry, after counting one more failure. */
const RETRY_DELAY_CALL =
  '(globalThis.__palOptionWsAttempt=(globalThis.__palOptionWsAttempt||0)+1,' +
  `${RETRY_DELAY_SRC}(globalThis.__palOptionWsAttempt))`;

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
    to: 's.onmessage=e=>{globalThis.__palOptionWsSeen=Date.now(),globalThis.__palOptionWsAttempt=0;try{let t=JSON.parse(e.data);',
    note: "trading socket: an inbound frame records liveness and clears the backoff",
  },
  {
    from: 't.current=setTimeout(()=>{b()},3e3)',
    to: `s.__palOptionBeat&&clearInterval(s.__palOptionBeat),t.current=setTimeout(()=>{b()},${RETRY_DELAY_CALL})`,
    note: "trading socket: the fixed 3s retry becomes exponential backoff with jitter",
  },
];

/** Chunks the mirror carries the trading socket in, so a lost anchor is loud. */
export const SOCKET_CHUNKS = new Set(["219b97e8e5e970d5.js"]);

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
