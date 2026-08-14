/** Copy dictionaries for the remote hub settings section. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  nav: '远程连接',
  title: '远程 Hub',
  status: '连接状态',
  connected: '已连接',
  disconnected: '未连接',
  connecting: '连接中',
  error: '连接错误',
  uri: '服务器地址',
  serverName: '服务器名称',
  serverVersion: '协议版本',
  notConfigured: '未配置远程 Hub。',
  notConfiguredHint: '请在配置文件中添加 hub-client 插件并设置服务器地址。',
  retry: '重新连接',
  workspaces: '远程目录',
  noWorkspaces: '远程设备暂无可用目录。',
  workspacePath: '远程路径',
} satisfies Record<string, string>

/** Hub settings locale key union. */
export type HubLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  nav: 'Remote Hub',
  title: 'Remote Hub',
  status: 'Connection status',
  connected: 'Connected',
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  error: 'Connection error',
  uri: 'Server address',
  serverName: 'Server name',
  serverVersion: 'Protocol version',
  notConfigured: 'No remote hub configured.',
  notConfiguredHint: 'Add a hub-client plugin to your configuration file and set the server address.',
  retry: 'Reconnect',
  workspaces: 'Remote directories',
  noWorkspaces: 'No directories are available on the remote device.',
  workspacePath: 'Remote path',
} satisfies Record<HubLocaleKey, string>
