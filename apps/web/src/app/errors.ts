import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { type ApiError, isApiError } from './api/client.ts';

// App-wide reactions to api errors, whatever made the request (queries, mutations, the SSE
// stream): an expired session goes back to sign-in, `two_factor_required` goes to the account
// page. The router installs the handler (app/router.tsx); forms still show their own errors.

type ApiErrorHandler = (error: ApiError) => void;
let handler: ApiErrorHandler = () => {};

export function setApiErrorHandler(next: ApiErrorHandler) {
  handler = next;
}

export function reportApiError(error: unknown) {
  if (isApiError(error)) handler(error);
}

/** Errors the app handles globally, as opposed to ones a page shows inline. */
export function isGlobalApiError(error: unknown): boolean {
  return (
    isApiError(error) &&
    ((error.status === 401 && error.code === 'unauthenticated') ||
      error.code === 'two_factor_required')
  );
}

export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: reportApiError }),
    mutationCache: new MutationCache({ onError: reportApiError }),
    defaultOptions: {
      queries: {
        // 4xx won't fix themselves.
        retry: (count, error) =>
          !(isApiError(error) && error.status >= 400 && error.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
}
