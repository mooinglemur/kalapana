// Enough of semver precedence to order index versions such as "1.0.0-beta" and "1.0.0".

function parse(version) {
  const [core, prerelease] = version.split("+", 1)[0].split(/-(.*)/s);
  return {
    numbers: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}

function compareIdentifiers(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Negative when a sorts before b.
export function compareVersions(a, b) {
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.numbers.length, right.numbers.length); i++) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (diff) return diff;
  }
  // A release sorts after any of its prereleases.
  if (!left.prerelease.length || !right.prerelease.length) return right.prerelease.length - left.prerelease.length;
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    if (left.prerelease[i] === undefined) return -1;
    if (right.prerelease[i] === undefined) return 1;
    const diff = compareIdentifiers(left.prerelease[i], right.prerelease[i]);
    if (diff) return diff;
  }
  return 0;
}
