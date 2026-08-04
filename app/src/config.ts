/** Server endpoints. See CONTRACTS.md ("Client server-config").
 *  Priority: localStorage 'serverOrigin' (runtime override, needed by the APK
 *  where window.location.origin is a local capacitor:// URL) > build-time
 *  VITE_SERVER_ORIGIN > current origin. */
export function getServerConfig(): { wsUrl: string; httpUrl: string } {
  const origin =
    (typeof localStorage !== 'undefined' ? localStorage.getItem('serverOrigin') : null) ??
    (import.meta.env.VITE_SERVER_ORIGIN as string | undefined) ??
    window.location.origin;
  return {
    wsUrl: origin.replace(/^http/, 'ws') + '/sync',
    httpUrl: origin + '/api',
  };
}
