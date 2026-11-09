// Guards for values read from JSON files (settings, config, provider entries). No dependencies, so the command-line
// tool can load the modules that use them without the rest of the app.

/** An object that is not an array (what a JSON object parses to). */
export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
