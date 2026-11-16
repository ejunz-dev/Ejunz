/**
 * Ambient declarations for optional integrations whose packages are not
 * installed in this workspace. The modules are loaded only when the matching
 * provider/MCP plugin is configured; keeping the declarations here lets the
 * host typecheck cover the rest of the tree without requiring every optional
 * SDK at build time.
 */

declare module 'koffi' {
  interface KoffiLibrary {
    func(...args: unknown[]): (...args: unknown[]) => unknown
  }

  interface Koffi {
    load(path: string): KoffiLibrary
  }

  const koffi: Koffi
  export default koffi
}

declare module '@anthropic-ai/claude-agent-sdk' {
  export type SpawnOptions = any
  export type SpawnedProcess = any
  export type Options = any
  export type Query = any
  export type SDKMessage = any
  export type SDKResultMessage = any
  export const query: any
}

declare module '@modelcontextprotocol/sdk/types.js' {
  export const ListToolsResultSchema: any
  export const ToolListChangedNotificationSchema: any
}

declare module '@modelcontextprotocol/sdk/shared/transport.js' {
  export type Transport = any
}

declare module '@modelcontextprotocol/sdk/client/stdio.js' {
  export const StdioClientTransport: any
}

declare module '@modelcontextprotocol/sdk/client/streamableHttp.js' {
  export const StreamableHTTPClientTransport: any
}

declare module '@modelcontextprotocol/sdk/client/index.js' {
  export const Client: any
  export type Client = any
}
