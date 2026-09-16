import assert from "node:assert/strict";
import { test } from "node:test";
import { VERSION, versionString } from "../server/version.mjs";

test("the commit the image was built from follows the version number", () => {
  assert.equal(VERSION, "0.1.0");
  assert.equal(versionString("abc1234"), "0.1.0-abc1234");
  // GitLab's short sha is 8 characters, and a full sha can be passed too; both show as 7.
  assert.equal(versionString("abc12345"), "0.1.0-abc1234");
  assert.equal(versionString("ABC1234DEADBEEF1234567890ABCDEF123456789"), "0.1.0-abc1234");
  assert.equal(versionString(" abc1234 "), "0.1.0-abc1234");
});

test("without a usable commit, the number stands alone", () => {
  for (const value of [undefined, null, "", "   ", "unknown", "abc123", "$CI_COMMIT_SHORT_SHA", "sha-abc1234"]) {
    assert.equal(versionString(value), "0.1.0", JSON.stringify(value));
  }
});
