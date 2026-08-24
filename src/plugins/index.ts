import type { CratePlugin } from '../lib/plugin.js';

/**
 * The server-side plugin registry. Enabling a feature is one line here.
 *
 * An explicit array rather than directory scanning, on purpose: the build has no bundler on
 * the server side (plain tsc), so discovery would mean readdir at boot — and a feature that
 * appears because a file exists is a feature nobody can grep for. One import, one line, and
 * "what is enabled?" has an answer you can read.
 *
 * Order matters only for migrate(): plugins run in array order, after the core schema.
 */
export const PLUGINS: CratePlugin[] = [];
