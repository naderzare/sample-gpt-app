export interface Account { id: string; label: string; email: string; connected: boolean; sharing: boolean }
export interface Session { accounts: Account[]; activeId?: string; welcome: boolean }
export interface Model { slug: string; display_name: string }
export interface Message { role: 'user' | 'assistant'; content: string }
export interface Ask { id: string; model: string; messages: Message[] }
export type StreamEvent = { id: string; type: 'delta'; text: string } | { id: string; type: 'completed' | 'cancelled' } | { id: string; type: 'error'; message: string };
export interface DesktopAPI {
  session(): Promise<Session>;
  login(accountId?: string, requestConsent?: boolean): Promise<Session>;
  cancelLogin(): Promise<void>;
  select(id: string): Promise<Session>;
  logout(): Promise<{ session: Session; warning?: string }>;
  acknowledgeWelcome(): Promise<void>;
  models(): Promise<Model[]>;
  ask(request: Ask): Promise<void>;
  cancel(): Promise<void>;
  openUsage(): Promise<void>;
  onStream(callback: (event: StreamEvent) => void): () => void;
}
