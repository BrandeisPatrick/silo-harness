import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { RpcEvents, RpcMethods } from './shared/rpc';
import type { AgentEvent, AppConfig, ApprovalScope, QuestionAnswer, ArtifactInfo, Bounds, BrowserState, ChangeDiff, ChangeEntry, ContextInfo, FileHit, ImageAttachment, McpScope, McpServerInfo, ModelCapabilities, SiloHarnessApi, ProjectRules, RuleList, QueuedMessage, RewindResult, SendResult, SessionMeta, SkillInfo, TerminalTabInfo, TranscriptItem } from './shared/types';

// Every feature listens for pushes on the one 'rpc:push' channel, so more than Node's default ten listeners is normal.
ipcRenderer.setMaxListeners(200);

const api: SiloHarnessApi = {
  homeDir: process.env.HOME ?? '',
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (cfg: AppConfig): Promise<AppConfig> => ipcRenderer.invoke('config:set', cfg),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('cwd:choose'),
  listOllamaModels: (): Promise<string[]> => ipcRenderer.invoke('models:list'),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  send: (text: string, attachments?: ImageAttachment[]): Promise<SendResult> => ipcRenderer.invoke('chat:send', text, attachments ?? []),
  unqueue: (id: string): Promise<boolean> => ipcRenderer.invoke('chat:unqueue', id),
  queue: (): Promise<QueuedMessage[]> => ipcRenderer.invoke('chat:queue'),
  modelCapabilities: (): Promise<ModelCapabilities> => ipcRenderer.invoke('models:capabilities'),
  abort: (): Promise<void> => ipcRenderer.invoke('chat:abort'),
  compact: (focus?: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('chat:compact', focus ?? ''),
  context: (): Promise<ContextInfo> => ipcRenderer.invoke('chat:context'),
  mcp: {
    list: (): Promise<McpServerInfo[]> => ipcRenderer.invoke('mcp:list'),
    add: (name: string, spec: string, scope: McpScope, env?: Record<string, string>): Promise<McpServerInfo[]> => ipcRenderer.invoke('mcp:add', name, spec, scope, env ?? {}),
    remove: (name: string, scope: McpScope): Promise<McpServerInfo[]> => ipcRenderer.invoke('mcp:remove', name, scope),
    setEnabled: (name: string, scope: McpScope, enabled: boolean): Promise<McpServerInfo[]> => ipcRenderer.invoke('mcp:set-enabled', name, scope, enabled),
    reconnect: (name: string, scope: McpScope): Promise<McpServerInfo[]> => ipcRenderer.invoke('mcp:reconnect', name, scope),
    signIn: (name: string, scope: McpScope): Promise<McpServerInfo[]> => ipcRenderer.invoke('mcp:sign-in', name, scope),
    cancelSignIn: (name: string, scope: McpScope): Promise<McpServerInfo[]> => ipcRenderer.invoke('mcp:cancel-sign-in', name, scope),
    signOut: (name: string, scope: McpScope): Promise<McpServerInfo[]> => ipcRenderer.invoke('mcp:sign-out', name, scope),
    onServers: (cb: (servers: McpServerInfo[]) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, servers: McpServerInfo[]) => cb(servers);
      ipcRenderer.on('mcp:servers', handler);
      return () => ipcRenderer.removeListener('mcp:servers', handler);
    },
  },
  respondApproval: (id: string, ok: boolean, always?: boolean, scope?: ApprovalScope): Promise<AppConfig> => ipcRenderer.invoke('approval:response', id, ok, always, scope ?? 'session'),
  respondQuestion: (id: string, answers: QuestionAnswer[] | null): Promise<boolean> => ipcRenderer.invoke('question:response', id, answers),
  files: {
    search: (query: string, limit?: number): Promise<FileHit[]> => ipcRenderer.invoke('files:search', query, limit ?? 50),
  },
  instructions: {
    append: (text: string): Promise<{ path: string; label: string }> => ipcRenderer.invoke('instructions:append', text),
  },
  rules: {
    list: (): Promise<ProjectRules> => ipcRenderer.invoke('rules:list'),
    remove: (kind: RuleList | 'reason', value: string): Promise<ProjectRules> => ipcRenderer.invoke('rules:remove', kind, value),
    add: (list: RuleList, text: string): Promise<ProjectRules> => ipcRenderer.invoke('rules:add', list, text),
    check: (list: RuleList, text: string): Promise<string | null> => ipcRenderer.invoke('rules:check', list, text),
  },
  onAgentEvent: (cb: (ev: AgentEvent, sessionId: string) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, ev: AgentEvent, sessionId: string) => cb(ev, sessionId);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
  // The two generic bridges: features add RPC methods and push channels without touching this file.
  rpc: <K extends keyof RpcMethods>(method: K, ...args: Parameters<RpcMethods[K]>): Promise<Awaited<ReturnType<RpcMethods[K]>>> => ipcRenderer.invoke('rpc', method, ...args),
  onPush: <K extends keyof RpcEvents>(channel: K, cb: (payload: RpcEvents[K]) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, ch: string, payload: RpcEvents[K]) => {
      if (ch === channel) cb(payload);
    };
    ipcRenderer.on('rpc:push', handler);
    return () => ipcRenderer.removeListener('rpc:push', handler);
  },

  sessions: {
    list: (): Promise<SessionMeta[]> => ipcRenderer.invoke('sessions:list'),
    current: (): Promise<SessionMeta> => ipcRenderer.invoke('sessions:current'),
    create: (): Promise<SessionMeta> => ipcRenderer.invoke('sessions:create'),
    fork: (id?: string): Promise<SessionMeta> => ipcRenderer.invoke('sessions:fork', id),
    switch: (id: string): Promise<TranscriptItem[]> => ipcRenderer.invoke('sessions:switch', id),
    delete: (id: string): Promise<SessionMeta> => ipcRenderer.invoke('sessions:delete', id),
    rename: (id: string, title: string): Promise<SessionMeta> => ipcRenderer.invoke('sessions:rename', id, title),
    rewind: (turn: number): Promise<RewindResult> => ipcRenderer.invoke('sessions:rewind', turn),
  },
  skills: {
    list: (): Promise<SkillInfo[]> => ipcRenderer.invoke('skills:list'),
  },
  changes: {
    list: (): Promise<ChangeEntry[]> => ipcRenderer.invoke('changes:list'),
    diff: (p: string): Promise<ChangeDiff> => ipcRenderer.invoke('changes:diff', p),
    revert: (p: string): Promise<ChangeEntry[]> => ipcRenderer.invoke('changes:revert', p),
    openInEditor: (p: string): Promise<void> => ipcRenderer.invoke('changes:open', p),
  },
  plan: {
    respond: (id: string, decision: 'build-ask' | 'build-acceptEdits' | 'keep'): Promise<void> => ipcRenderer.invoke('plan:respond', id, decision),
  },
  terminal: {
    list: (): Promise<TerminalTabInfo[]> => ipcRenderer.invoke('terminal:list'),
    create: (cols: number, rows: number): Promise<TerminalTabInfo> => ipcRenderer.invoke('terminal:create', cols, rows),
    history: (id: string): Promise<string> => ipcRenderer.invoke('terminal:history', id),
    write: (id: string, data: string): void => ipcRenderer.send('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number): void => ipcRenderer.send('terminal:resize', id, cols, rows),
    close: (id: string): Promise<void> => ipcRenderer.invoke('terminal:close', id),
    onData: (cb: (id: string, data: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, id: string, data: string) => cb(id, data);
      ipcRenderer.on('terminal:data', handler);
      return () => ipcRenderer.removeListener('terminal:data', handler);
    },
    onTabs: (cb: (tabs: TerminalTabInfo[]) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, tabs: TerminalTabInfo[]) => cb(tabs);
      ipcRenderer.on('terminal:tabs', handler);
      return () => ipcRenderer.removeListener('terminal:tabs', handler);
    },
  },
  artifacts: {
    list: (): Promise<ArtifactInfo[]> => ipcRenderer.invoke('artifacts:list'),
    content: (id: string): Promise<string> => ipcRenderer.invoke('artifacts:content', id),
    open: (id: string): Promise<void> => ipcRenderer.invoke('artifacts:open', id),
    saveAs: (id: string): Promise<string | null> => ipcRenderer.invoke('artifacts:save-as', id),
    reveal: (id: string): Promise<void> => ipcRenderer.invoke('artifacts:reveal', id),
  },
  browser: {
    setBounds: (b: Bounds): void => ipcRenderer.send('browser:bounds', b),
    setVisible: (v: boolean): void => ipcRenderer.send('browser:visible', v),
    navigate: (url: string): Promise<string> => ipcRenderer.invoke('browser:navigate', url),
    back: (): Promise<string> => ipcRenderer.invoke('browser:back'),
    forward: (): Promise<string> => ipcRenderer.invoke('browser:forward'),
    reload: (): Promise<void> => ipcRenderer.invoke('browser:reload'),
    state: (): Promise<BrowserState> => ipcRenderer.invoke('browser:state'),
    onState: (cb: (s: BrowserState) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, s: BrowserState) => cb(s);
      ipcRenderer.on('browser:state', handler);
      return () => ipcRenderer.removeListener('browser:state', handler);
    },
    openExternal: (url?: string): Promise<void> => ipcRenderer.invoke('browser:open-external', url),
  },
};

contextBridge.exposeInMainWorld('oc', api);
