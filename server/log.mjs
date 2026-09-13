export function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}
