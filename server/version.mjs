// Kalapana's own version. The number lives here; the container build stamps in the commit it was built from
// (deploy/Dockerfile's KALAPANA_COMMIT build argument, which .gitlab-ci.yml fills from the pipeline's commit).
export const VERSION = "0.1.0";

/**
 * The version shown in the page footer: "0.1.0-abc1234" when built from a commit, "0.1.0" otherwise.
 * A commit that isn't a hex sha, such as an unexpanded variable, is ignored rather than shown.
 */
export function versionString(commit, version = VERSION) {
  const trimmed = commit?.trim() ?? "";
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? `${version}-${trimmed.toLowerCase().slice(0, 7)}` : version;
}
