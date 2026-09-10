import {
  Component,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react';

export interface ErrorFallbackProps {
  error: Error;
  resetError: () => void;
  componentStack?: string;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  FallbackComponent?: ComponentType<ErrorFallbackProps>;
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string;
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  if (typeof value === 'string') {
    return new Error(value);
  }

  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

function DefaultFallback({
  error,
  resetError,
  componentStack,
}: ErrorFallbackProps) {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 p-6">
      <div className="max-w-2xl w-full">
        <div className="text-center">
          <h1 className="text-xl font-semibold text-gray-900">
            Something went wrong
          </h1>

          <p className="mt-2 text-sm text-gray-600">
            This part of the app hit an error. The rest of the app is still
            running.
          </p>
        </div>

        <div className="mt-5 rounded-lg bg-gray-100 p-4">
          <p className="mb-2 text-xs font-semibold text-gray-700">
            Error message
          </p>

          <pre className="overflow-x-auto whitespace-pre-wrap break-words text-left text-xs text-red-700">
            {error.message || String(error)}
          </pre>
        </div>

        {error.stack && (
          <div className="mt-3 rounded-lg bg-gray-100 p-4">
            <p className="mb-2 text-xs font-semibold text-gray-700">
              JavaScript stack
            </p>

            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-left text-[10px] leading-relaxed text-gray-700">
              {error.stack}
            </pre>
          </div>
        )}

        {componentStack && (
          <div className="mt-3 rounded-lg bg-gray-100 p-4">
            <p className="mb-2 text-xs font-semibold text-gray-700">
              React component stack
            </p>

            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-left text-[10px] leading-relaxed text-gray-700">
              {componentStack}
            </pre>
          </div>
        )}

        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={resetError}
            className="rounded bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    error: null,
    componentStack: '',
  };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      error: toError(error),
      componentStack: '',
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const normalizedError = toError(error);

    console.error(
      'ErrorBoundary caught an error:',
      normalizedError,
    );

    console.error(
      'Error stack:',
      normalizedError.stack,
    );

    console.error(
      'React component stack:',
      info.componentStack,
    );

    this.setState({
      error: normalizedError,
      componentStack: info.componentStack || '',
    });
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (
      this.state.error !== null &&
      prevProps.resetKey !== this.props.resetKey
    ) {
      this.resetError();
    }
  }

  resetError = (): void => {
    this.setState({
      error: null,
      componentStack: '',
    });
  };

  render(): ReactNode {
    const { error, componentStack } = this.state;

    if (error === null) {
      return this.props.children;
    }

    const Fallback = this.props.FallbackComponent ?? DefaultFallback;

    return (
      <Fallback
        error={error}
        resetError={this.resetError}
        componentStack={componentStack}
      />
    );
  }
}