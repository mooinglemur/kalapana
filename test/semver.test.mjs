import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions } from "../server/semver.mjs";

test("orders releases numerically", () => {
  const sorted = ["0.10.0", "0.2.0", "0.9.1", "1.0.0"].sort(compareVersions);
  assert.deepEqual(sorted, ["0.2.0", "0.9.1", "0.10.0", "1.0.0"]);
});

test("a release sorts after its prereleases", () => {
  const sorted = ["1.1.0", "1.1.0-beta", "1.0.0", "1.5.0-beta"].sort(compareVersions);
  assert.deepEqual(sorted, ["1.0.0", "1.1.0-beta", "1.1.0", "1.5.0-beta"]);
});

test("prerelease identifiers follow semver precedence", () => {
  const sorted = ["1.0.0-beta.2", "1.0.0-alpha", "1.0.0-beta.10", "1.0.0-alpha.1"].sort(compareVersions);
  assert.deepEqual(sorted, ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta.2", "1.0.0-beta.10"]);
});
