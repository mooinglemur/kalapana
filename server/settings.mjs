// Parsing for numeric settings from the environment.

// Kubernetes injects KALAPANA_PORT=tcp://<service ip>:<port> into pods when a Service is named
// "kalapana". That value describes the Service, not this pod, so it's ignored rather than parsed.
export function portSetting(env, name, fallback, warn) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (/^\d+$/.test(raw) && Number(raw) < 65536) return Number(raw);
  warn(`ignoring ${name}=${env[name]}: not a port number, using ${fallback}`);
  return fallback;
}

export function integerSetting(env, name, fallback, { min = 0 } = {}) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min) {
    throw new Error(`${name} must be an integer of at least ${min}, got ${JSON.stringify(env[name])}`);
  }
  return Number(raw);
}
