// Embedded in the native service and loaded explicitly for each Pi subprocess.
// Credentials live only in the child environment and expire with its turn.
export default function catalexWorkspace(pi) {
  if (typeof pi.registerMcpServer !== "function") {
    throw new Error(
      "Catalex requires Pi 1.0 or newer with native MCP support.",
    );
  }
  const settings = JSON.parse(process.env.CATALEX_PI_MCP);
  delete process.env.CATALEX_PI_MCP;
  pi.registerMcpServer("catalex", {
    url: settings.url,
    headers: settings.headers,
    exposure: "direct",
  });
}
