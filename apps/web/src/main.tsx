import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { NetworkError } from './lib/api';
import { AuthProvider } from './lib/auth';
import { startConnectivity } from './lib/connectivity';
import { startSync } from './lib/sync';
import './index.css';

// Reachability heartbeat and the sale-queue drainer are app-lifetime concerns,
// not component ones: a queue left over from the last shift has to go up even
// if nobody navigates to the POS screen this morning (ADR-006).
startConnectivity();
startSync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Offline, a retry is a guaranteed wait for a guaranteed failure: the
      // cache has already answered or already said it cannot.
      retry: (count, err) => !(err instanceof NetworkError) && count < 1,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
