/**
 * The tool-description registry.
 *
 * The source imports ~20 tool-description schemas directly into the model layer, one `import` per tool
 * module, and `get_tools_for_enabled_functions` maps a function name to the matching schema. That works
 * in Python where every tool module already exists; in this port the tools land across several phases,
 * so a direct-import model layer would not compile until the last one arrived.
 *
 * A registry inverts the dependency: each tool module registers its own schema, and the model layer only
 * knows the registry. That means the model layer is complete NOW, and a tool becomes available to the
 * agent the moment it is ported — with no edit here.
 *
 * The behaviour that matters is preserved exactly: an enabled function with no registered schema is
 * SKIPPED rather than erroring, which is what the source does for an unknown name, so a partially
 * ported tool set degrades to a smaller tool list rather than a failed turn.
 */

/** A Bedrock-format tool spec. The wire shape all three providers are converted from. */
export interface ToolSpec {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

const registry = new Map<string, ToolSpec>();

/**
 * Register a tool's schema under the name the agent calls it by.
 *
 * Called at module load by each tool. Registering the same name twice overwrites, which is what an
 * intentional alias needs — the source exposes one underlying tool under a second, friendlier name.
 */
export function registerTool(name: string, spec: ToolSpec): void {
  registry.set(name, spec);
}

/** Register the same spec under an additional name, keeping one implementation behind two names. */
export function registerToolAlias(
  alias: string,
  spec: ToolSpec,
  description?: string
): void {
  registry.set(alias, {
    toolSpec: {
      ...spec.toolSpec,
      name: alias,
      description: description ?? spec.toolSpec.description,
    },
  });
}

/** Every registered tool name, for diagnostics. */
export function registeredToolNames(): string[] {
  return [...registry.keys()].sort();
}

/**
 * The schemas for a set of enabled function names.
 *
 * An unregistered name is skipped with a warning rather than throwing: the agent gets a smaller tool
 * list, which is a degraded turn rather than a failed one.
 */
export function getToolsForEnabledFunctions(
  enabledFunctions: readonly string[] | null | undefined
): ToolSpec[] {
  const out: ToolSpec[] = [];
  const missing: string[] = [];
  for (const name of enabledFunctions ?? []) {
    const spec = registry.get(name);
    if (spec) out.push(spec);
    else missing.push(name);
  }
  if (missing.length) {
    console.warn(
      `[LLM] no registered schema for enabled function(s): ${missing.join(', ')} — ` +
        `omitted from this turn's tool list`
    );
  }
  return out;
}

/**
 * The default tool set, used when a caller passes no explicit enabled functions.
 *
 * Every registered tool. The source keeps a hand-maintained default list; a registry makes "everything
 * available" the natural default and avoids the list drifting out of sync with the tools that exist.
 */
export function getDefaultTools(): ToolSpec[] {
  return [...registry.values()];
}

/** Clear the registry. Tests only. */
export function __resetRegistry(): void {
  registry.clear();
}
