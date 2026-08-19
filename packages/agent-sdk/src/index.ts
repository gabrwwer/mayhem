
export interface AgentContext<T = Record<string, unknown>> {
  id: string;
  name: string;
  metadata: T;
  createdAt: string;
}

export interface AgentTask<T = Record<string, unknown>> {
  id: string;
  name: string;
  payload: T;
  createdAt: string;
}

export function createAgentContext<T>(name: string, metadata: T): AgentContext<T> {
  return {
    id: `agent-${Math.random().toString(36).slice(2, 10)}`,
    name,
    metadata,
    createdAt: new Date().toISOString(),
  };
}

export function createAgentTask<T>(name: string, payload: T): AgentTask<T> {
  return {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    name,
    payload,
    createdAt: new Date().toISOString(),
  };
}