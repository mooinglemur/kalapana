// Child process entry for analyzer tasks, started by server/sandbox.mjs under Node's permission model.
// Usage: node run.mjs <task> <job dir>; the task reads task_input and writes /job/result.json.
import { constants as fsConstants, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Pyodide's Emscripten filesystem asks for fs constants through process.binding, which the permission
// model blocks. Answer that one lookup; actual file access stays restricted.
const originalBinding = process.binding;
process.binding = (name) => (name === "constants" ? { fs: fsConstants } : originalBinding.call(process, name));

const [task, jobDir] = process.argv.slice(2);
const input = JSON.parse(readFileSync(join(jobDir, "input.json"), "utf8"));
const tasksDir = join(dirname(fileURLToPath(import.meta.url)), "tasks");

const { loadPyodide } = await import(pathToFileURL(join(input.pyodideDir, "pyodide.mjs")).href);
const py = await loadPyodide({
  indexURL: `${input.pyodideDir}/`,
  // Python gets no handle on Node globals such as process or fetch.
  jsglobals: { setTimeout, clearTimeout },
});
if (input.packages?.length) await py.loadPackage(input.packages, { messageCallback: () => {} });

for (const [mountPoint, hostPath] of Object.entries({ "/tasks": tasksDir, "/job": jobDir, ...input.mounts })) {
  py.FS.mkdirTree(mountPoint);
  py.FS.mount(py.FS.filesystems.NODEFS, { root: hostPath }, mountPoint);
}
py.globals.set("task_input", py.toPy(input));
const taskFile = join(tasksDir, `${task}.py`);
py.runPython(readFileSync(taskFile, "utf8"), { filename: taskFile });
process.exit(0);
