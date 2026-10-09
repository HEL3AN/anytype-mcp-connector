// OAuth scopes of the connector. The owner picks the access level on the consent page; a read-only
// connection gets an MCP server without the tools that change data.

export const READ_SCOPE = "anytype:read";
export const WRITE_SCOPE = "anytype:write";
export const SCOPES = [READ_SCOPE, WRITE_SCOPE];

/** The single scope of tokens issued before read-only connections existed: full access. */
const LEGACY_SCOPE = "anytype";

/** Expands the legacy scope and makes write imply read; unknown scopes are dropped. */
export function normalizeScopes(scopes: readonly string[]): string[] {
  const write = scopes.includes(WRITE_SCOPE) || scopes.includes(LEGACY_SCOPE);
  const read = write || scopes.includes(READ_SCOPE);
  return [...(read ? [READ_SCOPE] : []), ...(write ? [WRITE_SCOPE] : [])];
}

export const canWrite = (scopes: readonly string[]) => normalizeScopes(scopes).includes(WRITE_SCOPE);
