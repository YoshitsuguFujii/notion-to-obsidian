import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { DomainError, InfraError } from '../errors.js';
import { fetchWithValidatedRedirects, type FetchLike } from './security.js';

export interface DownloadRequest {
  url: URL;
  destination: string;
  maximumBytes: number;
  allowedContentTypes?: readonly string[];
  allowedExtensions?: readonly string[];
}
export interface DownloadResult {
  size: number;
  contentHash: string;
  contentType?: string;
  etag?: string;
  lastModified?: string;
}
export interface HttpDownloader {
  download(request: DownloadRequest): Promise<DownloadResult>;
}

interface NodeHttpDownloaderOptions {
  fetch?: FetchLike;
  validateUrl?: (url: URL) => Promise<void>;
  timeoutMilliseconds?: number;
  maximumRedirects?: number;
  temporaryId?: () => string;
  openFile?: (path: string) => Promise<AssetTemporaryFile>;
}

interface AssetTemporaryFile {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
  ): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
}

function optionalHeader(headers: Headers, name: string): string | undefined {
  return headers.get(name) ?? undefined;
}

function maximumSizeError(): DomainError {
  return new DomainError('validation', 'Asset exceeds the maximum size');
}

function normalizedContentType(value: string): string {
  return (value.split(';')[0] ?? '').trim().toLowerCase();
}

function validateExtension(request: DownloadRequest): void {
  if (!request.allowedExtensions) return;
  const extension = extname(request.destination).toLowerCase();
  const allowed = request.allowedExtensions.map((value) => value.toLowerCase());
  if (!allowed.includes(extension)) {
    throw new DomainError('validation', 'Asset extension is not allowed');
  }
}

function validateContentType(
  headers: Headers,
  allowedContentTypes: readonly string[] | undefined,
): void {
  if (!allowedContentTypes) return;
  const contentType = normalizedContentType(headers.get('content-type') ?? '');
  const allowed = allowedContentTypes.map(normalizedContentType);
  if (!contentType || !allowed.includes(contentType)) {
    throw new DomainError('validation', 'Asset Content-Type is not allowed');
  }
}

function networkError(message: string, cause: unknown): InfraError {
  return new InfraError('network', message, { cause });
}

function storageError(message: string, cause: unknown): InfraError {
  return new InfraError('storage', message, { cause });
}

export class NodeHttpDownloader implements HttpDownloader {
  readonly #options: NodeHttpDownloaderOptions;

  constructor(options: NodeHttpDownloaderOptions = {}) {
    this.#options = options;
  }

  async download(request: DownloadRequest): Promise<DownloadResult> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#options.timeoutMilliseconds ?? 30_000,
    );
    const directory = dirname(request.destination);
    const temporaryPath = join(
      directory,
      `.${basename(request.destination)}.${(this.#options.temporaryId ?? randomUUID)()}.tmp`,
    );

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      validateExtension(request);
      let response: Response;
      try {
        response = await fetchWithValidatedRedirects(request.url, {
          ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
          ...(this.#options.validateUrl
            ? { validateUrl: this.#options.validateUrl }
            : {}),
          ...(this.#options.maximumRedirects === undefined
            ? {}
            : { maximumRedirects: this.#options.maximumRedirects }),
          signal: controller.signal,
        });
      } catch (cause) {
        if (cause instanceof DomainError || cause instanceof InfraError)
          throw cause;
        throw networkError('Asset request failed', cause);
      }
      if (!response.ok) {
        throw new InfraError(
          'network',
          `Asset download failed with HTTP ${response.status}`,
        );
      }
      validateContentType(response.headers, request.allowedContentTypes);

      const declaredLength = Number(response.headers.get('content-length'));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > request.maximumBytes
      ) {
        await response.body?.cancel();
        throw maximumSizeError();
      }
      if (!response.body) {
        throw new InfraError(
          'network',
          'Asset response did not contain a body',
        );
      }

      try {
        await mkdir(directory, { recursive: true });
      } catch (cause) {
        throw storageError(
          'Asset temporary directory could not be created',
          cause,
        );
      }
      let file: AssetTemporaryFile;
      try {
        if (this.#options.openFile) {
          file = await this.#options.openFile(temporaryPath);
        } else {
          const handle = await open(temporaryPath, 'wx');
          file = {
            write: (buffer, offset, length) =>
              handle.write(buffer, offset, length),
            close: () => handle.close(),
          };
        }
      } catch (cause) {
        throw storageError('Asset temporary file could not be opened', cause);
      }
      let size = 0;
      const contentHash = createHash('sha256');
      let primaryError: unknown;
      let closeError: InfraError | undefined;
      try {
        reader = response.body.getReader();
        for (;;) {
          let read;
          try {
            read = await reader.read();
          } catch (cause) {
            throw networkError(
              'Asset response stream could not be read',
              cause,
            );
          }
          const { done, value } = read;
          if (done) break;
          size += value.byteLength;
          if (size > request.maximumBytes) {
            await reader.cancel();
            throw maximumSizeError();
          }
          let offset = 0;
          while (offset < value.byteLength) {
            let bytesWritten: number;
            try {
              ({ bytesWritten } = await file.write(
                value,
                offset,
                value.byteLength - offset,
              ));
            } catch (cause) {
              throw storageError(
                'Asset temporary file could not be written',
                cause,
              );
            }
            if (bytesWritten <= 0) {
              throw new InfraError(
                'storage',
                'Asset temporary file write did not make progress',
              );
            }
            offset += bytesWritten;
          }
          contentHash.update(value);
        }
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        if (primaryError) {
          try {
            await reader?.cancel();
          } catch {
            // Cleanup is best effort so the original phase error remains primary.
          }
        }
        try {
          await file.close();
        } catch (cause) {
          if (!primaryError)
            closeError = storageError(
              'Asset temporary file could not be closed',
              cause,
            );
        }
      }
      if (closeError) throw closeError;

      try {
        await rename(temporaryPath, request.destination);
      } catch (cause) {
        throw storageError(
          'Asset temporary file could not be finalized',
          cause,
        );
      }
      const contentType = optionalHeader(response.headers, 'content-type');
      const etag = optionalHeader(response.headers, 'etag');
      const lastModified = optionalHeader(response.headers, 'last-modified');
      return {
        size,
        contentHash: contentHash.digest('hex'),
        ...(contentType ? { contentType } : {}),
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      };
    } catch (cause) {
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        // Cleanup is best effort so the original phase error remains primary.
      }
      if (controller.signal.aborted) {
        throw new InfraError('network', 'Asset download timed out', { cause });
      }
      throw cause;
    } finally {
      clearTimeout(timeout);
    }
  }
}
