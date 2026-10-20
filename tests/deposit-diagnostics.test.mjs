/**
 * What a failed M-Pesa prompt leaves behind.
 *
 * WHY THIS SUITE EXISTS. On 2026-10-18 a real sandbox deposit failed with
 * Safaricom's ResultCode 9999, "Error occurred while sending push request." The
 * failure itself was handled correctly — recorded, terminal, and the wallet
 * untouched — but the question the customer actually asked ("which number did
 * this go to?") had no answer, because nothing recorded the MSISDN at all. The
 * number is not recoverable from a 9999 callback either: Daraja sends no
 * CallbackMetadata with it.
 *
 * So two things are pinned here:
 *
 *   - the number the prompt was sent to is recorded MASKED (`2547****678`), and
 *     the full number never reaches the deposit, the response or the database;
 *   - a result code the deployment understands carries a short hint about what
 *     to do next, additive to the provider's own sentence — never instead of it,
 *     and never telling a production deposit to try a sandbox number.
 *
 * No provider is contacted. Every push below is a fixture.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { maskMsisdn, mpesaResultHint } from "../tools/payments.mjs";

describe("the number a prompt went to is recorded, masked", () => {
  test("a normalised Safaricom number keeps its prefix and last three digits", () => {
    assert.equal(maskMsisdn("254712345678"), "2547****678");
    assert.equal(maskMsisdn("254708374149"), "2547****149");
  });

  test("the mask never contains the middle of the number", () => {
    const full = "254712345678";
    const masked = maskMsisdn(full);
    assert.ok(!masked.includes("1234567"), "the subscriber part must not survive the mask");
    assert.ok(masked.length < full.length, "a mask that is not shorter is not a mask");
    assert.match(masked, /^\d{4}\*{4}\d{3}$/);
  });

  test("anything too short to identify is not stored as a number", () => {
    for (const value of ["", null, undefined, "123", "2547123", "not-a-number"]) {
      assert.equal(maskMsisdn(value), null, `${value} must not become a masked number`);
    }
  });

  test("a longer international number is masked, not rejected", () => {
    // The normaliser only admits Kenyan numbers today; the mask must not throw
    // if that ever widens, because it runs on the intent path.
    assert.equal(maskMsisdn("2547123456789"), "2547****789");
  });
});

describe("a known result code says what to do next", () => {
  test("9999 explains that the prompt never reached the number", () => {
    const hint = mpesaResultHint(9999, "sandbox");
    assert.match(hint, /could not deliver the prompt/);
    assert.match(hint, /254708374149/, "in sandbox, name the test number");
    assert.match(hint, /no money moved|nothing was charged/i);
  });

  test("the sandbox test number is never suggested to a production deposit", () => {
    const production = mpesaResultHint(9999, "production");
    assert.match(production, /could not deliver the prompt/);
    assert.doesNotMatch(production, /254708374149/, "a live deposit must not be sent to a sandbox number");
    assert.doesNotMatch(production, /sandbox/i);
  });

  test("the codes a customer can act on are covered", () => {
    assert.match(mpesaResultHint(1032, "sandbox"), /cancelled/i);
    assert.match(mpesaResultHint(1037, "sandbox"), /not answered|expired/i);
    assert.match(mpesaResultHint(1, "production"), /enough money|balance/i);
    assert.match(mpesaResultHint(2001, "production"), /PIN/i);
  });

  test("an unknown or absent code produces no hint rather than a guess", () => {
    for (const code of [null, undefined, 4242, "nonsense"]) {
      assert.equal(mpesaResultHint(code, "sandbox"), null);
    }
  });

  test("the hint names no credential and no amount", () => {
    for (const code of [1, 17, 1001, 1019, 1025, 1032, 1037, 2001, 9999]) {
      const hint = mpesaResultHint(code, "sandbox");
      assert.ok(hint, `${code} should have a hint`);
      assert.doesNotMatch(hint, /consumer|secret|passkey|token|password|shortcode/i);
      assert.doesNotMatch(hint, /\d+\s*(kes|shilling)/i, "a hint must not quote a charge");
    }
  });
});
