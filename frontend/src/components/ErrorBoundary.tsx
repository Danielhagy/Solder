import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Error boundary caught:', error, info);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      const message = this.state.error?.message ?? 'An unknown error occurred.';

      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-surface-50 dark:bg-surface-950">
          <div className="card p-8 max-w-lg w-full">
            <h1 className="text-xl font-semibold text-surface-900 mb-2 dark:text-surface-50">
              Something went wrong
            </h1>
            <p className="text-sm text-surface-600 mb-4 dark:text-surface-300">
              The application hit an unexpected error. You can try again, or reload the page.
            </p>
            <pre className="font-mono text-xs bg-surface-100 text-surface-800 rounded-lg p-3 mb-6 overflow-hidden whitespace-pre-wrap break-words max-h-40 truncate dark:bg-surface-800 dark:text-surface-200">
              {message}
            </pre>
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-primary" onClick={this.handleReset}>
                Try again
              </button>
              <button type="button" className="btn btn-ghost text-sm" onClick={this.handleReload}>
                Reload page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
