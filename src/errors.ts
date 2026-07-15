export type DomainErrorCategory = 'validation' | 'safety' | 'not_found';
export type InfraErrorCategory =
  | 'validation'
  | 'authentication'
  | 'permission'
  | 'rate_limited'
  | 'network'
  | 'service_unavailable'
  | 'storage';

interface ErrorOptions {
  cause?: unknown;
  secrets?: string[];
}

export function redactSecrets(
  message: string,
  secrets: readonly string[] = [],
): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (redacted, secret) => redacted.split(secret).join('[REDACTED]'),
      message,
    );
}

export class DomainError extends Error {
  readonly name = 'DomainError';

  constructor(
    readonly category: DomainErrorCategory,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(redactSecrets(message, options.secrets), { cause: options.cause });
  }
}

export class InfraError extends Error {
  readonly name = 'InfraError';

  constructor(
    readonly category: InfraErrorCategory,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(redactSecrets(message, options.secrets), { cause: options.cause });
  }
}
