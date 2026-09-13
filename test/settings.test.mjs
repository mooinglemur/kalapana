import assert from "node:assert/strict";
import { test } from "node:test";
import { integerSetting, portSetting } from "../server/settings.mjs";

function port(value) {
  const warnings = [];
  const result = portSetting({ KALAPANA_PORT: value }, "KALAPANA_PORT", 8080, (message) => warnings.push(message));
  return { result, warnings };
}

test("a Kubernetes service link in KALAPANA_PORT falls back to the default with a warning", () => {
  const { result, warnings } = port("tcp://10.0.0.1:8080");
  assert.equal(result, 8080);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /KALAPANA_PORT=tcp:\/\/10\.0\.0\.1:8080/);
});

test("a plain port number is used", () => {
  assert.deepEqual(port("9000"), { result: 9000, warnings: [] });
  assert.deepEqual(port(undefined), { result: 8080, warnings: [] });
});

test("an out-of-range port falls back to the default", () => {
  assert.equal(port("70000").result, 8080);
});

test("other numeric settings fail with the variable's name", () => {
  const env = { KALAPANA_DOWNLOAD_CONCURRENCY: "8x", KALAPANA_ANALYZER_CONCURRENCY: "0" };
  assert.throws(() => integerSetting(env, "KALAPANA_DOWNLOAD_CONCURRENCY", 8), /KALAPANA_DOWNLOAD_CONCURRENCY/);
  assert.throws(() => integerSetting(env, "KALAPANA_ANALYZER_CONCURRENCY", 4, { min: 1 }), /at least 1/);
  assert.equal(integerSetting({}, "KALAPANA_ANALYZER_TIMEOUT_SECONDS", 180), 180);
  assert.equal(integerSetting({ KALAPANA_ANALYZER_TIMEOUT_SECONDS: " 30 " }, "KALAPANA_ANALYZER_TIMEOUT_SECONDS", 180), 30);
});
