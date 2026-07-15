import { randomUUID } from 'node:crypto';
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

    try {
      validateExtension(request);
      const response = await fetchWithValidatedRedirects(request.url, {
        ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
        ...(this.#options.validateUrl
          ? { validateUrl: this.#options.validateUrl }
          : {}),
        ...(this.#options.maximumRedirects === undefined
          ? {}
          : { maximumRedirects: this.#options.maximumRedirects }),
        signal: controller.signal,
      });
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

      await mkdir(directory, { recursive: true });
      const file = await open(temporaryPath, 'wx');
      let size = 0;
      try {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > request.maximumBytes) {
            await reader.cancel();
            throw maximumSizeError();
          }
          await file.write(value);
        }
      } finally {
        await file.close();
      }

      await rename(temporaryPath, request.destination);
      const contentType = optionalHeader(response.headers, 'content-type');
      const etag = optionalHeader(response.headers, 'etag');
      const lastModified = optionalHeader(response.headers, 'last-modified');
      return {
        size,
        ...(contentType ? { contentType } : {}),
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      };
    } catch (cause) {
      await rm(temporaryPath, { force: true });
      if (controller.signal.aborted) {
        throw new InfraError('network', 'Asset download timed out', { cause });
      }
      throw cause;
    } finally {
      clearTimeout(timeout);
    }
  }
}
