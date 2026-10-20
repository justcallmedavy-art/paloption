/**
 * The M-Pesa deposit screen's outcome.
 *
 * WHY THIS SUITE EXISTS. The mirrored M-Pesa handler opened its "Processing
 * Payment" screen and never asked the server again:
 *
 *   if(s.ok) z(!0), c("");
 *
 * for a successful deposit the balance update eventually tells the page
 * something happened, but a FAILED one left the visitor on "Check your phone and
 * enter M-Pesa PIN" with nothing to say the prompt was cancelled and no money
 * moved. Measured against the live sandbox: three real pushes, three real
 * callbacks (1032/1037), deposit rows correctly `failed`, ledger untouched — and
 * the browser still spinning.
 *
 * These tests pin the repair: the anchor is rewritten once, the reported note
 * says what changed, a chunk that no longer carries the anchor is reported
 * rather than silently passing, and the injected code only ever READS — nothing
 * in it can credit a wallet.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { patchDepositOutcome, patchClientChunk, DEPOSIT_CHUNKS } from "../tools/client-patches.mjs";

/** The anchor exactly as the mirror's bundle carries it. */
const HANDLER = 'if(s.ok)z(!0),c("");else{let e=await s.json();A({type:"error",text:e.error||"Failed to initiate payment"})}';
const DEPOSIT_CHUNK = "219b97e8e5e970d5.js";

describe("the deposit screen is told the outcome", () => {
  test("the handler is rewritten, and says so", () => {
    const result = patchDepositOutcome(HANDLER, DEPOSIT_CHUNK);
    assert.equal(result.count, 1);
    assert.equal(result.applied.length, 1);
    assert.match(result.applied[0], /final status instead of spinning/);
    assert.equal(result.skipped.length, 0);
  });

  test("the replacement polls the deposit status route and keeps the reference", () => {
    const { source } = patchDepositOutcome(HANDLER, DEPOSIT_CHUNK);
    assert.match(source, /api\/auth\/deposits\//);
    assert.match(source, /_d\.deposit&&_d\.deposit\.reference/, "the reference comes from the push response");
    assert.match(source, /_dep\.status/, "the deposit status is what it waits on");
    assert.match(source, /failure_reason/, "the reason shown is the API's own");
  });

  test("the outcome is a node React does not own, because the page re-renders every second", () => {
    const { source } = patchDepositOutcome(HANDLER, DEPOSIT_CHUNK);
    // Measured in the browser: rewriting the processing screen's own text was
    // undone by the next reconciliation. The toast is appended to document.body
    // instead, and carries the outcome as data attributes so it can be asserted on.
    assert.match(source, /document\.body\.appendChild\(_box\)/);
    assert.match(source, /data-deposit-status/);
    assert.match(source, /data-deposit-reference/);
    assert.doesNotMatch(source, /document\.querySelectorAll\("h3"\)/, "no React-managed text is rewritten");
    assert.match(source, /textContent="Dismiss"|textContent="Dismiss"/);
  });

  test("a terminal status stops the poll, and a pending one keeps waiting", () => {
    const { source } = patchDepositOutcome(HANDLER, DEPOSIT_CHUNK);
    assert.match(source, /_dep\.status==="pending"/, "pending is explicitly the still-waiting case");
    assert.match(source, /clearInterval\(_t\)/, "a terminal answer stops the interval");
    assert.match(source, /if\(document\.getElementById\(_id\)\)return/, "one toast per deposit, however often it polls");
  });

  test("it only ever reads: no request in it can move money", () => {
    const { source } = patchDepositOutcome(HANDLER, DEPOSIT_CHUNK);
    const injected = source.slice(source.indexOf("if(s.ok){"), source.indexOf("else{let e=await s.json();"));
    // A GET with no init and no method: the patch cannot credit, only observe.
    assert.equal((injected.match(/fetch\(/g) || []).length, 1, "exactly one request");
    assert.doesNotMatch(injected, /method\s*:/, "no method is set on it");
    assert.doesNotMatch(injected, /\/api\/auth\/(mpesa\/callback|card\/deposit)/, "no money-moving route");
  });

  test("a failure names the number it went to, and what to do next", () => {
    // ResultCode 9999 on 2026-10-18 left the customer with the provider's sentence
    // and no way to tell which number had been tried. Both now come from the API:
    // the number masked, and a hint for a code the deployment understands.
    const { source } = patchDepositOutcome(HANDLER, DEPOSIT_CHUNK);
    assert.match(source, /_dep\.msisdn_masked/, "the masked number is shown");
    assert.match(source, /sent to ","\+_dep\.msisdn_masked|sent to "\+_dep\.msisdn_masked/);
    assert.match(source, /_dep\.failure_hint/, "a known result code carries its hint");
    assert.match(source, /_dep\.failure_reason\|\|"The payment was not completed\."/, "the provider's own sentence comes first");
    assert.ok(
      source.indexOf("_dep.failure_hint") > source.indexOf("No money was taken from your account."),
      "the hint is additive, appended after the outcome, never instead of it"
    );
  });

  test("a prompt the customer cancelled gets one calm line and leaves on its own", () => {
    // Reported on 2026-10-18: every sandbox attempt ended in a red banner carrying
    // the provider's sentence, a hint, the sandbox note and a reference — for an
    // outcome where the customer had simply declined the prompt. That is the
    // ordinary result of a test push, and it read as a broken app.
    const { source } = patchDepositOutcome(HANDLER, DEPOSIT_CHUNK);
    assert.match(source, /Number\(_dep\.mpesa_result_code\)===1032/, "cancellation is recognised by its own result code");
    assert.match(source, /"M-Pesa deposit cancelled"/);
    assert.match(source, /"You cancelled the prompt, so nothing was charged\."/);
    assert.match(source, /data-deposit-cancelled/, "the state is on the node, so it can be asserted on");
    assert.match(source, /_cancelled\?"#334155"/, "a cancellation is not painted as an error");
    assert.match(source, /if\(_cancelled\)\{setTimeout\(function\(\)\{try\{_box\.remove\(\)\}catch\(_\)\{\}\},6e3\)\}/);
  });

  test("a cancellation drops the hint, the sandbox note, the reference and the button", () => {
    const { source } = patchDepositOutcome(HANDLER, DEPOSIT_CHUNK);
    // The extras belong to the branch that is NOT a cancellation: `else{…}` after
    // the cancelled case, which is where `_sm` and the Dismiss button are built.
    const start = source.indexOf("if(_cancelled){");
    assert.ok(start > -1, "the cancelled case must be a branch of its own");
    const cancelledBranch = source.slice(start, source.indexOf("}else{", start));
    assert.doesNotMatch(cancelledBranch, /failure_hint/);
    assert.doesNotMatch(cancelledBranch, /msisdn_masked/);
    assert.doesNotMatch(cancelledBranch, /Sandbox deposit/);
    assert.doesNotMatch(cancelledBranch, /textContent="Dismiss"/);
  });

  test("the failure path keeps everything a failed prompt still needs", () => {
    const { source } = patchDepositOutcome(HANDLER, DEPOSIT_CHUNK);
    const failureKeeps = source.slice(source.indexOf("Number(_dep.mpesa_result_code)===1032"), source.indexOf("document.body.appendChild(_box)"));
    assert.match(failureKeeps, /_dep\.failure_reason/, "the provider's sentence is still shown");
    assert.match(failureKeeps, /_dep\.failure_hint/, "and what to do next for a code we know");
    assert.match(failureKeeps, /_dep\.msisdn_masked/, "and which number it went to");
    assert.match(failureKeeps, /textContent="Dismiss"/, "a failure stays until it is dismissed");
  });

  test("it fails honestly rather than pretending the payment is in flight", () => {
    const { source } = patchDepositOutcome(HANDLER, DEPOSIT_CHUNK);
    assert.match(source, /No result arrived within six minutes/);
    assert.match(source, /nothing was credited unless it appears there/);
  });

  test("a sandbox deposit says so on the toast", () => {
    const { source } = patchDepositOutcome(HANDLER, DEPOSIT_CHUNK);
    assert.match(source, /environment/);
    assert.match(source, /Sandbox deposit — no real money was involved/);
  });

  test("a second pass does not stack a second poll", () => {
    const once = patchDepositOutcome(HANDLER, DEPOSIT_CHUNK);
    const twice = patchDepositOutcome(once.source, DEPOSIT_CHUNK);
    assert.equal(twice.count, 0);
    assert.equal(twice.source, once.source);
    // The chunk that carries the handler must say the anchor is gone, not pass quietly.
    assert.equal(twice.skipped.length, 1);
    assert.match(twice.skipped[0], /carries the M-Pesa deposit handler/);
  });

  test("an anchor appearing twice is refused, not applied to the wrong one", () => {
    const result = patchDepositOutcome(HANDLER + HANDLER, DEPOSIT_CHUNK);
    assert.equal(result.count, 0);
    assert.match(result.skipped[0], /matched 2 times, expected exactly once/);
    assert.equal(result.source, HANDLER + HANDLER);
  });

  test("another chunk with no handler in it is left alone and is not noisy", () => {
    const result = patchDepositOutcome("const unrelated = 1;", "deadbeef.js");
    assert.equal(result.count, 0);
    assert.deepEqual(result.skipped, []);
  });

  test("the pass runs inside patchClientChunk, so both the mirror and a snapshot get it", () => {
    const applied = patchClientChunk(DEPOSIT_CHUNK, HANDLER);
    assert.ok(
      applied.applied.some((note) => /final status instead of spinning/.test(note)),
      "the deposit pass must be part of the whole-chunk pipeline"
    );
    assert.ok(DEPOSIT_CHUNKS.has(DEPOSIT_CHUNK));
  });
});
