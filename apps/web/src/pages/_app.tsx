import type { AppProps } from 'next/app';
import Head from 'next/head';
import { ToastProvider } from '@/components/Toast';
import '@/styles/globals.css';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Tells the browser to render form controls and scrollbars per theme. */}
        <meta name="color-scheme" content="light dark" />
        <title>Handoff</title>
      </Head>
      <ToastProvider>
        <Component {...pageProps} />
      </ToastProvider>
    </>
  );
}
