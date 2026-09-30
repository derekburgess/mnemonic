/** Shared defaults for the editor and Docker launchers. null leaves a limit unset. */
export const sandboxDefaults = {
  sandbox: { memory: "2g", cpus: 2, pidsLimit: 512, network: "bridge", workspaceReadOnly: false },
  localModel: { memory: null, cpus: null, pidsLimit: 256 },
};
export const defaultSandboxText = JSON.stringify(sandboxDefaults, null, 2);

/** Called only at execution time. Docker validates resource values; this limits which
 * options the editor can change without bypassing the existing isolation boundary. */
export function runtimeSandboxConfig(text?: string) {
  const config = text === undefined ? {} : JSON.parse(text);
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (!object(config)) throw new Error("Sandbox configuration must be a JSON object.");
  for (const key of Object.keys(config)) {
    if (key !== "sandbox" && key !== "localModel") throw new Error(`Unsupported sandbox configuration field: ${key}`);
  }
  const result: Record<string, Record<string, unknown>> = {};
  for (const section of ["sandbox", "localModel"] as const) {
    const supplied = config[section] ?? {};
    if (!object(supplied)) throw new Error(`Sandbox configuration ${section} must be an object.`);
    for (const key of Object.keys(supplied)) {
      if (!Object.hasOwn(sandboxDefaults[section], key)) throw new Error(`Unsupported sandbox configuration field: ${section}.${key}`);
    }
    result[section] = { ...sandboxDefaults[section], ...supplied };
  }
  if (!["bridge", "none"].includes(String(result.sandbox.network))) throw new Error("Sandbox network must be bridge or none; host and shared-container networking are not allowed.");
  if (typeof result.sandbox.workspaceReadOnly !== "boolean") throw new Error("workspaceReadOnly must be true or false.");
  return result;
}

export function resourceArgs(config: Record<string, unknown>): string[] {
  return ([ ["memory", "memory"], ["cpus", "cpus"], ["pidsLimit", "pids-limit"] ] as const)
    .flatMap(([key, flag]) => config[key] === null ? [] : [`--${flag}=${String(config[key])}`]);
}
