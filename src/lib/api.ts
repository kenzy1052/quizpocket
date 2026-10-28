export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let currentAccessToken: string | null = null;
let onUnauthorizedCallback: (() => void) | null = null;

export function setApiAccessToken(token: string | null): void {
  currentAccessToken = token;
}

export function setOnUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorizedCallback = handler;
}

export async function apiRequest<T>(
  endpoint: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    skipAuthRedirect?: boolean;
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (currentAccessToken) {
    headers.Authorization = `Bearer ${currentAccessToken}`;
  }

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`/api${endpoint}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const payload = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: {
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
    };
  };

  if (!response.ok) {
    const code = payload.error?.code ?? 'REQUEST_FAILED';
    const message = payload.error?.message ?? 'Unable to complete the request.';

    if (response.status === 401 && !options.skipAuthRedirect && onUnauthorizedCallback) {
      onUnauthorizedCallback();
    }

    throw new ApiClientError(response.status, code, message, payload.error?.details);
  }

  return payload.data as T;
}

export async function downloadExamResultsCsv(examId: string, examTitle: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (currentAccessToken) {
    headers.Authorization = `Bearer ${currentAccessToken}`;
  }

  const response = await fetch(`/api/admin/exams/${examId}/export.csv`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const errPayload = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    if (response.status === 401 && onUnauthorizedCallback) {
      onUnauthorizedCallback();
    }
    throw new ApiClientError(
      response.status,
      errPayload.error?.code ?? 'EXPORT_FAILED',
      errPayload.error?.message ?? 'Unable to export examination results.'
    );
  }

  const blob = await response.blob();
  const safeSlug = examTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `${safeSlug || 'quizpocket'}-results.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
}
