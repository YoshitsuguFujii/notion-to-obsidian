import { redactSecrets } from '../errors.js';

export type LogContext = Partial<{
  run_id: string;
  resource_id: string;
  action: string;
  local_path: string;
  duration: number;
  retry: number;
  warning_type: string;
  error_category: string;
}> &
  Record<string, unknown>;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerOptions {
  format: 'pretty' | 'json';
  level?: LogLevel;
  token?: string;
  write?: (line: string) => void;
}

function sanitize(value: unknown, token?: string, key = ''): unknown {
  if (/authorization|token/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    const withoutSecret = redactSecrets(value, token ? [token] : []);
    try {
      const url = new URL(withoutSecret);
      if (url.search) url.search = '?[REDACTED]';
      return url.toString();
    } catch {
      return withoutSecret;
    }
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, token));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        sanitize(child, token, childKey),
      ]),
    );
  }
  return value;
}

export function createLogger(options: LoggerOptions) {
  const priorities: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };
  const threshold = priorities[options.level ?? 'info'];
  const write =
    options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const emit = (level: LogLevel, message: string, context: LogContext = {}) => {
    if (priorities[level] < threshold) return;
    const entry = sanitize(
      { level, message, ...context },
      options.token,
    ) as Record<string, unknown>;
    write(
      options.format === 'json'
        ? JSON.stringify(entry)
        : `${level.toUpperCase()} ${entry.message as string}`,
    );
  };
  return {
    debug: (message: string, context?: LogContext) =>
      emit('debug', message, context),
    info: (message: string, context?: LogContext) =>
      emit('info', message, context),
    warn: (message: string, context?: LogContext) =>
      emit('warn', message, context),
    error: (message: string, context?: LogContext) =>
      emit('error', message, context),
  };
}
