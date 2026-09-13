import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions } from "../server/semver.mjs";

test("orders releases numerically", () => {
  const sorted = ["0.10.0", "0.2.0", "0.9.1", "1.0.0"].sort(compareVersions);
  assert.deepEqual(sorted, ["0.2.0", "0.9.1", "0.10.0", "1.0.0"]);
});

test("each version piece compares as a number", () => {
  const sorted = ["1.0.10", "1.0.9", "1.10.0", "1.9.2", "2.0"].sort(compareVersions);
  assert.deepEqual(sorted, ["1.0.9", "1.0.10", "1.9.2", "1.10.0", "2.0"]);
});

test("build metadata is ignored", () => {
  assert.equal(compareVersions("0.4.3+hotfix-0.6.2", "0.4.3"), 0);
  assert.ok(compareVersions("0.4.3+hotfix-0.6.2", "0.4.10") < 0);
});

test("a release sorts after its prereleases", () => {
  const sorted = ["1.1.0", "1.1.0-beta", "1.0.0", "1.5.0-beta"].sort(compareVersions);
  assert.deepEqual(sorted, ["1.0.0", "1.1.0-beta", "1.1.0", "1.5.0-beta"]);
});

test("prerelease identifiers follow semver precedence", () => {
  const sorted = ["1.0.0-beta.2", "1.0.0-alpha", "1.0.0-beta.10", "1.0.0-alpha.1"].sort(compareVersions);
  assert.deepEqual(sorted, ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta.2", "1.0.0-beta.10"]);
});
