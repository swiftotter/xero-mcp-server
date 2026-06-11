/**
 * Whether this process may read/write arbitrary local filesystem paths supplied
 * as tool arguments (create-attachment `filePath`, get-attachment `outputPath`).
 *
 * In the hosted Cloud Run deployment the parent spawns one MCP child per user
 * and keeps cross-user secrets in the process environment (notably
 * MCP_JWT_SECRET, the HS256 key that signs every user's access token). Letting
 * a tool argument name an arbitrary path there would let a caller read secrets
 * out of /proc/self/environ or overwrite the server's own code. The Cloud Run
 * spawner therefore sets XERO_MCP_DISABLE_LOCAL_FILES=1.
 *
 * The local Claude Desktop (stdio) deployment leaves it unset — there, reading
 * and writing the developer's own files is the entire point of these tools.
 */
export const DISABLE_LOCAL_FILES_ENV = "XERO_MCP_DISABLE_LOCAL_FILES";

export function localFileAccessDisabled(): boolean {
  const value = process.env[DISABLE_LOCAL_FILES_ENV];
  return value === "1" || value === "true";
}
