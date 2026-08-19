
export interface NotificationOptions {
  level?: 'info' | 'warn' | 'error';
  source?: string;
  metadata?: Record<string, unknown>;
}

export function notify(message: string, options: NotificationOptions = {}): void {
  const payload = {
    level: options.level ?? 'info',
    source: options.source ?? 'mayhem',
    message,
    metadata: options.metadata ?? {},
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(payload));
}