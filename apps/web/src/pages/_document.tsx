import { Head, Html, Main, NextScript } from 'next/document';

/**
 * The inline script applies the stored theme before first paint.
 *
 * Without it the page renders in the default palette and then snaps to the
 * chosen one — a visible flash on every navigation. It has to be blocking and
 * inline for that reason; `dangerouslySetInnerHTML` is the only way to emit it,
 * and the content is a fixed literal with no interpolation.
 */
const THEME_SCRIPT = `
(function () {
  try {
    var t = localStorage.getItem('handoff.theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) {}
})();
`;

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
